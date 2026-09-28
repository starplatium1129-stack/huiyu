use super::*;
impl Service {
    pub(crate) async fn resume_prepared(
        &self,
        input: Value,
        hooks: &dyn ExecutionHooks,
        cancel: CancellationToken,
    ) -> Result<Prepared> {
        restore(&self.config, &input, hooks, &cancel).await?;
        self.prepare_input(input, true, None, false, cancel).await
    }
    pub(crate) async fn prepare_batch_resumed(
        &self,
        input: Value,
        hooks: &dyn ExecutionHooks,
        cancel: CancellationToken,
    ) -> Result<BatchPrepared> {
        let shots = input["shots"]
            .as_array()
            .filter(|a| !a.is_empty() && a.len() <= 30)
            .ok_or_else(|| error(409, "TASK_RESUME_UNSAFE", "已保存的分镜参数无效"))?;
        for shot in shots {
            restore(&self.config, &shot["input"], hooks, &cancel).await?;
        }
        self.prepare_batch_normalized(input, cancel).await
    }
}
pub(super) async fn restore(
    config: &Config,
    input: &Value,
    hooks: &dyn ExecutionHooks,
    cancel: &CancellationToken,
) -> Result<()> {
    for name in inputs::names(input) {
        if cancel.is_cancelled() {
            return Err(error(499, "VIDEO_CANCELLED", "视频恢复已取消"));
        }
        let target = inputs::path(config, name)?;
        if !hooks.restore_input(name.into(), target.clone()).await?
            && !tokio::fs::try_exists(&target).await?
        {
            return Err(error(409, "TASK_INPUT_MISSING", "受保护的视频输入不可用"));
        }
    }
    Ok(())
}
