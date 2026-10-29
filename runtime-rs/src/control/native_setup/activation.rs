use super::*;
impl ControlService {
    pub(super) async fn activate_native_settings(
        &self,
        body: Request,
        operation: &Value,
        cancel: &CancellationToken,
        _permit: &Arc<OwnedSemaphorePermit>,
    ) -> Result<Value> {
        let (_, models) = bundles()?;
        let runtime = image_models::runtime_for(body.model_id.as_deref())?;
        let model = models
            .into_iter()
            .find(|m| Some(&m.id) == body.model_id.as_ref())
            .ok_or_else(|| ApiError::invalid("请选择已登记的完整原生模型包"))?;
        let root = self
            .config
            .ai_workspace_root
            .join("inference/models")
            .join(&model.id);
        let settings = image_models::settings(self, &runtime)?;
        if !receipt_matches(&root, &model) {
            return Err(ApiError::new(
                409,
                "NATIVE_SETUP_INCOMPLETE",
                "运行库或模型尚未完成校验，请先完成准备或重试下载",
            ));
        }
        // Activation saves an installed selection. Download/import already owns
        // file verification; runtime preparation owns dependency initialization.
        self.native_stage(operation, 1);
        let configured = self.configured_inference()?;
        let video_engine = configured.video_engine().to_owned();
        let mut target_settings = if image_models::is_adapter_runtime(&runtime) {
            // Keep Anima's interpreter; adapters must resolve beside the bundled worker.
            let mut value = configured;
            value.adapter_python = Some(settings.python.clone());
            value.worker = settings.worker.with_file_name("worker.py");
            value.models_root = self.config.ai_workspace_root.join("inference/models");
            value
        } else {
            let mut value = settings;
            value.adapter_python = configured.adapter_python.or(value.adapter_python);
            value
        };
        target_settings.engine = "native".into();
        target_settings.video_engine = Some(video_engine);
        target_settings.acceleration = "native".into();
        target_settings.memory_policy = "offload".into();
        let target = serde_json::to_value(&target_settings)?;
        let active = self.active_inference()?;
        let current = serde_json::to_value(&active)?;
        for key in &active.environment_overrides {
            if target[key] != current[key] {
                return Err(ApiError::new(
                    409,
                    "CONFIG_ENV_OVERRIDE",
                    format!("{key} 由启动环境覆盖，请移除覆盖后重启绘遇"),
                ));
            }
        }
        stopped(cancel)?;
        self.native_stage(operation, 2);
        self.patch(
            json!({"inference":target,"inferenceWorkspacePath":self.config.ai_workspace_root}),
        )
        .await?;
        self.inference_view()
    }
}
