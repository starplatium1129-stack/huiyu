use super::*;
use crate::generation::native::Settings;
use serde::Deserialize;

const SAVED_FIELDS: [&str; 7] = [
    "python",
    "adapterPython",
    "worker",
    "modelsRoot",
    "lorasRoot",
    "acceleration",
    "memoryPolicy",
];

impl ControlService {
    pub(super) async fn inference_discovery(self: &Arc<Self>) -> Result<Value> {
        let service = self.clone();
        // Configuration recovery can also discover files after a workspace move.
        tokio::task::spawn_blocking(move || {
            let config = &service.config;
            let configured = service.configured_inference()?;
            let active = service.active_inference()?;
            let explicit = {
                let saved = service.saved.read().unwrap();
                let workspace_matches = saved["inferenceWorkspacePath"]
                    .as_str()
                    .is_none_or(|path| std::path::Path::new(path) == config.ai_workspace_root);
                saved
                    .get("inference")
                    .filter(|_| workspace_matches)
                    .map(|value| {
                        SAVED_FIELDS
                            .into_iter()
                            .filter(|key| value.get(*key).is_some())
                            .collect::<Vec<_>>()
                    })
            };
            let (mut suggested, receipt) = Settings::discovered(&config.ai_workspace_root);
            suggested.engine = "native".into();
            let mut target = serde_json::to_value(&suggested)?;
            target["videoEngine"] = json!(configured.video_engine());
            let saved = serde_json::to_value(&configured)?;
            // Existing settings and environment overrides have precedence. A
            // discovery refresh must not replace paths deliberately selected by a user.
            for key in SAVED_FIELDS {
                if explicit
                    .as_ref()
                    .is_some_and(|fields| fields.contains(&key))
                {
                    target[key] = saved[key].clone();
                }
            }
            let current = serde_json::to_value(&active)?;
            for key in &active.environment_overrides {
                target[key] = current[key].clone();
            }
            let selected = Settings::deserialize(&target)?;
            selected.validate()?;
            let model_count = selected.model_count();
            let lora_count = selected.lora_count();
            let mut missing = Vec::new();
            let receipt = receipt.filter(|_| selected.python == suggested.python);
            let explicit_python = explicit
                .as_ref()
                .is_some_and(|fields| fields.contains(&"python"))
                || active
                    .environment_overrides
                    .iter()
                    .any(|key| key == "python");
            let adapter_ready = crate::generation::native::adapters::manifest()["models"]
                .as_object()
                .unwrap()
                .iter()
                .any(|(id, model)| {
                    model["media"] == "image"
                        && crate::generation::native::adapters::status(&selected, id)["available"]
                            == true
                });
            if !adapter_ready
                && (!selected.python.is_file() || (receipt.is_none() && !explicit_python))
            {
                missing.push("兼容的本机 Python 运行库");
            }
            if !selected.worker.is_file() {
                missing.push("随绘遇安装的推理 Worker");
            }
            if model_count == 0 {
                missing.push("完整的原生图像模型目录");
            }
            if selected.engine != "native" {
                missing.push("启动环境固定了其他绘图引擎");
            }
            let mut value = json!({"suggested":null,"canAdopt":missing.is_empty(),
                "modelCount":model_count,"loraCount":lora_count,"missing":missing,
                "runtimeReceipt":receipt,"preservesSavedSettings":explicit.is_some(),
                "scope":"local-files-only"});
            value["suggested"] = target;
            Ok(value)
        })
        .await
        .map_err(|_| ApiError::new(503, "INFERENCE_DISCOVERY_FAILED", "本机推理资源读取未完成"))?
    }
}
