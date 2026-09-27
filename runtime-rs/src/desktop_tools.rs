mod commands;
mod draft;
mod files;
mod paths;
#[cfg(test)]
mod tests;

use crate::{AppState, config::Config, processes::Processes, security};
use axum::{
    Extension, Json, Router,
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use serde_json::{Value, json};
use std::{net::SocketAddr, path::PathBuf, sync::Arc};
use tokio_util::sync::CancellationToken;

type Result<T> = std::result::Result<T, Error>;
#[derive(Debug)]
struct Error {
    code: Option<String>,
    message: String,
}
impl Error {
    fn plain(message: impl Into<String>) -> Self {
        Self {
            code: None,
            message: message.into(),
        }
    }
    fn coded(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: Some(code.into()),
            message: message.into(),
        }
    }
    fn cancelled() -> Self {
        Self::coded("ABORT_ERR", "工具操作已取消")
    }
    fn value(self) -> Value {
        let message = files::truncate(&self.message, 2000);
        let mut output = json!({"ok":false,"output":message,"error":message,"msg":message});
        if let Some(code) = self.code {
            output["code"] = code.into();
        }
        output
    }
}
impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::plain(error.to_string())
    }
}
impl From<crate::error::ApiError> for Error {
    fn from(error: crate::error::ApiError) -> Self {
        Self::coded(&error.code, error.message)
    }
}

pub struct DesktopToolsService {
    root: PathBuf,
    trusted: bool,
    processes: Arc<Processes>,
    shutdown: CancellationToken,
}
impl DesktopToolsService {
    pub fn new(config: &Config, shutdown: CancellationToken) -> Self {
        Self {
            root: config.ai_workspace_root.clone(),
            trusted: std::env::var("AICS_DESKTOP_COMMANDS").as_deref() == Ok("trusted"),
            processes: Arc::new(Processes::default()),
            shutdown,
        }
    }
    pub async fn close(&self) {
        self.shutdown.cancel();
        self.processes.close().await;
    }
    async fn run(&self, name: &str, args: &Value, adult_enabled: bool) -> Result<Value> {
        if self.shutdown.is_cancelled() {
            return Err(Error::cancelled());
        }
        let result = match name {
            "list_files" => files::list(&self.root, args).await,
            "read_file" => files::read(&self.root, args).await,
            "write_file" => files::write(&self.root, args, &self.shutdown).await,
            "read_image" => files::image(&self.root, args).await,
            "run_command" => {
                commands::run(
                    &self.root,
                    args,
                    self.trusted,
                    &self.processes,
                    &self.shutdown,
                )
                .await
            }
            "capture_screen" => commands::screen(&self.processes, &self.shutdown).await,
            "get_workspace_info" => Ok(
                json!({"ok":true,"output":crate::storage::stringify(&json!({"workspaceRoot":paths::display(&self.root),"exists":self.root.exists(),"os":if cfg!(windows){"win32"}else{std::env::consts::OS},"commandMode":if self.trusted{"trusted-system-account"}else{"disabled"}}))}),
            ),
            "generate_character_image" => {
                draft::prepare(&self.root, args, adult_enabled, &self.shutdown).await
            }
            _ => Err(Error::plain(format!("未知工具：{name}"))),
        };
        if self.shutdown.is_cancelled() {
            return Err(Error::cancelled());
        }
        result
    }
}
pub fn router(service: Arc<DesktopToolsService>) -> Router<AppState> {
    Router::new()
        .route("/api/desktop-tools", post(execute))
        .layer(DefaultBodyLimit::max(768 * 1024))
        .layer(Extension(service))
}
async fn execute(
    State(state): State<AppState>,
    Extension(service): Extension<Arc<DesktopToolsService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: std::result::Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Response {
    if !security::is_direct_local(&headers, peer.ip()) {
        return (
            StatusCode::FORBIDDEN,
            Json(Error::coded("LOCAL_ONLY", "此操作仅允许在本机执行").value()),
        )
            .into_response();
    }
    if let Err(error) = state.host.check_available() {
        return error.into_response();
    }
    let body = match body {
        Ok(body) => body,
        Err(error) => {
            return (
                error.status(),
                Json(
                    Error::plain(if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
                        "请求体过大"
                    } else {
                        "请求无法处理"
                    })
                    .value(),
                ),
            )
                .into_response();
        }
    };
    let payload: Value = match serde_json::from_slice(&body) {
        Ok(payload) => payload,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(Error::plain("请求 JSON 格式错误").value()),
            )
                .into_response();
        }
    };
    let name = payload["name"].as_str().unwrap_or("");
    if name.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(Error::plain("缺少工具名").value()),
        )
            .into_response();
    }
    let empty = json!({});
    let args = if payload["args"].is_object() {
        &payload["args"]
    } else {
        &empty
    };
    // File I/O and commands stay owned by the request future. A disconnected
    // caller drops that future, invoking temporary-file/process cleanup guards.
    let result = service
        .run(name, args, payload["adultEnabled"] == true)
        .await;
    Json(result.unwrap_or_else(Error::value)).into_response()
}
fn text(value: &Value) -> String {
    match value {
        Value::Null | Value::Bool(false) => String::new(),
        Value::Number(value) if value.as_f64() == Some(0.0) => String::new(),
        Value::String(value) => value.clone(),
        Value::Object(_) => "[object Object]".into(),
        Value::Array(value) => value.iter().map(text).collect::<Vec<_>>().join(","),
        value => crate::storage::stringify(value),
    }
}
