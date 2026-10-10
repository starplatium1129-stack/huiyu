use super::*;

impl Service {
    pub(crate) async fn resume_prepared(
        &self,
        input: Value,
        hooks: &dyn ExecutionHooks,
        cancel: CancellationToken,
    ) -> Result<Prepared> {
        if self.shutdown.is_cancelled() {
            return Err(closed());
        }
        if self.native != (input["inferenceEngine"] == "native") {
            return Err(ApiError::new(409,"TASK_RESUME_UNSAFE","任务推理引擎已改变"));
        }
        for key in ["initImage", "maskImage"] {
            if let Some(name) = input[key].as_str() {
                // Restore the accepted bytes before the resource probe. A stale
                // working copy must not change the resumed input silently.
                let restored = hooks
                    .restore_input(name.into(), inputs::path_for(&self.config, name, self.native)?)
                    .await?;
                if self.native && !restored {
                    return Err(ApiError::new(409, "TASK_RESUME_UNSAFE", "独立推理缺少受保护的原始输入图像"));
                }
            }
        }
        let originals = inputs::capture(&self.config, &input, true, None, &cancel).await?;
        let prepared = if self.native {
            let plan = native::plan(&self.backend.native_settings()?, input, &originals).await?;
            self.backend.prepare_native(plan, cancel.clone()).await?
        } else {
            let plan = resources::frozen_plan(&self.config, input).await?;
            self.backend.prepare_comfy(plan, cancel.clone()).await?
        };
        Ok(Prepared {
            input: prepared.input.clone(),
            provider: prepared.provider.clone(),
            backend: prepared,
            originals,
        })
    }
}
