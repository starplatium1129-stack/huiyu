use super::*;
use futures_util::future::BoxFuture;
pub(super) struct ShotHooks {
    pub batch: Arc<Batch>,
    pub index: usize,
}
impl ExecutionHooks for ShotHooks {
    fn checkpoint(&self, value: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            if let Some(id) = value["gatewayJobId"].as_str() {
                self.batch.state.lock().await.shots[self.index].gateway = Some(id.into());
            }
            self.batch.save().await
        })
    }
    fn submitting(&self, _: String, _: String) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            if let Some(h) = &self.batch.hooks {
                h.submitting("comfy".into(), String::new()).await?;
            }
            let mut state = self.batch.state.lock().await;
            if state.cancel.is_cancelled() {
                return Err(error(499, "VIDEO_BATCH_CANCELLED", "分镜任务已取消"));
            }
            let shot = &mut state.shots[self.index];
            if shot.intent.is_some() {
                return Err(error(
                    409,
                    "BATCH_REPLAY_FORBIDDEN",
                    "该分镜已有提交意图，必须先核对上游",
                ));
            }
            shot.intent = Some(now());
            shot.status = "running".into();
            drop(state);
            self.batch.save().await
        })
    }
    fn observed(&self, id: String, _: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            self.batch.state.lock().await.shots[self.index].upstream = Some(id);
            self.batch.save().await
        })
    }
    fn collect(&self, outputs: Vec<Output>) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            if let Some(h) = &self.batch.hooks {
                h.collect_indexed(outputs.iter().cloned().map(|o| (self.index, o)).collect())
                    .await?;
            }
            self.batch.state.lock().await.shots[self.index].result = outputs.into_iter().next();
            self.batch.save().await
        })
    }
    fn protect_input(&self, name: String, input: Output) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            if let Some(h) = &self.batch.hooks {
                h.protect_input(name, input).await?;
            }
            Ok(())
        })
    }
    fn restore_input(&self, name: String, path: PathBuf) -> BoxFuture<'_, Result<bool>> {
        Box::pin(async move {
            if let Some(h) = &self.batch.hooks {
                h.restore_input(name, path).await
            } else {
                Ok(false)
            }
        })
    }
}
