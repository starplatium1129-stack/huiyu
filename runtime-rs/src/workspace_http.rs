mod commands;
mod media;
pub(crate) use media::range as media_range;
pub(crate) use media::stream as stream_media;

use crate::{
    AppState,
    error::{ApiError, Result},
};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, OriginalUri, State},
    http::{HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::any,
};
use commands::{Query, command, segments};
use serde_json::{Value, json};
use std::{net::SocketAddr, time::Duration};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/workspace", any(handle))
        .route("/api/workspace/{*path}", any(handle))
        .layer(DefaultBodyLimit::max(2 * 1024 * 1024))
}

async fn handle(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    OriginalUri(uri): OriginalUri,
    method: Method,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let allowed = state
        .host
        .allows_origin(&state, &headers, peer.ip(), &method);
    let mut response = perform(&state, peer, &uri, &method, &headers, &body)
        .await
        .unwrap_or_else(IntoResponse::into_response);
    let output = response.headers_mut();
    output.insert("cache-control", "private, no-store".parse().unwrap());
    output.insert("vary", "Origin".parse().unwrap());
    if allowed && let Some(origin) = headers.get("origin") {
        output.insert("access-control-allow-origin", origin.clone());
    }
    if method == Method::HEAD {
        *response.body_mut() = axum::body::Body::empty();
    }
    response
}

async fn perform(
    state: &AppState,
    peer: SocketAddr,
    uri: &Uri,
    method: &Method,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<Response> {
    state.host.check_available()?;
    let storage = state.host.storage().ok_or_else(|| {
        ApiError::new(
            503,
            "WORKSPACE_UNAVAILABLE",
            "Workspace has not been enabled",
        )
    })?;
    if method == Method::OPTIONS {
        if !state.host.allows_origin(state, headers, peer.ip(), method) {
            return Err(ApiError::new(
                403,
                "WORKSPACE_AUTH",
                "Workspace origin is not authorized",
            ));
        }
        return Ok((
            StatusCode::NO_CONTENT,
            [
                (
                    "access-control-allow-methods",
                    "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
                ),
                (
                    "access-control-allow-headers",
                    "Content-Type, x-aics-workspace-session, Range",
                ),
            ],
        )
            .into_response());
    }
    let path = segments(uri.path().strip_prefix("/api/workspace").unwrap_or(""))?;
    let query: Query = url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
        .into_owned()
        .collect();
    if path.first().map(String::as_str) == Some("media-content")
        && path.len() == 2
        && matches!(*method, Method::GET | Method::HEAD)
    {
        return media::serve(state, headers, peer.ip(), method, &path[1], &query).await;
    }
    let capability = path == ["media-capabilities"] && method == Method::POST;
    let scope = if path.first().map(String::as_str) == Some("backups") {
        "workspace:backup"
    } else if capability || matches!(*method, Method::GET | Method::HEAD) {
        "workspace:read"
    } else {
        "workspace:write"
    };
    let session = state
        .host
        .authenticate(state, headers, peer.ip(), method, scope)?;
    let input: Value = if body.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(body)?
    };
    if capability {
        return media::grant(state, session, &input).await;
    }
    let writing = !matches!(*method, Method::GET | Method::HEAD);
    let _admitted = if writing {
        Some(state.host.admit()?)
    } else {
        None
    };
    if writing {
        if input["protocolVersion"] != 1 {
            return Err(ApiError::new(
                409,
                "PROTOCOL_VERSION",
                "Workspace protocol version does not match",
            ));
        }
        if input["workspaceId"].as_str() != Some(session.workspace_id.as_str()) {
            return Err(ApiError::new(
                409,
                "WORKSPACE_IDENTITY",
                "Workspace identity does not match",
            ));
        }
    }
    let command = command(method, &path, &query, &input)?;
    if command["kind"] == "readMedia" {
        return media::chunk(state, method, &command).await;
    }
    let backup = matches!(command["kind"].as_str(), Some("backup" | "restoreBackup"));
    let operation_id = command.get("operationId").cloned();
    let result = tokio::time::timeout(
        Duration::from_secs(if backup { 120 } else { 30 }),
        storage.request(command, &session.principal_id),
    )
    .await;
    let result = match result {
        Ok(Ok(result)) => result,
        error => {
            let error = match error {
                Ok(Err(error)) => error,
                _ if operation_id.is_some() => ApiError::new(
                    504,
                    "COMMIT_UNKNOWN",
                    "Commit is unconfirmed; query the original operation ID before retrying",
                ),
                _ => ApiError::new(504, "WORKSPACE_TIMEOUT", "Workspace request timed out"),
            };
            return Ok((error.status, Json(json!({"ok": false, "error": error.message, "code": error.code, "operationId": operation_id}))).into_response());
        }
    };
    let mut envelope = json!({"ok": true, "result": null, "protocolVersion": 1, "workspaceId": storage.workspace_id(), "runtimeEpoch": storage.runtime_epoch()});
    envelope["result"] = result;
    Ok(Json(envelope).into_response())
}
