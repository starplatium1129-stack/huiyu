mod actions;
mod queries;
mod qwen_inputs;
mod results;
mod studio_video;

use crate::{
    AppState,
    error::{ApiError, Result},
    host::Session,
    storage::Storage,
};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, OriginalUri, State},
    http::{HeaderMap, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
    routing::any,
};
use serde_json::{Value, json};
use std::{net::SocketAddr, time::Duration};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/tasks/v1", any(handle))
        .route("/api/tasks/v1/", any(handle))
        .route("/api/tasks/v1/{*path}", any(handle))
        .layer(DefaultBodyLimit::max(4 * 1024 * 1024))
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
        .unwrap_or_else(|error| failure(error, "任务请求未完成"));
    let output = response.headers_mut();
    output.insert("cache-control", "no-store".parse().unwrap());
    output.insert("vary", "Origin".parse().unwrap());
    if allowed && let Some(origin) = headers.get("origin") {
        output.insert("access-control-allow-origin", origin.clone());
    }
    if method == Method::HEAD {
        *response.body_mut() = axum::body::Body::empty();
    }
    response
}

fn failure(error: ApiError, message: &str) -> Response {
    let message = if error.submission_not_accepted && error.code == "TASK_PROVIDER_BUSY" {
        "另一项任务尚未结束，本次未接收；请完成或核对原任务后重试。"
    } else if error.submission_not_accepted {
        &error.message
    } else {
        message
    };
    (
        error.status,
        Json(json!({"ok":false,"error":message,"msg":message,"code":error.code,"submissionNotAccepted":error.submission_not_accepted})),
    )
        .into_response()
}

fn path_segments(uri: &Uri) -> Result<Vec<String>> {
    uri.path()
        .strip_prefix("/api/tasks/v1")
        .unwrap_or("")
        .trim_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .map(|part| {
            percent_encoding::percent_decode_str(part)
                .decode_utf8()
                .map(|part| part.into_owned())
                .map_err(|_| ApiError::new(400, "TASK_INVALID", "Invalid task path"))
        })
        .collect()
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
            "Task workspace is unavailable",
        )
    })?;
    if method == Method::OPTIONS {
        if !state.host.allows_origin(state, headers, peer.ip(), method) {
            return Err(ApiError::new(
                403,
                "WORKSPACE_AUTH",
                "Task origin is not authorized",
            ));
        }
        return Ok((
            StatusCode::NO_CONTENT,
            [
                (
                    "access-control-allow-methods",
                    "GET, HEAD, POST, PATCH, DELETE, OPTIONS",
                ),
                (
                    "access-control-allow-headers",
                    "Content-Type, x-aics-workspace-session",
                ),
            ],
        )
            .into_response());
    }
    let reading = matches!(*method, Method::GET | Method::HEAD);
    let session = state.host.authenticate(
        state,
        headers,
        peer.ip(),
        method,
        if reading {
            "workspace:read"
        } else {
            "workspace:write"
        },
    )?;
    // Capture one storage identity for the whole read, even if the host later
    // installs a new workspace. The session may never cross that boundary.
    if session.workspace_id != storage.workspace_id()
        || session.runtime_epoch != storage.runtime_epoch()
    {
        return Err(ApiError::new(
            401,
            "WORKSPACE_AUTH",
            "Task session no longer matches this workspace",
        ));
    }
    let path = path_segments(uri)?;
    if body.len() > 256 * 1024 && path.first().is_none_or(|part| part != "image-batches") {
        return Err(ApiError::new(
            413,
            "TASK_BODY_TOO_LARGE",
            "Task request is too large",
        ));
    }
    if path.first().is_some_and(|part| part == "studio-video") {
        return studio_video::route(state, &storage, &session, method, &path, body).await;
    }
    if path.first().is_some_and(|part| part == "companion-draw") {
        return actions::companion_draw(state, &storage, &session, peer, uri, method, headers, &path, body)
            .await;
    }
    if path.first().is_some_and(|part| part == "image-batches") {
        return actions::image_batch(state, &storage, &session, method, &path, body).await;
    }
    // Scoped reads and actions must remain reachable when another task's
    // recovery fails. In particular, persist cancellation before any probe.
    if path.is_empty()
        && (reading || *method == Method::POST)
        && let Some(runtime) = &state.tasks
    {
        if reading {
            runtime.start_recovery(storage.clone(), session.principal_id.clone())?;
            runtime
                .recover_image_batches(&storage, &session.principal_id)
                .await?;
        } else {
            runtime
                .ensure_recovered(&storage, &session.principal_id)
                .await
                .map_err(ApiError::not_accepted)?;
        }
    }
    if !reading {
        return actions::write(state, &storage, &session, method, &path, body).await;
    }
    queries::read(state, &storage, &session, uri, method, &path).await
}

async fn encode_response(envelope: Value) -> Result<Response> {
    // Idle delta polls are tiny and do not need an extra thread-pool hop.
    if envelope["result"]["items"]
        .as_array()
        .is_some_and(Vec::is_empty)
    {
        return Ok(Json(envelope).into_response());
    }
    // Both reads and actions return immutable inputs/checkpoints. Move the
    // response tree into the encoder rather than copying it on a request worker.
    tokio::task::spawn_blocking(move || Json(envelope).into_response())
        .await
        .map_err(|_| ApiError::new(503, "TASK_UNAVAILABLE", "Task response unavailable"))
}

fn invalid_record() -> ApiError {
    ApiError::new(503, "TASK_INVALID", "Task storage record is invalid")
}

fn project_task(
    task: &mut Value,
    session: &Session,
    state: &AppState,
    storage: &Storage,
) -> Result<()> {
    if task["principalId"] != session.principal_id || task["workspaceId"] != session.workspace_id {
        return Err(invalid_record());
    }
    if task["upstreamSettled"] != true
        && !state.tasks.as_ref().is_some_and(|runtime| {
            task["taskId"]
                .as_str()
                .is_some_and(|id| runtime.owns(storage, id))
        })
    {
        // A persisted running status is not evidence of execution in this process.
        // Projection is read-only: no reconciliation, cancellation or resubmission.
        task["recoveryState"] = json!("unknown");
        task["executionAvailable"] = json!(false);
        if task["errorCode"].is_null() {
            task["errorCode"] = json!("TASK_PROVIDER_NOT_MIGRATED");
        }
    }
    Ok(())
}

async fn get(
    state: &AppState,
    storage: &Storage,
    session: &Session,
    id: &str,
    summary: bool,
) -> Result<Value> {
    let task = request(
        state,
        storage,
        session,
        json!({"kind":"task.get","taskId":id,"summary":summary}),
    )
    .await?;
    if task.is_null() {
        return Err(ApiError::new(404, "TASK_NOT_FOUND", "Task does not exist"));
    }
    if task["principalId"] != session.principal_id || task["workspaceId"] != session.workspace_id {
        return Err(invalid_record());
    }
    Ok(task)
}

async fn request(
    state: &AppState,
    storage: &Storage,
    session: &Session,
    command: Value,
) -> Result<Value> {
    tokio::select! {
        response = tokio::time::timeout(Duration::from_secs(30), storage.request(command, &session.principal_id)) =>
            response.map_err(|_| ApiError::new(504, "TASK_TIMEOUT", "Task read timed out"))?,
        _ = state.shutdown.cancelled() => Err(ApiError::new(503, "DESKTOP_DRAINING", "Desktop is draining")),
    }
}
