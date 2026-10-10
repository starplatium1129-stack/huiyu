use super::*;
use crate::generation::native::Settings;
use axum::{
    Extension, Json, Router,
    routing::{get, post},
};
use std::process::Stdio;
use tokio::io::AsyncReadExt;

pub(super) fn routes() -> Router<crate::AppState> {
    Router::new()
        .route("/api/inference/settings", get(settings).post(save))
        .route("/api/inference/status", get(status))
        .route("/api/inference/diagnostics", post(diagnose))
}
impl ControlService {
    fn active_inference(&self) -> Result<Settings> {
        self.inference
            .as_ref()
            .cloned()
            .map_err(|e| ApiError::new(e.status.as_u16(), &e.code, &e.message))
    }
    pub(super) fn configured_inference(&self) -> Result<Settings> {
        let active = self.active_inference()?;
        let saved = self.saved.read().unwrap();
        let Some(value) = saved.get("inference") else {
            return Ok(active);
        };
        let mut configured: Settings = serde_json::from_value(value.clone())
            .map_err(|_| ApiError::invalid("已保存的推理配置无效"))?;
        let active_json = serde_json::to_value(&active)?;
        let mut target = serde_json::to_value(&configured)?;
        for key in &active.environment_overrides {
            target[key] = active_json[key].clone();
        }
        configured = serde_json::from_value(target)?;
        configured.validate()?;
        Ok(configured)
    }
    fn inference_view(&self) -> Result<Value> {
        let active = self.active_inference()?;
        let configured = self.configured_inference()?;
        let current = serde_json::to_value(&active)?;
        let target = serde_json::to_value(configured)?;
        Ok(
            json!({"ok":true,"restartRequired":current != target,"active":current,
            "configured":target,"environmentOverrides":active.environment_overrides}),
        )
    }
    async fn save_inference(&self, configured: Settings) -> Result<Value> {
        configured.validate()?;
        let active = self.active_inference()?;
        let target = serde_json::to_value(&configured)?;
        let current = serde_json::to_value(&active)?;
        for key in &active.environment_overrides {
            if target[key] != current[key] {
                return Err(ApiError::new(
                    409,
                    "CONFIG_ENV_OVERRIDE",
                    format!("{key} 由启动环境覆盖，请修改启动环境后重启"),
                ));
            }
        }
        self.patch(json!({"inference":target})).await?;
        self.inference_view()
    }
}
async fn settings(Extension(s): Extension<Arc<ControlService>>) -> Result<Json<Value>> {
    Ok(Json(s.inference_view()?))
}
async fn save(
    Extension(s): Extension<Arc<ControlService>>,
    Json(body): Json<Settings>,
) -> Result<Json<Value>> {
    Ok(Json(s.save_inference(body).await?))
}
async fn status(Extension(s): Extension<Arc<ControlService>>) -> Result<Json<Value>> {
    let mut value = s.inference_view()?;
    let configured = s.configured_inference()?;
    let mut files = json!({});
    for (key, path, directory) in [
        ("python", &configured.python, false),
        ("worker", &configured.worker, false),
        ("modelsRoot", &configured.models_root, true),
        ("lorasRoot", &configured.loras_root, true),
    ] {
        files[key] = json!(tokio::fs::metadata(path).await.is_ok_and(|m| if directory {
            m.is_dir()
        } else {
            m.is_file()
        }));
    }
    value["diagnostics"] = json!({"basis":"configured","configuration":"valid","files":files,
        "dependencies":"unchecked","runtime":"unverified",
        "message":"文件检查不代表依赖、CUDA 或模型推理可用；依赖检查需手动执行，真实出图尚未验证"});
    Ok(Json(value))
}
async fn diagnose(Extension(s): Extension<Arc<ControlService>>) -> Result<Json<Value>> {
    let _guard = s
        .inference_probe
        .try_lock()
        .map_err(|_| ApiError::new(409, "INFERENCE_DIAGNOSTICS_BUSY", "已有依赖检查正在执行"))?;
    let settings = s.active_inference()?;
    settings.validate_files().await?;
    let mut command = tokio::process::Command::new(&settings.python);
    command
        .arg("-I")
        .arg("-u")
        .arg(&settings.worker)
        .arg("--diagnose")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .env_remove("PYTHONPATH")
        .env_remove("PYTHONHOME")
        .env("HF_HUB_OFFLINE", "1")
        .env("TRANSFORMERS_OFFLINE", "1");
    let process = s.processes.spawn(&mut command)?;
    let operation = async {
        let (stdout, _) = process.take_output();
        let mut stdout = stdout.ok_or_else(protocol_error)?.take(65537);
        let mut bytes = Vec::new();
        stdout.read_to_end(&mut bytes).await?;
        if bytes.len() > 65536 {
            return Err(protocol_error());
        }
        let probe: Value = serde_json::from_slice(&bytes).map_err(|_| protocol_error())?;
        loop {
            if let Some(success) = process.exited()? {
                if probe["event"] == "error" {
                    return Err(ApiError::new(
                        503,
                        "NATIVE_DEPENDENCIES_UNAVAILABLE",
                        s.redact(probe["message"].as_str().unwrap_or("独立推理依赖检查失败")),
                    ));
                }
                if !success
                    || !probe["id"].is_null()
                    || probe["event"] != "diagnostic"
                    || probe["valid"] != true
                    || !probe["dependencies"]
                        .as_object()
                        .is_some_and(|values| values.values().all(Value::is_string))
                    || !probe["cudaAvailable"].is_boolean()
                    || !(probe["deviceName"].is_null() || probe["deviceName"].is_string())
                    || !probe["scope"].is_string()
                {
                    return Err(protocol_error());
                }
                return Ok(Json(json!({"ok":true,"basis":"active","probe":probe})));
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    };
    let result = tokio::select! {
        biased;
        _ = s.shutdown.cancelled() => Err(ApiError::new(499, "ABORT_ERR", "依赖检查已取消")),
        result = tokio::time::timeout(Duration::from_secs(30), operation) => result.unwrap_or_else(|_| Err(ApiError::new(504, "NATIVE_DIAGNOSTICS_TIMEOUT", "依赖检查超时"))),
    };
    process.stop().await?;
    result
}
fn protocol_error() -> ApiError {
    ApiError::new(
        502,
        "NATIVE_DIAGNOSTICS_PROTOCOL",
        "独立推理依赖检查返回无效结果",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn selection_is_persisted_without_changing_active_snapshot() {
        let (_temp, service) = super::super::tests::fixture(json!({"unrelated":{"keep":true}}));
        let active = service.active_inference().unwrap();
        assert_eq!(active.engine, "comfy");
        let mut target = active.clone();
        target.engine = "native".into();
        target.models_root = service.config.ai_workspace_root.join("custom-models");
        let result = service.save_inference(target.clone()).await.unwrap();
        assert_eq!(result["active"]["engine"], "comfy");
        assert_eq!(result["configured"]["engine"], "native");
        assert_eq!(result["restartRequired"], true);
        assert_eq!(service.active_inference().unwrap(), active);
        let disk: Value = serde_json::from_slice(
            &std::fs::read(service.config.runtime_root.join("config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(disk["unrelated"]["keep"], true);
        assert_eq!(disk["inference"], serde_json::to_value(&target).unwrap());
        let restored = service.save_inference(active).await.unwrap();
        assert_eq!(restored["restartRequired"], false);
        service.close().await;
    }
    #[tokio::test]
    async fn missing_native_files_do_not_claim_runtime_readiness() {
        let (_temp, service) = super::super::tests::fixture(json!({}));
        let Json(value) = status(Extension(service.clone())).await.unwrap();
        assert_eq!(value["diagnostics"]["files"]["python"], false);
        assert_eq!(value["diagnostics"]["dependencies"], "unchecked");
        assert_eq!(value["diagnostics"]["runtime"], "unverified");
        assert_eq!(value["diagnostics"]["basis"], "configured");
        service.close().await;
    }
}
