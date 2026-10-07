mod derive;
mod store;
#[cfg(test)]
mod tests;
use crate::{
    AppState,
    error::{ApiError, Result},
    security,
};
use axum::{
    Extension, Json, Router,
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, Path, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::Value;
use std::{
    net::SocketAddr,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio_util::sync::CancellationToken;

struct Service {
    writes: Arc<tokio::sync::Semaphore>,
}
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/maintenance/character-art", get(manifest).post(save))
        .route("/api/character-art/{id}/{revision}/{file}", get(asset))
        .layer(DefaultBodyLimit::max(21 * 1024 * 1024))
        .layer(Extension(Arc::new(Service {
            writes: Arc::new(tokio::sync::Semaphore::new(1)),
        })))
}
fn authorize(app: &AppState, headers: &HeaderMap, peer: SocketAddr) -> Result<()> {
    if !security::is_direct_local(headers, peer.ip()) {
        return Err(ApiError::new(403, "LOCAL_ONLY", "头像维护仅允许本机访问"));
    }
    app.host.check_available()
}
fn invalid(message: &str) -> ApiError {
    ApiError::new(400, "CHARACTER_ART_INVALID", message)
}
fn corrupt() -> ApiError {
    ApiError::new(503, "CHARACTER_ART_CORRUPT", "头像数据损坏，请恢复备份")
}
fn check(cancel: &CancellationToken, started: Instant) -> Result<()> {
    if cancel.is_cancelled() {
        return Err(ApiError::new(499, "ABORT_ERR", "头像保存已取消"));
    }
    if started.elapsed() > Duration::from_secs(30) {
        return Err(ApiError::new(504, "CHARACTER_ART_TIMEOUT", "头像处理超时"));
    }
    Ok(())
}
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(work)
        .await
        .map_err(|_| corrupt())?
}
async fn manifest(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Response> {
    authorize(&app, &headers, peer)?;
    let value =
        blocking(move || store::read(&app.config.runtime_root.join("character-art"))).await?;
    Ok(([("cache-control", "no-store")], Json(value)).into_response())
}
async fn save(
    State(app): State<AppState>,
    Extension(service): Extension<Arc<Service>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response> {
    authorize(&app, &headers, peer)?;
    let permit = service
        .writes
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::new(409, "CHARACTER_ART_BUSY", "另一项头像保存正在执行"))?;
    let admission = app.host.admit_owned()?;
    let cancel = app.shutdown.child_token();
    let _drop = cancel.clone().drop_guard();
    let value = blocking(move || {
        let _guards = (permit, admission);
        // Upload bodies can reach 21 MiB; parsing belongs with the image work.
        let body: Value = serde_json::from_slice(&body).map_err(|_| invalid("无效 JSON"))?;
        store::save(&app.config, &body, &cancel)
    })
    .await?;
    Ok(([("cache-control", "no-store")], Json(value)).into_response())
}
async fn asset(
    State(app): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path((id, revision, file)): Path<(String, String, String)>,
) -> Result<Response> {
    authorize(&app, &headers, peer)?;
    let (bytes, mime) = blocking(move || {
        store::asset(
            &app.config.runtime_root.join("character-art"),
            &id,
            &revision,
            &file,
        )
    })
    .await?;
    Ok((
        [
            ("cache-control", "private, no-store"),
            ("content-type", mime),
            ("x-content-type-options", "nosniff"),
        ],
        bytes,
    )
        .into_response())
}
