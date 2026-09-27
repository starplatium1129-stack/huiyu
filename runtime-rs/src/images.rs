mod admission;
mod catalog;
mod decode;
mod http;
mod inputs;
mod resources;
mod resume;
mod validation;
mod workflow;

use crate::{
    error::{ApiError, Result},
    generation::{self, ComfyPlan, ExecutionHooks, Observation, Output},
    upstream::LocalUpstream,
};
pub use admission::Limits;
pub(crate) use admission::{Kind as ImageKind, owner_matches_for, store_for};
pub use catalog::catalog;
pub(crate) use decode::sniff;
pub use generation::Config;
use serde_json::{Value, json};
use std::{path::PathBuf, sync::Arc};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
pub use validation::validate;
pub use workflow::build as build_workflow;

pub struct Prepared {
    pub input: Value,
    pub provider: String,
    backend: generation::Prepared,
    originals: Vec<inputs::Original>,
}
pub struct Service {
    backend: Arc<generation::Service>,
    config: Config,
    shutdown: CancellationToken,
    uploads: TaskTracker,
    limits: Limits,
}
pub type ImageService = Service;
impl Drop for Service {
    fn drop(&mut self) {
        self.shutdown.cancel();
    }
}
impl Service {
    pub fn new(
        config: Config,
        transport: LocalUpstream,
        shutdown: CancellationToken,
    ) -> Result<Self> {
        Self::with_limits(config, transport, shutdown, Limits::from_environment())
    }
    pub fn with_limits(
        config: Config,
        transport: LocalUpstream,
        shutdown: CancellationToken,
        limits: Limits,
    ) -> Result<Self> {
        let shutdown = shutdown.child_token();
        let backend = Arc::new(generation::Service::for_images(
            config.clone(),
            transport,
            shutdown.clone(),
        )?);
        Ok(Self {
            backend,
            config,
            shutdown,
            uploads: TaskTracker::new(),
            limits,
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
        let input = validate(&raw, family, direct_local)?;
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
        let plan = resources::plan(&self.config, input).await?;
        let prepared = self.backend.prepare_comfy(plan, cancel.clone()).await?;
        let originals =
            inputs::capture(&self.config, &prepared.input, direct_local, owner, &cancel).await?;
        Ok(Prepared {
            input: prepared.input.clone(),
            provider: prepared.provider.clone(),
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
        resources::status(&self.config, &self.backend, family).await
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
    pub async fn upload(
        &self,
        image: String,
        owner: String,
        cancel: CancellationToken,
    ) -> Result<String> {
        if self.shutdown.is_cancelled() {
            return Err(closed());
        }
        let scope = self.shutdown.child_token();
        let guard = inputs::CancelOnDrop(scope.clone());
        let (root, limits) = (
            self.config.ai_workspace_root.join("ComfyUI/input"),
            self.limits,
        );
        let (reply, result) = tokio::sync::oneshot::channel();
        self.uploads.spawn(async move {
            let value = admission::store(root, image, owner, limits, scope).await;
            let _ = reply.send(value);
        });
        let value = tokio::select! {value=result=>value.map_err(|_|ApiError::new(503,"IMAGE_SAVE_FAILED","素材写入结果未知"))?,_=cancel.cancelled()=>Err(inputs::cancelled())};
        drop(guard);
        value
    }
    pub async fn close(&self) {
        self.shutdown.cancel();
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
