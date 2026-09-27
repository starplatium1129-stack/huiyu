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
        for key in ["initImage", "maskImage"] {
            if let Some(name) = input[key].as_str() {
                // Restore the accepted bytes before the resource probe. A stale
                // working copy must not change the resumed input silently.
                hooks
                    .restore_input(name.into(), inputs::path(&self.config, name)?)
                    .await?;
            }
        }
        let plan = resources::frozen_plan(&self.config, input).await?;
        let prepared = self.backend.prepare_comfy(plan, cancel.clone()).await?;
        let originals = inputs::capture(&self.config, &prepared.input, true, None, &cancel).await?;
        Ok(Prepared {
            input: prepared.input.clone(),
            provider: prepared.provider.clone(),
            backend: prepared,
            originals,
        })
    }
}
