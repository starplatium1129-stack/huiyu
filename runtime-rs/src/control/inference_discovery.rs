use super::*;
use crate::generation::native::Settings;

impl ControlService {
    pub(super) async fn inference_discovery(&self) -> Result<Value> {
        let config = self.config.clone();
        let configured = self.configured_inference()?;
        let active = self.active_inference()?;
        let explicit = {
            let saved = self.saved.read().unwrap();
            let workspace_matches = saved["inferenceWorkspacePath"].as_str()
                .is_none_or(|path| std::path::Path::new(path) == self.config.ai_workspace_root);
            saved.get("inference").filter(|_|workspace_matches).cloned()
        };
        // Bounded local filesystem discovery stays off the async request thread.
        tokio::task::spawn_blocking(move || {
            let (mut suggested, receipt) = Settings::discovered(&config.ai_workspace_root);
            suggested.engine = "native".into();
            let mut target = serde_json::to_value(&suggested)?;
            let saved = serde_json::to_value(&configured)?;
            // Existing settings and environment overrides have precedence. A
            // discovery refresh must not replace paths deliberately selected by a user.
            for key in [
                "python",
                "adapterPython",
                "worker",
                "modelsRoot",
                "lorasRoot",
                "acceleration",
                "memoryPolicy",
            ] {
                if explicit
                    .as_ref()
                    .is_some_and(|value| value.get(key).is_some())
                {
                    target[key] = saved[key].clone();
                }
            }
            let current = serde_json::to_value(&active)?;
            for key in &active.environment_overrides {
                target[key] = current[key].clone();
            }
            let selected: Settings = serde_json::from_value(target.clone())?;
            selected.validate()?;
            let model_count = selected.model_count();
            let lora_count = selected.lora_count();
            let mut missing = Vec::new();
            let receipt = receipt.filter(|_| selected.python == suggested.python);
            let explicit_python = explicit
                .as_ref()
                .is_some_and(|value| value.get("python").is_some())
                || active
                    .environment_overrides
                    .iter()
                    .any(|key| key == "python");
            if !selected.python.is_file() || (receipt.is_none() && !explicit_python) {
                missing.push("兼容的本机 Python 运行库");
            }
            if !selected.worker.is_file() {
                missing.push("随绘遇安装的推理 Worker");
            }
            if model_count == 0 {
                missing.push("已转换的 Anima 模型目录");
            }
            if selected.engine != "native" {
                missing.push("启动环境固定了其他绘图引擎");
            }
            Ok(json!({"suggested":target,"canAdopt":missing.is_empty(),
                "modelCount":model_count,"loraCount":lora_count,"missing":missing,
                "runtimeReceipt":receipt,"preservesSavedSettings":explicit.is_some(),
                "scope":"local-files-only"}))
        })
        .await
        .map_err(|_| ApiError::new(503, "INFERENCE_DISCOVERY_FAILED", "本机推理资源读取未完成"))?
    }
}
