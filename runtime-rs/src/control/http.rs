mod configuration;
mod status;
mod web_build;

use super::*;
use axum::{
    Extension, Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Path, Request, State},
    http::{HeaderMap, HeaderValue},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use configuration::{config, preference};
use status::{diagnostics, logs, share, status};
use std::net::SocketAddr;
pub(super) use web_build::Cache as WebBuildCache;

pub fn router(service: Arc<ControlService>) -> Router<crate::AppState> {
    Router::new()
        .route("/api/status", get(status))
        .merge(inference::routes())
        .merge(inference_setup::routes())
        .merge(native_setup::routes())
        .merge(voice_profiles::routes())
        .merge(setup_http::routes())
        .route("/api/share-link", get(share))
        .route("/api/logs", get(logs))
        .route("/api/diagnostics", get(diagnostics))
        .route("/api/config", post(config))
        .route("/api/preference", post(preference))
        .route("/api/start", post(start))
        .route("/api/stop", post(stop))
        .route("/api/service/{service}", post(action))
        .route("/api/mode", post(mode))
        .route("/api/maintenance/build-web", post(build))
        .layer(DefaultBodyLimit::max(32 * 1024))
        .layer(middleware::from_fn(local))
        .route("/api/sd-status", get(sd_status))
        .layer(Extension(service))
}
async fn local(
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    request: Request,
    next: Next,
) -> Response {
    if !crate::security::is_direct_local(&headers, peer.ip()) {
        return ApiError::new(403, "LOCAL_ONLY", "此操作仅限本机").into_response();
    }
    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    response
}
async fn action(
    Extension(s): Extension<Arc<ControlService>>,
    Path(service): Path<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    let action = body["action"].as_str().unwrap_or("");
    if !matches!(
        service.as_str(),
        "webui" | "comfy" | "voice" | "ollama" | "llama"
    ) || if service == "ollama" {
        action != "unload"
    } else if service == "llama" {
        action != "stop"
    } else {
        !matches!(action, "start" | "stop")
    } {
        return Err(ApiError::invalid("不支持的服务操作"));
    }
    Ok(Json(s.launch(format!("{service}-{action}"))?))
}
async fn mode(
    Extension(s): Extension<Arc<ControlService>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    let mode = body["mode"].as_str().unwrap_or("");
    if !matches!(mode, "draw" | "chat") {
        return Err(ApiError::invalid("mode 必须是 draw 或 chat"));
    }
    Ok(Json(s.launch(format!("mode-{mode}"))?))
}
async fn start(
    State(state): State<crate::AppState>,
    Extension(s): Extension<Arc<ControlService>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>> {
    if body["enableTunnel"] == false {
        return Ok(Json(json!({"ok":true,"message":"公网分享保持关闭"})));
    }
    let service = s.clone();
    s.tasks
        .spawn(async move { service.start_tunnel(state, false).await })
        .await
        .map_err(|_| ApiError::new(503, "SHARE_START_INTERRUPTED", "好友试玩启动中断"))??;
    Ok(Json(json!({"ok":true,"message":"公网分享通道已请求启动"})))
}
async fn stop(Extension(s): Extension<Arc<ControlService>>) -> Result<Json<Value>> {
    let service = s.clone();
    s.tasks
        .spawn(async move { service.stop_tunnel_request(true).await })
        .await
        .map_err(|_| ApiError::new(503, "SHARE_STOP_INTERRUPTED", "好友试玩停止中断"))??;
    Ok(Json(json!({"ok":true,"message":"公网分享通道已停止"})))
}
async fn build(Extension(s): Extension<Arc<ControlService>>) -> Result<Json<Value>> {
    if std::env::var("AICS_DESKTOP_PACKAGED").as_deref() == Ok("1") {
        return Err(ApiError::new(
            501,
            "DESKTOP_MAINTENANCE_UNAVAILABLE",
            "桌面应用模式不包含构建工具，请在源码环境构建",
        ));
    }
    let op = s.begin("build-web", &["正在构建前端"])?;
    let started = Instant::now();
    // Fixed arguments only; no request data is ever interpreted by the shell.
    let mut command = if cfg!(windows) {
        let mut c = tokio::process::Command::new("cmd.exe");
        c.args(["/d", "/s", "/c", "npm run build"]);
        c
    } else {
        let mut c = tokio::process::Command::new("npm");
        c.args(["run", "build"]);
        c
    };
    command
        .current_dir(&s.config.app_root)
        .env("NODE_ENV", "production")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let service = s.clone();
    let operation = op.clone();
    let task = s.tasks.spawn(async move {
        let result = service.run_command(command, 600).await.map(|_| ());
        let error = result
            .as_ref()
            .err()
            .map(|e| (e.status.as_u16(), e.code.clone(), e.message.clone()));
        service.finish(&operation, result);
        error
    });
    if let Some((status, code, message)) = task
        .await
        .map_err(|_| ApiError::new(503, "BUILD_FAILED", "构建任务异常退出"))?
    {
        return Err(ApiError::new(status, code, message));
    }
    let status = web_build::after_build(&s).await;
    Ok(Json(
        json!({"ok":true,"durationMs":started.elapsed().as_millis(),"tail":"","webBuild":status}),
    ))
}
async fn sd_status(Extension(s): Extension<Arc<ControlService>>) -> Response {
    let host = s
        .runtime_setting("sdHost")
        .as_str()
        .unwrap_or("")
        .to_string();
    let (models, samplers, schedulers, upscalers, options) = tokio::join!(
        s.request(&host, "/sdapi/v1/sd-models", None, 5),
        s.request(&host, "/sdapi/v1/samplers", None, 5),
        s.request(&host, "/sdapi/v1/schedulers", None, 5),
        s.request(&host, "/sdapi/v1/upscalers", None, 5),
        s.request(&host, "/sdapi/v1/options", None, 5)
    );
    let online = models
        .as_ref()
        .is_ok_and(|(status, _)| (200..300).contains(status));
    let names = |response: Result<(u16, Option<Value>)>, keys: &[&str]| -> Vec<Value> {
        response
            .ok()
            .and_then(|(_, v)| v)
            .and_then(|v| match v {
                Value::Array(items) => Some(items),
                _ => None,
            })
            .unwrap_or_default()
            .into_iter()
            .filter_map(|mut value| {
                let key = keys.iter().copied().find(|key| {
                    value
                        .get(*key)
                        .is_some_and(|v| v.as_str().is_some_and(|s| !s.is_empty()))
                });
                if let Some(key) = key {
                    Some(value[key].take())
                } else {
                    match value {
                        Value::String(text) if !text.is_empty() => Some(Value::String(text)),
                        _ => None,
                    }
                }
            })
            .collect()
    };
    let mut value = json!({"online":online,"host":host,"models":null,"samplers":null,"schedulers":null,"upscalers":null,"checkpoint":options.ok().and_then(|(_,v)|v).and_then(|v|v["sd_model_checkpoint"].as_str().map(str::to_owned)).unwrap_or_default(),"error":if online{String::new()}else{format!("SD WebUI 未响应（{host}）")}});
    value["models"] = Value::Array(if online {
        names(models, &["title", "model_name", "name"])
    } else {
        vec![]
    });
    value["samplers"] = Value::Array(names(samplers, &["name"]));
    value["schedulers"] = Value::Array(names(schedulers, &["name", "label"]));
    value["upscalers"] = Value::Array(names(upscalers, &["name"]));
    let mut response = Json(value).into_response();
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-store"));
    response
}
