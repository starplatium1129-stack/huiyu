mod compatible;
mod completion;
mod local_persona;
mod ollama;
mod persona;
mod settings;
mod stream;
#[cfg(test)]
mod tests;
mod transport;
mod validation;

use crate::{AppState, security};
use axum::{
    Extension, Json, Router,
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use std::{net::SocketAddr, sync::Arc, time::Duration};
use tokio::sync::OnceCell;

type Result<T> = std::result::Result<T, Error>;
#[derive(Debug)]
struct Error {
    status: StatusCode,
    code: String,
    message: String,
    detail: String,
}
impl Error {
    fn new(status: u16, code: &str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::from_u16(status).unwrap_or(StatusCode::SERVICE_UNAVAILABLE),
            code: code.into(),
            message: message.into(),
            detail: String::new(),
        }
    }
    fn invalid(message: impl Into<String>) -> Self {
        Self::new(400, "INVALID_REQUEST", message)
    }
    fn stream(code: &str, message: &str) -> Self {
        Self::new(503, code, message)
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.status, Json(json!({"ok":false,"error":self.message,"msg":self.message,"code":self.code,"detail":self.detail}))).into_response()
    }
}

pub struct ChatService {
    transport: transport::Transport,
    ollama: ollama::Ollama,
    settings: OnceCell<settings::Settings>,
}
impl Default for ChatService {
    fn default() -> Self {
        Self::new()
    }
}
impl ChatService {
    pub fn new() -> Self {
        Self {
            transport: transport::Transport::new(),
            ollama: ollama::Ollama::new(),
            settings: OnceCell::new(),
        }
    }
    pub fn queue_status(&self) -> Value {
        self.ollama.queue_status()
    }
    async fn settings(&self, app: &AppState) -> &settings::Settings {
        self.settings
            .get_or_init(|| settings::Settings::read(&app.config))
            .await
    }
}

pub fn router(service: Arc<ChatService>) -> Router<AppState> {
    Router::new()
        .route("/api/chat-status", get(status))
        .route(
            "/api/chat",
            post(chat).layer(DefaultBodyLimit::max(14 * 1024 * 1024)),
        )
        .route(
            "/api/chat-provider/test",
            post(inspect).layer(DefaultBodyLimit::max(8 * 1024)),
        )
        .route(
            "/api/chat-provider/host-config",
            get(host_config)
                .post(save_host)
                .delete(delete_host)
                .layer(DefaultBodyLimit::max(8 * 1024)),
        )
        .layer(Extension(service))
}

async fn status(
    State(app): State<AppState>,
    Extension(chat): Extension<Arc<ChatService>>,
) -> Response {
    if let Err(error) = running(&app) {
        return error.into_response();
    }
    let data = chat
        .ollama
        .status(&chat.transport, chat.settings(&app).await)
        .await;
    let mut response = Json(data).into_response();
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
}

async fn chat(
    State(app): State<AppState>,
    Extension(chat): Extension<Arc<ChatService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: std::result::Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Response {
    let result = async {
        running(&app)?;
        let body = body.map_err(body_error)?;
        let body: Value = serde_json::from_slice(&body).map_err(|_| Error::invalid("请求 JSON 格式错误"))?;
        let direct = security::is_direct_local(&headers,peer.ip());
        let settings = chat.settings(&app).await;
        let persona = if direct { local_persona::read(settings,&app.config.app_root,body["character"].as_str().unwrap_or("nene")).await } else { None };
        let mut input = validation::chat(&body,persona.as_deref())?;
        input.tools &= direct;
        let prepared = tokio::select! {
            result = async {
                if input.api.is_some() { compatible::prepare(&chat.transport,settings,&input,!direct).await }
                else { chat.ollama.prepare(&chat.transport,settings,&input).await }
            } => result?,
            _ = app.shutdown.cancelled() => return Err(Error::new(503,"DESKTOP_DRAINING","桌面正在维护")),
        };
        Ok(stream::response(prepared,app.shutdown))
    }.await;
    result.unwrap_or_else(IntoResponse::into_response)
}

fn local(headers: &HeaderMap, peer: SocketAddr) -> Result<()> {
    if security::is_direct_local(headers, peer.ip()) {
        Ok(())
    } else {
        Err(Error::new(403, "LOCAL_ONLY", "此操作仅允许在本机执行"))
    }
}

fn running(app: &AppState) -> Result<()> {
    app.host
        .check_available()
        .map_err(|error| Error::new(error.status.as_u16(), &error.code, error.message))?;
    if app.shutdown.is_cancelled() {
        return Err(Error::new(503, "DESKTOP_DRAINING", "桌面正在维护"));
    }
    Ok(())
}

fn body_error(error: axum::extract::rejection::BytesRejection) -> Error {
    Error::new(
        error.status().as_u16(),
        "INVALID_REQUEST",
        if error.status() == StatusCode::PAYLOAD_TOO_LARGE {
            "请求体过大"
        } else {
            "请求无法处理"
        },
    )
}

async fn inspect(
    State(app): State<AppState>,
    Extension(chat): Extension<Arc<ChatService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: std::result::Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Response {
    let result = async {
        local(&headers, peer)?;
        let body = body.map_err(body_error)?;
        let api = validation::api(
            &serde_json::from_slice(&body).map_err(|_| Error::invalid("请求 JSON 格式错误"))?,
        )?;
        running(&app)?;
        let models = compatible::inspect(&chat.transport, &api)
            .await
            .map_err(|mut error| {
                if error.status.is_server_error() {
                    error.status = StatusCode::BAD_GATEWAY;
                }
                error
            })?;
        Ok::<Response, Error>(Json(models).into_response())
    };
    tokio::select! { result = result => result.unwrap_or_else(IntoResponse::into_response), _ = app.shutdown.cancelled() => Error::new(503,"DESKTOP_DRAINING","桌面正在维护").into_response() }
}

async fn host_config(
    State(app): State<AppState>,
    Extension(chat): Extension<Arc<ChatService>>,
) -> Response {
    if let Err(error) = running(&app) {
        return error.into_response();
    }
    let mut response = Json(settings::public(
        chat.settings(&app).await.read_host().await.as_ref(),
    ))
    .into_response();
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
}

async fn save_host(
    State(app): State<AppState>,
    Extension(chat): Extension<Arc<ChatService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: std::result::Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Response {
    let result = async {
        local(&headers, peer)?;
        let body = body.map_err(body_error)?;
        let _admitted = app
            .host
            .admit()
            .map_err(|error| Error::new(error.status.as_u16(), &error.code, error.message))?;
        let api = validation::api(
            &serde_json::from_slice(&body).map_err(|_| Error::invalid("请求 JSON 格式错误"))?,
        )?;
        chat.settings(&app).await.write_host(&api).await?;
        Ok::<Response, Error>(Json(settings::public(Some(&api))).into_response())
    }
    .await;
    result.unwrap_or_else(IntoResponse::into_response)
}

async fn delete_host(
    State(app): State<AppState>,
    Extension(chat): Extension<Arc<ChatService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let result = async {
        local(&headers, peer)?;
        let _admitted = app
            .host
            .admit()
            .map_err(|error| Error::new(error.status.as_u16(), &error.code, error.message))?;
        chat.settings(&app).await.delete_host().await?;
        Ok::<Response, Error>(Json(settings::public(None)).into_response())
    }
    .await;
    result.unwrap_or_else(IntoResponse::into_response)
}
