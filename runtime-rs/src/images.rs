mod admission;
mod catalog;
mod composition;
mod http;
mod inputs;
mod manga;
pub(crate) mod media_import;
mod native;
mod native_adapters;
mod native_upscale;
pub(crate) mod remote;
mod requests;
mod resources;
mod resume;
pub(crate) mod upload_body;
mod validation;
mod workflow;

use crate::{
    error::{ApiError, Result},
    execution::{ExecutionHooks, Observation, Output},
    generation::{self, ComfyPlan},
    image_decode as decode,
    upstream::LocalUpstream,
};
pub use admission::Limits;
pub(crate) use admission::read_media;
pub(crate) use admission::{Kind as ImageKind, owner_matches_for, store_for, store_media_for};
pub use catalog::catalog;
pub use generation::Config;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
pub use validation::validate;
pub use workflow::build as build_workflow;

// Each image service owns its upload admission budget.

pub struct Prepared {
    backend: PreparedBackend,
    originals: Vec<inputs::Original>,
}
enum PreparedBackend {
    Local(generation::Prepared),
    Remote {
        input: Value,
        raw: Value,
        family: String,
        cancel: CancellationToken,
        _permit: tokio::sync::OwnedSemaphorePermit,
    },
}
impl Prepared {
    pub(crate) fn uses_native_queue(&self) -> bool {
        matches!(&self.backend, PreparedBackend::Local(generation) if generation.provider() == "native")
    }
    pub(crate) fn input(&self) -> &Value {
        match &self.backend {
            PreparedBackend::Local(value) => &value.input,
            PreparedBackend::Remote { input, .. } => input,
        }
    }
    pub(crate) fn provider(&self) -> &str {
        match &self.backend {
            PreparedBackend::Local(value) => value.provider(),
            PreparedBackend::Remote { .. } => "native",
        }
    }
}
pub struct Service {
    // Credentials of this runtime's bound listener (saved settings can change before restart).
    agent_cli_endpoint: std::sync::OnceLock<(u16, String)>,
    backend: Arc<generation::Service>,
    native: bool,
    native_status: native::StatusCache,
    remote: Option<remote::Client>,
    config: Config,
    shutdown: CancellationToken,
    uploads: TaskTracker,
    limits: Limits,
    requests: requests::Requests,
}
pub type ImageService = Service;
impl Drop for Service {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}
impl Service {
    pub(crate) fn native_engine(&self) -> Arc<generation::native::Engine> {
        self.backend.native_engine()
    }
    pub(crate) fn native_gpu_owned(&self) -> bool {
        self.backend
            .native_engine()
            .gpu_owned
            .load(std::sync::atomic::Ordering::SeqCst)
    }
    pub(crate) fn bind_control(&self, control: &Arc<crate::control::ControlService>) {
        self.backend.bind_control(control);
    }
    pub(crate) async fn native_chat_handoff(
        &self,
    ) -> Result<Option<tokio::sync::OwnedSemaphorePermit>> {
        self.backend.native_chat_handoff().await
    }
    pub(crate) fn provider_identity(&self, unbound_epoch: &str) -> Value {
        if let Some(remote) = &self.remote {
            return remote.identity();
        }
        self.backend.provider_identity(unbound_epoch)
    }
    pub(crate) fn is_remote(&self) -> bool {
        self.remote.is_some()
    }
    pub(crate) fn is_local_native(&self) -> bool {
        self.backend.native_enabled()
    }
    fn check_keyframe_engine(&self, family: &str) -> Result<()> {
        if family == "keyframe" && !self.is_local_native() {
            return Err(ApiError::new(409, "NATIVE_ENGINE_REQUIRED", "关键帧工坊使用本机 GPU，请在控制室选择本机原生绘图并重启"));
        }
        Ok(())
    }
    pub fn new(
        config: Config,
        transport: LocalUpstream,
        shutdown: CancellationToken,
    ) -> Result<Self> {
        let limits = Limits::from_environment();
        let shutdown = shutdown.child_token();
        let backend = Arc::new(generation::Service::for_images(
            config.clone(),
            transport,
            shutdown.clone(),
        )?);
        let settings = backend.native_settings()?;
        let native = backend.native_enabled() || settings.engine == "remote";
        let remote = if settings.engine == "remote" {
            Some(remote::Client::new(&settings)?)
        } else {
            None
        };
        let requests = requests::Requests::new(
            config.runtime_root.join("jobs/image-requests"),
            "IMAGE",
            "图片",
        );
        Ok(Self {
            agent_cli_endpoint: Default::default(),
            backend,
            native,
            native_status: Default::default(),
            remote,
            config,
            shutdown,
            uploads: TaskTracker::new(),
            limits,
            requests,
        })
    }
    pub async fn prepare(
        &self,
        raw: Value,
        family: &str,
        direct_local: bool,
        cancel: CancellationToken,
    ) -> Result<Prepared> {
        self.prepare_owned(raw, family, direct_local, None, cancel)
            .await
    }
    async fn prepare_owned(
        &self,
        raw: Value,
        family: &str,
        direct_local: bool,
        owner: Option<&str>,
        cancel: CancellationToken,
    ) -> Result<Prepared> {
        if self.shutdown.is_cancelled() {
            return Err(closed());
        }
        self.check_keyframe_engine(family)?;
        let input = if family == "manga-screen" {
            if !self.native {
                return Err(ApiError::new(
                    409,
                    "NATIVE_ENGINE_REQUIRED",
                    "漫画处理仅接入原生后端，请显式切换后重启",
                ));
            }
            manga::validate(&raw)?
        } else if generation::native::adapters::model(raw["modelId"].as_str().unwrap_or(""))
            .is_some()
        {
            if !self.native {
                return Err(ApiError::new(
                    409,
                    "NATIVE_ENGINE_REQUIRED",
                    "该模型仅接入原生引擎，请显式切换后重启；不会回退 ComfyUI",
                ));
            }
            native_adapters::validate(&raw, family)?
        } else {
            validate(&raw, family)?
        };
        if family == "krea2"
            && ["initImage", "maskImage", "maskPrompt"]
                .iter()
                .any(|k| generation::truthy(&input[*k]))
        {
            return Err(ApiError::new(
                501,
                "KREA_EDIT_NOT_SUPPORTED",
                "当前本地 Krea 2 工作流未接入图像编辑或遮罩",
            ));
        }
        let (prepared, originals) = if self.native {
            let input = native::normalize(&raw, input)?;
            if let Some(remote) = &self.remote {
                remote::Client::check_family(family)?;
                let permit = remote.reserve(&cancel)?;
                let originals =
                    inputs::capture(&self.config, &input, direct_local, owner, &cancel).await?;
                return Ok(Prepared {
                    backend: PreparedBackend::Remote {
                        input,
                        raw,
                        family: family.into(),
                        cancel,
                        _permit: permit,
                    },
                    originals,
                });
            }
            // Admission covers original-image buffers and model preparation,
            // not only jobs already queued for the resident worker.
            let permit = self.backend.reserve_native(&cancel)?;
            let originals =
                inputs::capture(&self.config, &input, direct_local, owner, &cancel).await?;
            let plan = native::plan(&self.backend.native_settings()?, input, &originals).await?;
            let prepared = self.backend.prepare_native(plan, permit, &cancel)?;
            (prepared, originals)
        } else {
            drop(raw);
            let plan = resources::plan(&self.config, input).await?;
            let prepared = self.backend.prepare_comfy(plan, cancel.clone()).await?;
            let originals =
                inputs::capture(&self.config, &prepared.input, direct_local, owner, &cancel)
                    .await?;
            (prepared, originals)
        };
        Ok(Prepared {
            backend: PreparedBackend::Local(prepared),
            originals,
        })
    }
    pub async fn submit(
        self: Arc<Self>,
        prepared: Prepared,
        owner: String,
        hooks: Option<Arc<dyn ExecutionHooks>>,
    ) -> Result<Value> {
        if self.shutdown.is_cancelled() {
            return Err(closed());
        }
        inputs::protect_and_restore(
            &self.config,
            &prepared.originals,
            hooks.as_deref(),
            &self.shutdown,
        )
        .await?;
        self.submit_protected(prepared, owner, hooks).await
    }
    async fn submit_protected(
        self: Arc<Self>,
        prepared: Prepared,
        owner: String,
        hooks: Option<Arc<dyn ExecutionHooks>>,
    ) -> Result<Value> {
        match prepared.backend {
            PreparedBackend::Local(backend) => {
                self.backend.clone().submit(backend, owner, hooks).await
            }
            PreparedBackend::Remote {
                input,
                raw,
                family,
                cancel,
                _permit,
            } => {
                let remote = self.remote.as_ref().ok_or_else(closed)?;
                tokio::select! {
                    biased;
                    _ = self.shutdown.cancelled() => Err(closed()),
                    result = remote.submit(raw, &input, &family, &prepared.originals, &owner, hooks.as_deref(), &cancel) => result,
                }
            }
        }
    }
    pub async fn get_status(&self, family: &str) -> Result<Value> {
        self.check_keyframe_engine(family)?;
        if let Some(remote) = &self.remote {
            return remote.status(family, &self.shutdown).await;
        }
        if matches!(family, "qwen-image" | "keyframe" | "moss-image" | "manga-screen") && !self.native {
            return Err(ApiError::new(
                409,
                "NATIVE_ENGINE_REQUIRED",
                "该入口仅接入原生引擎，请显式切换后重启",
            ));
        }
        if family == "manga-screen" {
            return manga::status(&self.backend).await;
        }
        if self.native {
            let cancel = self.shutdown.child_token();
            let _guard = cancel.clone().drop_guard();
            // /creative/status is the shared Anima/Krea catalog, as on Comfy.
            // Creation and result routes retain their strict family checks.
            native::status(
                &self.backend,
                &self.native_status,
                if family == "krea2" { "" } else { family },
                cancel,
            )
            .await
        } else {
            resources::status(&self.config, &self.backend, family).await
        }
    }
    pub async fn get_job(&self, id: &str, owner: &str, family: &str) -> Result<Value> {
        if let Some(remote) = &self.remote {
            return remote.job(id, owner, family, &self.shutdown).await;
        }
        self.backend.image_job(id, owner, family).await
    }
    pub async fn query(&self, id: &str, owner: &str, family: &str) -> Result<Observation> {
        self.query_with_receipt(id, owner, family, None).await
    }
    pub(crate) async fn query_with_receipt(
        &self,
        id: &str,
        owner: &str,
        family: &str,
        completed: Option<Value>,
    ) -> Result<Observation> {
        if let Some(remote) = &self.remote {
            return remote
                .observe(id, owner, family, completed, &self.shutdown)
                .await;
        }
        self.backend.family_allowed(id, owner, family).await?;
        self.backend.query(id, owner).await
    }
    pub(crate) async fn wait_remote_completion(
        &self,
        id: &str,
        owner: &str,
        family: &str,
    ) -> Option<remote::Completion> {
        let remote = self.remote.as_ref()?;
        remote
            .wait_for_completion(id, owner, family, &self.shutdown)
            .await
    }
    pub async fn result(&self, id: &str, owner: &str, family: &str) -> Result<Output> {
        if let Some(remote) = &self.remote {
            return remote.result(id, owner, family, &self.shutdown).await;
        }
        self.backend.image_result(id, owner, family).await
    }
    pub async fn cancel(&self, id: &str, owner: &str, family: &str) -> Result<Value> {
        if let Some(remote) = &self.remote {
            return remote.cancel(id, owner, family, &self.shutdown).await;
        }
        match self.backend.family_allowed(id, owner, family).await {
            Ok(()) => self.backend.cancel(id, owner).await,
            Err(error) if matches!(error.status.as_u16(), 404 | 410) => {
                self.backend.image_job(id, owner, family).await
            }
            Err(error) => Err(error),
        }
    }
    async fn lineart_result(&self, id: &str, owner: &str, output: Output) -> Result<Output> {
        let job = self.get_job(id, owner, "manga-screen").await?;
        if job["status"] != "succeeded" || !job["metadata"]["lineartResult"].is_object() {
            return Err(ApiError::new(
                404,
                "LINEART_NOT_FOUND",
                "本次任务没有可读取的独立线稿",
            ));
        }
        let Output::File { path, .. } = output else {
            return Err(ApiError::new(404, "LINEART_NOT_FOUND", "线稿不存在"));
        };
        let path = generation::native::manga::lineart_path(&path, &job["metadata"]);
        let stat = tokio::fs::symlink_metadata(&path)
            .await
            .map_err(|_| ApiError::new(404, "LINEART_NOT_FOUND", "线稿已过期或不存在"))?;
        if !stat.is_file() || stat.file_type().is_symlink() {
            return Err(ApiError::new(404, "LINEART_NOT_FOUND", "线稿不存在"));
        }
        Ok(Output::File {
            path,
            mime: "image/png".into(),
            bytes: stat.len(),
        })
    }
    async fn upload(
        &self,
        image: axum::body::Bytes,
        owner: String,
        cancel: CancellationToken,
        admission: tokio::sync::OwnedSemaphorePermit,
        reuse: Option<Arc<remote::UploadIndex>>,
    ) -> Result<String> {
        if self.shutdown.is_cancelled() {
            return Err(closed());
        }
        let scope = self.shutdown.child_token();
        let guard = scope.clone().drop_guard();
        let (root, limits) = (inputs::root(&self.config, self.native), self.limits);
        let (reply, result) = tokio::sync::oneshot::channel();
        self.uploads.spawn(async move {
            let _admission = admission;
            let record = reuse.map(|index| (index, image.clone(), owner.clone()));
            let value = admission::store(root, image, owner, limits, scope.clone()).await;
            if let (Some((index, bytes, owner)), Ok(name)) = (record, &value) {
                index.remember(owner, name.clone(), bytes, scope).await;
            }
            let _ = reply.send(value);
        });
        let value = tokio::select! {value=result=>value.map_err(|_|ApiError::new(503,"IMAGE_SAVE_FAILED","素材写入结果未知"))?,_=cancel.cancelled()=>Err(inputs::cancelled())};
        drop(guard);
        value
    }
    pub async fn close(&self) {
        self.shutdown.cancel();
        // An intent write may still be transferring work to the tracker.
        self.requests.wait_for_acceptance().await;
        self.uploads.close();
        self.uploads.wait().await;
        self.backend.close().await;
    }
}
pub fn router(service: Arc<Service>) -> axum::Router<crate::AppState> {
    http::router(service)
}
fn error(code: &str, message: impl Into<String>) -> ApiError {
    ApiError::new(400, code, message)
}
fn closed() -> ApiError {
    ApiError::new(503, "SERVICE_CLOSED", "生成服务已关闭")
}
