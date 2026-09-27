mod overlay;
use super::{Error, Result, Service, Value, identifier, json};
use crate::{AppState, security};
use axum::{
    Extension, Router,
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, OriginalUri, Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
pub use overlay::overlay;
use std::{net::SocketAddr, sync::Arc};
pub fn router(service: Arc<Service>) -> Router<AppState> {
    Router::new()
        .route("/api/resources/status", get(status))
        .route("/api/resources/tasks", post(start))
        .route("/api/resources/tasks/{id}/cancel", post(cancel))
        .layer(DefaultBodyLimit::max(2 * 1024))
        .layer(Extension(service))
}
fn failure(error: Error, status: u16) -> Response {
    let safe = super::public(&error);
    (
        StatusCode::from_u16(status).unwrap(),
        [("cache-control", "no-store")],
        axum::Json(
            json!({"ok":false,"error":safe["message"],"msg":safe["message"],"code":safe["code"]}),
        ),
    )
        .into_response()
}
fn authorize(state: &AppState, headers: &HeaderMap, peer: SocketAddr) -> Result<()> {
    if !security::is_direct_local(headers, peer.ip())
        || !headers
            .get("host")
            .and_then(|value| value.to_str().ok())
            .is_some_and(security::host_allowed)
    {
        return Err(Error::new(
            "ACCESS_DENIED",
            "Local host authorization required",
        ));
    }
    state
        .host
        .check_available()
        .map_err(|error| Error::new(&error.code, error.message))
}
fn body(
    body: std::result::Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Result<Value> {
    let bytes = body.map_err(|_| Error::new("USAGE", "Invalid or oversized request"))?;
    if bytes.is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_slice(&bytes)
        .ok()
        .filter(Value::is_object)
        .ok_or_else(|| Error::new("USAGE", "JSON object required"))
}
async fn status(
    State(state): State<AppState>,
    Extension(service): Extension<Arc<Service>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Response {
    if let Err(error) = authorize(&state, &headers, peer) {
        return failure(error, 403);
    }
    let pairs =
        url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes()).collect::<Vec<_>>();
    if pairs.len() > 1
        || pairs
            .iter()
            .any(|(key, value)| key != "refresh" || value != "1")
    {
        return failure(Error::new("USAGE", "Invalid status query"), 400);
    }
    let refresh = !pairs.is_empty();
    match super::blocking(move || Ok(service.status(refresh))).await {
        Ok(value) => ([("cache-control", "no-store")], axum::Json(value)).into_response(),
        Err(error) => failure(error, 503),
    }
}
async fn start(
    State(state): State<AppState>,
    Extension(service): Extension<Arc<Service>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    raw: std::result::Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Response {
    if let Err(error) = authorize(&state, &headers, peer) {
        return failure(error, 403);
    }
    let body = match body(raw) {
        Ok(value) => value,
        Err(error) => return failure(error, 400),
    };
    let action = body["action"].as_str().unwrap_or("").to_owned();
    if uri.query().is_some_and(|query| !query.is_empty())
        || body
            .as_object()
            .unwrap()
            .keys()
            .any(|key| !["action", "releaseId"].contains(&key.as_str()))
        || !matches!(
            action.as_str(),
            "import" | "download" | "recover" | "rollback"
        )
        || if matches!(action.as_str(), "import" | "download") {
            body["releaseId"].as_str().is_none_or(|id| !identifier(id))
        } else {
            body.get("releaseId").is_some()
        }
    {
        return failure(
            Error::new("USAGE", "Select configured resource action and release"),
            400,
        );
    }
    let admission = match state.host.admit_owned() {
        Ok(guard) => guard,
        Err(error) => {
            return failure(
                Error::new(&error.code, error.message),
                error.status.as_u16(),
            );
        }
    };
    match super::blocking(move || service.start(&action, body["releaseId"].as_str(), admission))
        .await
    {
        Ok(task) => (
            StatusCode::ACCEPTED,
            [("cache-control", "no-store")],
            axum::Json(json!({"ok":true,"task":task})),
        )
            .into_response(),
        Err(error) => {
            let status = if matches!(error.code.as_str(), "BUSY" | "PENDING_TRANSACTION") {
                409
            } else {
                403
            };
            failure(error, status)
        }
    }
}
async fn cancel(
    State(state): State<AppState>,
    Extension(service): Extension<Arc<Service>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    headers: HeaderMap,
    raw: std::result::Result<Bytes, axum::extract::rejection::BytesRejection>,
) -> Response {
    if let Err(error) = authorize(&state, &headers, peer) {
        return failure(error, 403);
    }
    let body = match body(raw) {
        Ok(value) => value,
        Err(error) => return failure(error, 400),
    };
    if id.len() != 36
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte) || byte == b'-')
        || !body.as_object().unwrap().is_empty()
    {
        return failure(Error::new("USAGE", "Invalid task cancellation input"), 400);
    }
    match super::blocking(move || service.cancel(&id)).await {
        Ok(task) => (
            [("cache-control", "no-store")],
            axum::Json(json!({"ok":true,"task":task})),
        )
            .into_response(),
        Err(error) => failure(error, 409),
    }
}
