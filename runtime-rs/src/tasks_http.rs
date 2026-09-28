mod results;
#[cfg(test)]
mod tests;

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
        .layer(DefaultBodyLimit::max(256 * 1024))
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
    (
        error.status,
        Json(json!({"ok":false,"error":message,"msg":message,"code":error.code})),
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
    if let Some(runtime) = &state.tasks {
        runtime
            .ensure_recovered(&storage, &session.principal_id)
            .await?;
    }
    if !reading {
        let runtime = state.tasks.as_ref().ok_or_else(|| {
            ApiError::new(
                501,
                "TASK_PROVIDER_NOT_MIGRATED",
                "Task execution has not been migrated",
            )
        })?;
        let input: Value = if body.is_empty() {
            json!({})
        } else {
            serde_json::from_slice(body)?
        };
        let result = match (method.as_str(), path.as_slice()) {
            ("POST", []) => {
                runtime
                    .submit(storage.clone(), session.principal_id.clone(), input)
                    .await?
            }
            ("DELETE", [by_key, key]) if by_key == "by-key" => {
                runtime
                    .cancel(storage.clone(), session.principal_id.clone(), key.clone())
                    .await?
            }
            ("DELETE", [id]) => {
                let task = get(state, &storage, &session, id).await?;
                runtime
                    .cancel(
                        storage.clone(),
                        session.principal_id.clone(),
                        task["requestKey"]
                            .as_str()
                            .ok_or_else(invalid_record)?
                            .into(),
                    )
                    .await?
            }
            ("POST", [id, action]) if action == "reconcile" => {
                runtime
                    .reconcile(&storage, &session.principal_id, id)
                    .await?
            }
            ("POST", [id, action]) if action == "resume" => {
                runtime
                    .resume(storage.clone(), session.principal_id.clone(), id.clone())
                    .await?
            }
            ("POST", [id, action]) if ["concat", "continue"].contains(&action.as_str()) => {
                runtime
                    .action(
                        storage.clone(),
                        session.principal_id.clone(),
                        id.clone(),
                        action.clone(),
                    )
                    .await?
            }
            ("PATCH", [id, action]) if action == "delivery" => {
                crate::task_runtime::TaskRuntime::delivery(
                    &storage,
                    &session.principal_id,
                    id,
                    input["state"].as_str().unwrap_or(""),
                )
                .await?
            }
            _ => {
                return Err(ApiError::new(
                    501,
                    "TASK_PROVIDER_NOT_MIGRATED",
                    "This task action has not been migrated",
                ));
            }
        };
        return Ok(
            Json(json!({"ok":true,"result":result,"runtimeEpoch":storage.runtime_epoch()}))
                .into_response(),
        );
    }
    if let [id, result, index] = path.as_slice()
        && result == "results"
    {
        return Ok(results::read(state, &storage, &session, method, id, index)
            .await
            .unwrap_or_else(|error| {
                failure(
                    ApiError {
                        code: "TASK_RESULT_UNAVAILABLE".into(),
                        ..error
                    },
                    "结果读取未完成",
                )
            }));
    }
    let mut result = match path.as_slice() {
        [] => {
            let mut command = json!({"kind":"task.list"});
            for (key, value) in url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes()) {
                if !matches!(
                    key.as_ref(),
                    "before" | "afterRevision" | "throughRevision" | "limit"
                ) {
                    return Err(ApiError::invalid("Unknown task page parameter"));
                }
                let value: i64 = value
                    .parse()
                    .map_err(|_| ApiError::invalid("Invalid task page parameter"))?;
                command[key.as_ref()] = json!(value);
            }
            let mut list = request(state, &storage, &session, command).await?;
            let items = list["items"].as_array_mut().ok_or_else(invalid_record)?;
            for task in items {
                project_task(task, &session, state, &storage)?;
            }
            list
        }
        [name] if name == "legacy-history" => {
            request(
                state,
                &storage,
                &session,
                json!({"kind":"task.legacy-history"}),
            )
            .await?
        }
        [by_key, key] if by_key == "by-key" => {
            request(
                state,
                &storage,
                &session,
                json!({"kind":"task.get","requestKey":key}),
            )
            .await?
        }
        [id] => get(state, &storage, &session, id).await?,
        _ => {
            return Err(ApiError::new(
                404,
                "TASK_ROUTE",
                "Task route does not exist",
            ));
        }
    };
    if result.get("taskId").is_some() {
        project_task(&mut result, &session, state, &storage)?;
    }
    Ok(Json(json!({"ok":true,"result":result,"runtimeEpoch":storage.runtime_epoch(),"executionAvailable":state.tasks.is_some()})).into_response())
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

async fn get(state: &AppState, storage: &Storage, session: &Session, id: &str) -> Result<Value> {
    let task = request(
        state,
        storage,
        session,
        json!({"kind":"task.get","taskId":id}),
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
