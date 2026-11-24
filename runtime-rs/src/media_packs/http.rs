use super::MediaPacksService;
use crate::{AppState, error::ApiError, security};
use axum::{
    Extension, Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde::Deserialize;
use serde_json::json;
use std::{net::SocketAddr, sync::Arc};

pub fn router(service: Arc<MediaPacksService>) -> Router<AppState> {
    Router::new()
        .route("/api/media-packs/status", get(status))
        .route("/api/media-packs/install", post(install))
        .route("/api/media-packs/cancel", post(cancel))
        .route("/api/media-packs/uninstall", post(uninstall))
        .route("/api/media-packs/settings", post(update_settings))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .layer(Extension(service))
}

fn authorize(state: &AppState, headers: &HeaderMap, peer: SocketAddr) -> Result<(), Response> {
    if !security::is_direct_local(headers, peer.ip())
        || !headers
            .get("host")
            .and_then(|value| value.to_str().ok())
            .is_some_and(security::host_allowed)
    {
        return Err(ApiError::new(403, "ACCESS_DENIED", "仅允许本机管理媒体资源包").into_response());
    }
    if let Err(error) = state.host.check_available() {
        return Err(error.into_response());
    }
    Ok(())
}

#[derive(Deserialize)]
struct StatusQuery {
    refresh: Option<String>,
}

async fn status(
    State(state): State<AppState>,
    Extension(service): Extension<Arc<MediaPacksService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(query): Query<StatusQuery>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = authorize(&state, &headers, peer) {
        return resp;
    }
    let refresh = query.refresh.as_deref() == Some("1");
    let body = service.status(refresh).await;
    ([("cache-control", "no-store")], Json(body)).into_response()
}

#[derive(Deserialize)]
struct InstallBody {
    packs: Vec<String>,
}

async fn install(
    State(state): State<AppState>,
    Extension(service): Extension<Arc<MediaPacksService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<InstallBody>,
) -> Response {
    if let Err(resp) = authorize(&state, &headers, peer) {
        return resp;
    }
    match service.start_install(body.packs).await {
        Ok(task) => (
            StatusCode::ACCEPTED,
            [("cache-control", "no-store")],
            Json(json!({ "ok": true, "task": task })),
        )
            .into_response(),
        Err((code, msg)) => {
            let status = if code == "BUSY" { 409 } else { 400 };
            ApiError::new(status, code, msg).into_response()
        }
    }
}

async fn cancel(
    State(state): State<AppState>,
    Extension(service): Extension<Arc<MediaPacksService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    if let Err(resp) = authorize(&state, &headers, peer) {
        return resp;
    }
    let task = service.cancel();
    ([("cache-control", "no-store")], Json(json!({ "ok": true, "task": task }))).into_response()
}

#[derive(Deserialize)]
struct UninstallBody {
    #[serde(rename = "packId")]
    pack_id: String,
}

async fn uninstall(
    State(state): State<AppState>,
    Extension(service): Extension<Arc<MediaPacksService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<UninstallBody>,
) -> Response {
    if let Err(resp) = authorize(&state, &headers, peer) {
        return resp;
    }
    match service.uninstall(&body.pack_id).await {
        Ok(()) => ([("cache-control", "no-store")], Json(json!({ "ok": true }))).into_response(),
        Err((code, msg)) => {
            let status = if code == "BUSY" { 409 } else { 400 };
            ApiError::new(status, code, msg).into_response()
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsBody {
    mirror_origin: Option<String>,
    manifest_url: Option<String>,
    onboarding_dismissed: Option<bool>,
}

async fn update_settings(
    State(state): State<AppState>,
    Extension(service): Extension<Arc<MediaPacksService>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<SettingsBody>,
) -> Response {
    if let Err(resp) = authorize(&state, &headers, peer) {
        return resp;
    }
    match service.update_settings(body.mirror_origin, body.manifest_url, body.onboarding_dismissed) {
        Ok(settings) => (
            [("cache-control", "no-store")],
            Json(json!({ "ok": true, "settings": settings })),
        )
            .into_response(),
        Err(msg) => ApiError::new(400, "INVALID_SETTINGS", msg).into_response(),
    }
}
