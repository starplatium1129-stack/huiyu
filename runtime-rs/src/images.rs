mod admission;
mod catalog;
mod composition;
mod http;
mod inputs;
mod manga;
pub(crate) mod media_import;
mod native;
mod native_adapters;
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
pub(crate) use decode::sniff;
pub use generation::Config;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
pub use validation::validate;
pub use workflow::build as build_workflow;

// Each image service owns its upload admission budget.

pub struct Prepared {
    backend: generation::Prepared,
    originals: Vec<inputs::Original>,
}
impl Prepared {
    pub(crate) fn input(&self) -> &Value {
        &self.backend.input
    }
    pub(crate) fn provider(&self) -> &str {
        &self.backend.provider
    }
}
pub struct Service {
    backend: Arc<generation::Service>,
    native: bool,
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
        self.backend.provider_identity(unbound_epoch)
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
        let native = backend.native_enabled();
        let requests = requests::Requests::new(
            config.runtime_root.join("jobs/image-requests"),
            "IMAGE",
            "图片",
        );
        Ok(Self {
            backend,
            native,
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
            drop(raw);
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
            backend: prepared,
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
        self.backend
            .clone()
            .submit(prepared.backend, owner, hooks)
            .await
    }
    pub async fn get_status(&self, family: &str) -> Result<Value> {
        if matches!(family, "qwen-image" | "moss-image" | "manga-screen") && !self.native {
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
                if family == "krea2" { "" } else { family },
                cancel,
            )
            .await
        } else {
            resources::status(&self.config, &self.backend, family).await
        }
    }
    pub async fn get_job(&self, id: &str, owner: &str, family: &str) -> Result<Value> {
        self.backend.family_allowed(id, owner, family).await?;
        self.backend.get_job(id, owner).await
    }
    pub async fn query(&self, id: &str, owner: &str, family: &str) -> Result<Observation> {
        self.backend.family_allowed(id, owner, family).await?;
        self.backend.query(id, owner).await
    }
    pub async fn result(&self, id: &str, owner: &str, family: &str) -> Result<Output> {
        self.backend.family_allowed(id, owner, family).await?;
        let job = self.backend.get_job(id, owner).await?;
        if job["status"] != "succeeded" {
            return Err(ApiError::new(
                if job["status"] == "failed" { 502 } else { 409 },
                job["code"].as_str().unwrap_or("RESULT_NOT_READY"),
                job["error"].as_str().unwrap_or("结果尚未就绪"),
            ));
        }
        self.backend.result(id, owner).await
    }
    pub async fn cancel(&self, id: &str, owner: &str, family: &str) -> Result<Value> {
        self.backend.family_allowed(id, owner, family).await?;
        self.backend.cancel(id, owner).await
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
    pub(crate) async fn upload(
        &self,
        image: axum::body::Bytes,
        owner: String,
        cancel: CancellationToken,
        admission: tokio::sync::OwnedSemaphorePermit,
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
            let value = admission::store(root, image, owner, limits, scope).await;
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
