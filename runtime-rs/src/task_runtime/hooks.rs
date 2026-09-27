use super::*;
use crate::generation::{ExecutionHooks, Output};
use futures_util::future::BoxFuture;
use std::sync::Weak;

pub(super) struct Hooks {
    pub runtime: Weak<TaskRuntime>,
    pub storage: Storage,
    pub principal: String,
    pub id: String,
}
impl ExecutionHooks for Hooks {
    fn checkpoint(&self, value: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let mut change = json!({"checkpoint":value});
            if value["effectiveInput"].is_object() {
                change["input"] = value["effectiveInput"].clone();
            }
            patch(&self.storage, &self.principal, &self.id, change).await?;
            if let (Some(runtime), Some(job)) =
                (self.runtime.upgrade(), value["gatewayJobId"].as_str())
            {
                runtime.register_job(&self.storage, &self.id, job.into());
            }
            Ok(())
        })
    }
    fn submitting(&self, provider: String, _fingerprint: String) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            let runtime = self.runtime.upgrade().ok_or_else(|| {
                ApiError::new(503, "TASK_RUNTIME_CLOSED", "Task runtime unavailable")
            })?;
            runtime.check_running()?;
            let current = TaskRuntime::get(&self.storage, &self.principal, &self.id).await?;
            if current["cancelRequestedAt"].is_number() {
                return Err(ApiError::new(499, "CANCELLED", "Task was cancelled"));
            }
            patch(&self.storage,&self.principal,&self.id,json!({"status":"submitting","recoveryState":"normal","errorCode":null,"submissionIntentAt":now(),"provider":provider,"providerFingerprint":runtime.binding(&self.storage)})).await?;
            runtime.monitor(
                self.storage.clone(),
                self.principal.clone(),
                self.id.clone(),
            );
            Ok(())
        })
    }
    fn observed(&self, id: String, metadata: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            patch(&self.storage,&self.principal,&self.id,json!({"upstreamId":id,"submissionObservedAt":now(),"status":"running","metadata":metadata})).await?;
            if let Some(runtime) = self.runtime.upgrade() {
                runtime.monitor(
                    self.storage.clone(),
                    self.principal.clone(),
                    self.id.clone(),
                );
            }
            Ok(())
        })
    }
    fn collect(&self, outputs: Vec<Output>) -> BoxFuture<'_, Result<()>> {
        Box::pin(collect(&self.storage, &self.principal, &self.id, outputs))
    }
    fn collect_indexed(&self, outputs: Vec<(usize, Output)>) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            for (index, output) in outputs {
                media::persist(
                    &self.storage,
                    &self.principal,
                    &self.id,
                    media::Target::Result(index),
                    output,
                )
                .await?;
            }
            Ok(())
        })
    }
    fn protect_input(&self, name: String, input: Output) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            if !input.mime().starts_with("image/") {
                return Err(ApiError::new(
                    409,
                    "TASK_INPUT_INVALID",
                    "Protected task input must be an image",
                ));
            }
            media::persist(
                &self.storage,
                &self.principal,
                &self.id,
                media::Target::Input(name),
                input,
            )
            .await
        })
    }
    fn restore_input(&self, name: String, path: std::path::PathBuf) -> BoxFuture<'_, Result<bool>> {
        Box::pin(async move {
            media::restore(&self.storage, &self.principal, &self.id, &name, &path).await
        })
    }
}

pub(super) async fn collect(
    storage: &Storage,
    principal: &str,
    id: &str,
    outputs: Vec<Output>,
) -> Result<()> {
    for (index, output) in outputs.into_iter().enumerate() {
        media::persist(storage, principal, id, media::Target::Result(index), output).await?;
    }
    Ok(())
}
