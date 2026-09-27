mod backup;
pub mod blueprints;
pub mod cli;
mod codec;
mod colors;
mod commands;
mod content_products;
mod context;
mod contracts;
pub(crate) mod fs;
mod identity;
pub mod journal;
mod preview;
mod prompt;
pub mod recovery;
mod recovery_claim;
mod save;
pub(crate) mod scenes;
pub mod semantics;
mod showcase;
pub(crate) mod state;
#[cfg(test)]
mod tests;
pub mod transaction;
mod validation;

use crate::{AppState, config::Config, security};
use axum::{
    Extension, Json, Router,
    body::{Body, Bytes, to_bytes},
    extract::{ConnectInfo, DefaultBodyLimit, OriginalUri, Request, State},
    http::{HeaderMap, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, post},
};
pub use context::Options;
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};

pub type Result<T> = std::result::Result<T, Error>;
#[derive(Debug)]
pub struct Error {
    pub status: StatusCode,
    pub code: String,
    pub message: String,
    pub extra: Box<Value>,
}
impl Error {
    fn new(status: u16, code: &str, message: impl Into<String>) -> Self {
        Self {
            status: StatusCode::from_u16(status).unwrap_or(StatusCode::CONFLICT),
            code: code.into(),
            message: message.into(),
            extra: Box::new(json!({})),
        }
    }
    fn path(message: impl Into<String>) -> Self {
        Self::new(409, "MAINTENANCE_PATH", message)
    }
    fn journal(message: impl Into<String>) -> Self {
        Self::new(409, "MAINTENANCE_INVALID_JOURNAL", message)
    }
    fn conflict(message: impl Into<String>) -> Self {
        Self::new(409, "MAINTENANCE_CONFLICT", message)
    }
    fn invalid(message: impl Into<String>) -> Self {
        Self::new(400, "MAINTENANCE_ARGUMENT", message)
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code, self.message)
    }
}
impl std::error::Error for Error {}
impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Self {
        Self::path(error.to_string())
    }
}
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        let mut value = json!({"ok":false,"error":self.message,"msg":self.message,"code":self.code,"recoveryRequired":false});
        if let Some(extra) = self.extra.as_object() {
            value.as_object_mut().unwrap().extend(extra.clone());
        }
        (self.status, [("cache-control", "no-store")], Json(value)).into_response()
    }
}
pub struct MaintenanceService {
    options: Options,
    packaged: bool,
    cache: Mutex<Option<(u64, Bytes)>>,
    hero: Mutex<Option<(std::time::Instant, Value)>>,
    write_slots: Arc<tokio::sync::Semaphore>,
    write_lock: Arc<tokio::sync::Mutex<()>>,
}
impl MaintenanceService {
    pub(crate) fn showcase_root(&self) -> Option<std::path::PathBuf> {
        self.options.showcase.clone()
    }
    pub fn new(config: &Config) -> Self {
        let showcase = showcase::root(config);
        Self {
            options: Options {
                root: config.app_root.clone(),
                runtime: config.runtime_root.clone(),
                showcase,
            },
            packaged: std::env::var("AICS_DESKTOP_PACKAGED").as_deref() == Ok("1"),
            cache: Mutex::new(None),
            hero: Mutex::new(None),
            write_slots: Arc::new(tokio::sync::Semaphore::new(8)),
            write_lock: Arc::new(tokio::sync::Mutex::new(())),
        }
    }
    fn home_hero(&self) -> Value {
        let mut cache = self.hero.lock().unwrap();
        if let Some((at, value)) = &*cache
            && at.elapsed() < std::time::Duration::from_secs(5)
        {
            return value.clone();
        }
        let value = showcase::hero(self.options.showcase.as_deref());
        *cache = Some((std::time::Instant::now(), value.clone()));
        value
    }
    fn scene_state(&self) -> Result<Bytes> {
        let token = journal::read_token(&self.options)?;
        let version = state::version(&self.options.root)?;
        let mut cache = self.cache.lock().unwrap();
        if let Some((cached, value)) = &*cache
            && *cached == version
        {
            journal::assert_token(&self.options, &token)?;
            return Ok(value.clone());
        }
        let mut value = state::read(&self.options)?.value;
        value["ok"] = json!(true);
        value["writesEnabled"] = json!(true);
        let bytes = Bytes::from(
            serde_json::to_vec(&value).map_err(|_| Error::journal("维护快照序列化失败"))?,
        );
        *cache = Some((version, bytes.clone()));
        journal::assert_token(&self.options, &token)?;
        Ok(bytes)
    }
}
pub fn router(service: Arc<MaintenanceService>) -> Router<AppState> {
    Router::new()
        .route("/api/maintenance/recovery-status", get(status))
        .route("/api/maintenance/backups", get(backups))
        .route("/api/maintenance/scenes-state", get(scenes))
        .route(
            "/api/maintenance/scenes/preview",
            post(changes).layer(DefaultBodyLimit::max(20 * 1024 * 1024)),
        )
        .route(
            "/api/maintenance/scenes",
            post(save_content).layer(DefaultBodyLimit::max(20 * 1024 * 1024)),
        )
        .route(
            "/api/maintenance/scenes/import",
            post(save_content).layer(DefaultBodyLimit::max(20 * 1024 * 1024)),
        )
        .route(
            "/api/maintenance/scenes/changes",
            post(save_content).layer(DefaultBodyLimit::max(20 * 1024 * 1024)),
        )
        .route(
            "/api/maintenance/run",
            post(save_content).layer(DefaultBodyLimit::max(2 * 1024)),
        )
        .route(
            "/api/maintenance/showcase",
            post(save_content).layer(DefaultBodyLimit::max(26 * 1024 * 1024)),
        )
        .route(
            "/api/maintenance/home-hero",
            get(home_hero)
                .post(save_content)
                .layer(DefaultBodyLimit::max(26 * 1024 * 1024)),
        )
        .layer(Extension(service))
}
fn authorize(
    state: &AppState,
    service: &MaintenanceService,
    headers: &HeaderMap,
    peer: std::net::SocketAddr,
) -> Result<()> {
    if !security::is_direct_local(headers, peer.ip()) {
        return Err(Error::new(403, "LOCAL_ONLY", "维护操作仅允许在本机执行"));
    }
    state
        .host
        .check_available()
        .map_err(|error| Error::new(error.status.as_u16(), &error.code, error.message))?;
    let _ = service;
    Ok(())
}
fn source_only(service: &MaintenanceService) -> Result<()> {
    if service.packaged {
        Err(Error::new(
            501,
            "DESKTOP_MAINTENANCE_UNAVAILABLE",
            "桌面应用模式下场景内容编辑不可用（数据位于只读的应用包内）。请在源码开发模式中编辑场景内容。",
        ))
    } else {
        Ok(())
    }
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| Error::new(503, "MAINTENANCE_UNAVAILABLE", "维护读取暂不可用"))?
}
async fn status(
    State(app): State<AppState>,
    Extension(service): Extension<Arc<MaintenanceService>>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Result<Response> {
    authorize(&app, &service, &headers, peer)?;
    source_only(&service)?;
    let value=blocking(move||{let state=journal::inspect(&service.options);Ok(json!({"ok":state["status"]=="free","status":state["status"],"recoveryRequired":state["recoveryRequired"],"code":state["code"],"transactionId":state["journal"]["nonce"],"phase":state["journal"]["phase"],"backup":state["journal"]["backup"]["id"]}))}).await?;
    Ok(([("cache-control", "no-store")], Json(value)).into_response())
}
async fn backups(
    State(app): State<AppState>,
    Extension(service): Extension<Arc<MaintenanceService>>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Result<Response> {
    authorize(&app, &service, &headers, peer)?;
    let value = blocking(move || backup::list(&context::Context::new(&service.options)?)).await?;
    Ok(([("cache-control", "no-store")], Json(value)).into_response())
}
async fn scenes(
    State(app): State<AppState>,
    Extension(service): Extension<Arc<MaintenanceService>>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
) -> Result<Response> {
    authorize(&app, &service, &headers, peer)?;
    source_only(&service)?;
    let bytes = blocking(move || service.scene_state()).await?;
    Ok((
        [
            ("cache-control", "no-store"),
            ("content-type", "application/json; charset=utf-8"),
        ],
        bytes,
    )
        .into_response())
}
async fn changes(
    State(app): State<AppState>,
    Extension(service): Extension<Arc<MaintenanceService>>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    headers: HeaderMap,
    body: std::result::Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Result<Response> {
    authorize(&app, &service, &headers, peer)?;
    source_only(&service)?;
    let body = body.map_err(|error| {
        Error::new(
            error.status().as_u16(),
            "MAINTENANCE_ARGUMENT",
            "请求体无效或超过上限",
        )
    })?;
    let body: Value =
        serde_json::from_slice(&body).map_err(|_| Error::invalid("请求 JSON 格式错误"))?;
    let value = blocking(move || preview::run(&service.options, &body)).await?;
    Ok(([("cache-control", "no-store")], Json(value)).into_response())
}
async fn save_content(
    State(app): State<AppState>,
    Extension(service): Extension<Arc<MaintenanceService>>,
    ConnectInfo(peer): ConnectInfo<std::net::SocketAddr>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: std::result::Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Result<Response> {
    authorize(&app, &service, &headers, peer)?;
    let product = matches!(
        uri.path(),
        "/api/maintenance/showcase" | "/api/maintenance/home-hero"
    );
    if !product {
        source_only(&service)?;
    }
    let body = body.map_err(|error| {
        Error::new(
            error.status().as_u16(),
            "MAINTENANCE_ARGUMENT",
            "请求体无效或超过上限",
        )
    })?;
    let body: Value =
        serde_json::from_slice(&body).map_err(|_| Error::invalid("请求 JSON 格式错误"))?;
    let slot = service
        .write_slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::new(429, "MAINTENANCE_QUEUE_FULL", "维护保存队列已满"))?;
    let cancel = app.shutdown.child_token();
    let _cancel_on_drop = cancel.clone().drop_guard();
    let lock = tokio::select! {_ = cancel.cancelled()=>return Err(Error::new(499,"ABORT_ERR","维护保存已取消")),lock=service.write_lock.clone().lock_owned()=>lock};
    // The blocking transaction owns admission until it commits or completes
    // rollback, including when the HTTP future is dropped during disconnect.
    let admission = app
        .host
        .admit_owned()
        .map_err(|error| Error::new(error.status.as_u16(), &error.code, error.message))?;
    let import = !uri.path().ends_with("/changes");
    let value = blocking(move || {
        let _guards = (slot, lock, admission);
        *service.cache.lock().unwrap() = None;
        let result = if product {
            content_products::save(
                &service.options,
                &body,
                uri.path() == "/api/maintenance/home-hero",
                &cancel,
            )
        } else if uri.path() == "/api/maintenance/run" {
            commands::run(&service.options, &body, &cancel)
        } else {
            save::execute(&service.options, &body, import, &cancel)
        };
        *service.cache.lock().unwrap() = None;
        *service.hero.lock().unwrap() = None;
        result
    })
    .await?;
    Ok(([("cache-control", "no-store")], Json(value)).into_response())
}
async fn home_hero(Extension(service): Extension<Arc<MaintenanceService>>) -> Result<Response> {
    Ok(Json(blocking(move || Ok(service.home_hero())).await?).into_response())
}

/// Attach after authorization and before static/precompressed/reference serving.
/// Mutable content is buffered only in source mode, matching the old lease fence.
pub async fn read_barrier(
    State(service): State<Arc<MaintenanceService>>,
    request: Request,
    next: Next,
) -> Response {
    let path = percent_encoding::percent_decode_str(request.uri().path())
        .decode_utf8()
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();
    if service.packaged
        || !matches!(*request.method(), Method::GET | Method::HEAD)
        || ![
            "/data",
            "/scene-showcase",
            "/api/character-reference-profile",
            "/api/maintenance/home-hero",
        ]
        .iter()
        .any(|prefix| path == *prefix || path.starts_with(&format!("{prefix}/")))
    {
        return next.run(request).await;
    }
    let options = service.options.clone();
    let token = match blocking(move || journal::read_token(&options)).await {
        Ok(token) => token,
        Err(error) => return error.into_response(),
    };
    let response = next.run(request).await;
    let (parts, body) = response.into_parts();
    let bytes = match to_bytes(body, 64 * 1024 * 1024).await {
        Ok(bytes) => bytes,
        Err(_) => {
            return Error::new(
                503,
                "MAINTENANCE_READ_BLOCKED",
                "受保护文件超过维护读取缓冲上限或读取中断",
            )
            .into_response();
        }
    };
    let options = service.options.clone();
    if let Err(error) = blocking(move || journal::assert_token(&options, &token)).await {
        return error.into_response();
    }
    Response::from_parts(parts, Body::from(bytes))
}
