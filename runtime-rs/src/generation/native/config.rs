use super::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Settings {
    pub engine: String,
    pub python: PathBuf,
    pub worker: PathBuf,
    pub models_root: PathBuf,
    pub loras_root: PathBuf,
    #[serde(skip)]
    pub environment_overrides: Vec<String>,
}
impl Settings {
    pub(crate) fn validate(&self) -> Result<()> {
        if !matches!(self.engine.as_str(), "comfy" | "native") {
            return Err(ApiError::invalid("推理引擎仅支持 comfy 或 native"));
        }
        for path in [
            &self.python,
            &self.worker,
            &self.models_root,
            &self.loras_root,
        ] {
            if !path.is_absolute() || path.to_str().is_none_or(|p| p.contains('\0')) {
                return Err(ApiError::invalid("推理路径必须是有效的绝对路径"));
            }
        }
        Ok(())
    }
    pub(crate) async fn validate_files(&self) -> Result<()> {
        self.validate()?;
        for path in [&self.python, &self.worker] {
            if !tokio::fs::metadata(path).await.is_ok_and(|m| m.is_file()) {
                return Err(ApiError::new(
                    503,
                    "NATIVE_RUNTIME_UNAVAILABLE",
                    "独立推理 Python 或 worker 未安装",
                ));
            }
        }
        Ok(())
    }
}
/// Snapshot configuration once at service construction. Request paths must use
/// that snapshot, never reread a configuration saved pending application restart.
pub(crate) fn load(config: &Config) -> Result<Settings> {
    let saved = read_optional(&config.runtime_root.join("config.json"))?;
    let root = config.ai_workspace_root.join("inference");
    // Preparation receipts are optional installation hints, not application
    // configuration. A stale receipt must not disable the default Comfy engine.
    let receipt = read_optional(&root.join("runtime-config.json")).unwrap_or(Value::Null);
    let packaged_worker = std::env::current_exe()
        .ok()
        .and_then(|path| {
            path.parent()
                .map(|root| root.join("tools/inference/worker.py"))
        })
        .filter(|path| path.is_file());
    let worker = packaged_worker.unwrap_or_else(|| {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("tools/inference/worker.py")
    });
    let defaults = json!({
        "engine":"comfy",
        "python":root.join(if cfg!(windows) { "venv/Scripts/python.exe" } else { "venv/bin/python" }),
        "worker":worker,"modelsRoot":root.join("models"),"lorasRoot":root.join("loras")
    });
    let mut value = defaults;
    // The preparation receipt supplies paths, never switches the selected engine.
    for key in ["python", "worker"] {
        if receipt["schemaVersion"] == 1
            && receipt["engine"] == "native"
            && let Some(path) = receipt[key]
                .as_str()
                .filter(|p| std::path::Path::new(p).is_absolute() && !p.contains('\0'))
        {
            value[key] = json!(path);
        }
    }
    if let Some(inference) = saved.get("inference") {
        let settings: Settings =
            serde_json::from_value(inference.clone()).map_err(|_| config_error())?;
        value = serde_json::to_value(settings)?;
    }
    let mut overrides = Vec::new();
    for (key, env) in [
        ("engine", "HUIYU_IMAGE_ENGINE"),
        ("python", "HUIYU_INFERENCE_PYTHON"),
        ("worker", "HUIYU_INFERENCE_WORKER"),
        ("modelsRoot", "HUIYU_INFERENCE_MODELS_ROOT"),
        ("lorasRoot", "HUIYU_INFERENCE_LORAS_ROOT"),
    ] {
        if let Some(raw) = std::env::var_os(env) {
            value[key] = json!(raw.to_str().ok_or_else(config_error)?);
            overrides.push(key.to_owned());
        }
    }
    let mut settings: Settings = serde_json::from_value(value).map_err(|_| config_error())?;
    settings.validate().map_err(|_| config_error())?;
    settings.environment_overrides = overrides;
    Ok(settings)
}
fn read_optional(path: &std::path::Path) -> Result<Value> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| config_error()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(_) => Err(config_error()),
    }
}
fn config_error() -> ApiError {
    ApiError::new(
        503,
        "NATIVE_CONFIG_INVALID",
        "独立推理配置无效，请检查引擎及绝对路径",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persisted_engine_paths_and_frozen_identity_do_not_require_comfy() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let config = Config {
            sd_host: "http://127.0.0.1:1".into(),
            sd_auth: None,
            comfy_host: "http://127.0.0.1:2".into(),
            ai_workspace_root: root.join("AI"),
            runtime_root: root.join("runtime"),
        };
        std::fs::create_dir_all(&config.runtime_root).unwrap();
        let mut settings = load(&config).unwrap();
        assert_eq!(settings.engine, "comfy");
        assert_eq!(
            settings.models_root,
            config.ai_workspace_root.join("inference/models")
        );
        settings.engine = "native".into();
        settings.models_root = root.join("custom-models");
        std::fs::write(
            config.runtime_root.join("config.json"),
            serde_json::to_vec(&json!({"inference":settings})).unwrap(),
        )
        .unwrap();
        let service = Service::for_images(
            config.clone(),
            LocalUpstream::new(),
            CancellationToken::new(),
        )
        .unwrap();
        let identity = service.provider_identity("test");
        settings.models_root = root.join("next-models");
        std::fs::write(
            config.runtime_root.join("config.json"),
            serde_json::to_vec(&json!({"inference":settings})).unwrap(),
        )
        .unwrap();
        assert_eq!(
            service.native_settings().unwrap().models_root,
            root.join("custom-models")
        );
        assert_eq!(service.provider_identity("test"), identity);
        assert_eq!(load(&config).unwrap().models_root, root.join("next-models"));
    }
    #[test]
    fn rejects_relative_paths_unknown_fields_and_unknown_engine() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path();
        let mut value = json!({"engine":"native","python":path.join("python"),"worker":path.join("worker.py"),"modelsRoot":path.join("models"),"lorasRoot":path.join("loras")});
        let settings: Settings = serde_json::from_value(value.clone()).unwrap();
        settings.validate().unwrap();
        value["modelsRoot"] = json!("relative");
        assert!(
            serde_json::from_value::<Settings>(value.clone())
                .unwrap()
                .validate()
                .is_err()
        );
        value["modelsRoot"] = json!(path.join("models"));
        value["engine"] = json!("automatic");
        assert!(
            serde_json::from_value::<Settings>(value.clone())
                .unwrap()
                .validate()
                .is_err()
        );
        value["unknown"] = json!(true);
        assert!(serde_json::from_value::<Settings>(value).is_err());
    }
}
