use super::ControlService;
use crate::error::{ApiError, Result};
use axum::{Extension, Json};
use serde_json::{Value, json};
use std::{process::Stdio, sync::Arc, time::Duration};
use tokio::io::AsyncReadExt;

pub(super) async fn diagnose(Extension(s): Extension<Arc<ControlService>>) -> Result<Json<Value>> {
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
                    || probe.get("backend").is_some_and(|value| {
                        !matches!(value.as_str(), Some("cuda" | "rocm" | "xpu"))
                    })
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
