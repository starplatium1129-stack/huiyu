use super::*;
use crate::generation::native::Settings;
use axum::{
    Extension, Json, Router,
    routing::{get, post},
};
use serde::Deserialize;
use std::process::Stdio;
use tokio::io::AsyncReadExt;

pub(super) fn routes() -> Router<crate::AppState> {
    Router::new()
        .route("/api/inference/settings", get(settings).post(save))
        .route("/api/inference/status", get(status))
        .route("/api/inference/diagnostics", post(diagnose))
}
impl ControlService {
    pub(crate) fn bind_images(&self, images: &Arc<crate::images::ImageService>) {
        *self.images.write().unwrap() = Arc::downgrade(images);
    }
    pub(super) async fn native_chat_handoff(
        &self,
    ) -> Result<Option<tokio::sync::OwnedSemaphorePermit>> {
        self.check_llama_release()?;
        let images = self.images.read().unwrap().upgrade();
        if let Some(images) = images {
            return images.native_chat_handoff().await;
        }
        let settings = self.active_inference()?;
        if settings.engine == "native" || settings.video_engine() == "native" {
            return Err(ApiError::new(
                503,
                "NATIVE_RUNTIME_UNAVAILABLE",
                "独立绘图服务未接入，无法确认显存释放",
            ));
        }
        Ok(None)
    }
    pub(crate) async fn ensure_native_drawing(
        &self,
        cancel: &tokio_util::sync::CancellationToken,
    ) -> Result<()> {
        if cancel.is_cancelled() || self.shutdown.is_cancelled() {
            return Err(ApiError::new(499, "ABORT_ERR", "独立推理已取消"));
        }
        self.stop_llama().await?;
        self.stop_comfy_for_native().await?;
        if cancel.is_cancelled() || self.shutdown.is_cancelled() {
            return Err(ApiError::new(499, "ABORT_ERR", "独立推理已取消"));
        }
        Ok(())
    }
    pub(super) fn active_inference(&self) -> Result<&Settings> {
        self.inference
            .as_ref()
            .map_err(|e| ApiError::new(e.status.as_u16(), &e.code, &e.message))
    }
    pub(super) fn configured_inference(&self) -> Result<Settings> {
        let active = self.active_inference()?;
        let saved = self.saved.read().unwrap();
        let Some(value) = saved.get("inference") else {
            return Ok(active.clone());
        };
        if saved["inferenceWorkspacePath"].as_str().is_some_and(|path| std::path::Path::new(path) != self.config.ai_workspace_root) {
            // Saved paths belong to the previous workspace. Keep those user files
            // and saved data, but do not advertise them as resources of this one.
            let engine = value["engine"].as_str().unwrap_or("native").to_owned();
            let video_engine = value["videoEngine"].as_str().unwrap_or(&engine).to_owned();
            drop(saved);
            let mut current = Settings::discovered(&self.config.ai_workspace_root).0;
            current.engine = engine;
            current.video_engine = Some(video_engine);
            current.environment_overrides = active.environment_overrides.clone();
            return Ok(current);
        }
        let mut configured = Settings::deserialize(value)
            .map_err(|_| ApiError::invalid("已保存的推理配置无效"))?;
        drop(saved);
        if !active.environment_overrides.is_empty() {
            let active_json = serde_json::to_value(active)?;
            let mut target = serde_json::to_value(&configured)?;
            for key in &active.environment_overrides {
                target[key] = active_json[key].clone();
            }
            configured = serde_json::from_value(target)?;
        }
        configured.validate()?;
        Ok(configured)
    }
    pub(super) fn inference_view(&self) -> Result<Value> {
        self.inference_snapshot().map(|(value, _)| value)
    }
    fn inference_snapshot(&self) -> Result<(Value, Settings)> {
        let active = self.active_inference()?;
        let configured = self.configured_inference()?;
        let current = serde_json::to_value(active)?;
        let target = serde_json::to_value(&configured)?;
        let value = json!({"ok":true,"restartRequired":current != target,"active":current,
            "configured":target,"environmentOverrides":active.environment_overrides});
        Ok((value, configured))
    }
    async fn save_inference(&self, configured: Settings) -> Result<Value> {
        configured.validate()?;
        let active = self.active_inference()?;
        let target = serde_json::to_value(&configured)?;
        let current = serde_json::to_value(active)?;
        for key in &active.environment_overrides {
            if target[key] != current[key] {
                return Err(ApiError::new(
                    409,
                    "CONFIG_ENV_OVERRIDE",
                    format!("{key} 由启动环境覆盖，请修改启动环境后重启"),
                ));
            }
        }
        self.patch(json!({"inference":target,"inferenceWorkspacePath":self.config.ai_workspace_root})).await?;
        self.inference_view()
    }
}
async fn settings(Extension(s): Extension<Arc<ControlService>>) -> Result<Json<Value>> {
    Ok(Json(s.inference_view()?))
}
async fn save(
    Extension(s): Extension<Arc<ControlService>>,
    Json(mut body): Json<Value>,
) -> Result<Json<Value>> {
    // Image settings do not change video selection or discard a separately
    // configured adapter interpreter when older clients omit these fields.
    if let Some(object) = body.as_object_mut() {
        let configured = s.configured_inference()?;
        if !object.contains_key("videoEngine") {
            object.insert("videoEngine".into(), json!(configured.video_engine()));
        }
        if !object.contains_key("adapterPython") {
            if let Some(python) = configured.adapter_python {
                object.insert("adapterPython".into(), json!(python));
            }
        }
    }
    let settings: Settings = serde_json::from_value(body).map_err(|_| ApiError::invalid("推理配置字段无效"))?;
    Ok(Json(s.save_inference(settings).await?))
}
async fn status(Extension(s): Extension<Arc<ControlService>>) -> Result<Json<Value>> {
    let service = s.clone();
    let mut value = tokio::task::spawn_blocking(move || -> Result<Value> {
        let (mut value, configured) = service.inference_snapshot()?;
        let mut files = json!({});
        for (key, path, directory) in [
            ("python", &configured.python, false),
            ("worker", &configured.worker, false),
            ("modelsRoot", &configured.models_root, true),
            ("lorasRoot", &configured.loras_root, true),
        ] {
            files[key] = json!(std::fs::metadata(path).is_ok_and(|m| if directory {
                m.is_dir()
            } else {
                m.is_file()
            }));
        }
        value["diagnostics"] = json!({"basis":"configured","configuration":"valid","files":null,
            "dependencies":"unchecked","runtime":"unverified",
            "message":"文件检查不代表依赖、CUDA 或模型推理可用；依赖检查需手动执行，真实出图尚未验证"});
        value["diagnostics"]["files"] = files;
        Ok(value)
    })
    .await
    .map_err(|_| ApiError::new(503, "INFERENCE_STATUS_FAILED", "推理文件状态读取未完成"))??;
    value["discovery"] = s.inference_discovery().await?;
    Ok(Json(value))
}
async fn diagnose(Extension(s): Extension<Arc<ControlService>>) -> Result<Json<Value>> {
    let _guard = s
        .inference_probe
        .try_lock()
        .map_err(|_| ApiError::new(409, "INFERENCE_DIAGNOSTICS_BUSY", "已有依赖检查正在执行"))?;
    let settings = s.active_inference()?;
    settings.validate_anima_files().await?;
    let mut command = settings.worker_command();
    command
        .arg("--diagnose")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
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
