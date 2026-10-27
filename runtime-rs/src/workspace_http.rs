mod commands;
mod json;
mod media;
pub(crate) use media::download_opened;

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
    let mut response = perform(&state, peer, &uri, &method, &headers, body)
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
    body: Bytes,
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
        return media::serve(
            state,
            &storage,
            headers,
            peer.ip(),
            method,
            &path[1],
            &query,
        )
        .await;
    }
    let capability = path == ["media-capabilities"] && method == Method::POST;
    let scope = if path.first().map(String::as_str) == Some("backups")
        || (path.len() == 3
            && path[0] == "operations"
            && matches!(path[2].as_str(), "progress" | "cancel"))
    {
        "workspace:backup"
    } else if capability || matches!(*method, Method::GET | Method::HEAD) {
        "workspace:read"
    } else {
        "workspace:write"
    };
    let session = state
        .host
        .authenticate(state, headers, peer.ip(), method, scope)?;
    if session.workspace_id != storage.workspace_id()
        || session.runtime_epoch != storage.runtime_epoch()
    {
        return Err(ApiError::new(
            401,
            "WORKSPACE_AUTH",
            "Workspace session no longer matches this workspace",
        ));
    }
    if path.len() == 3
        && path[0] == "media"
        && path[2] == "content"
        && matches!(*method, Method::GET | Method::HEAD)
    {
        commands::text(&json!(&path[1]))?;
        return media::download(state, &storage, method, &path[1]).await;
    }
    if path == ["video-images"] && method == Method::POST {
        if body.len() > 4096 {
            return Err(ApiError::new(413, "INVALID_IMAGE", "图片导入请求过大"));
        }
        let input: crate::video::MediaImport = serde_json::from_slice(&body)?;
        let service = state
            .video
            .as_ref()
            .ok_or_else(|| ApiError::new(503, "VIDEO_UNAVAILABLE", "视频服务暂不可用"))?;
        let owner = crate::generation::request_owner(headers, peer, &query);
        let admission = state.host.admit_owned()?;
        return service
            .import_result(storage, session.principal_id, input, owner, admission)
            .await
            .map(|value| Json(value).into_response());
    }
    if path == ["anima-images"] && method == Method::POST {
        if body.len() > 4096 {
            return Err(ApiError::new(413, "INVALID_IMAGE", "图片导入请求过大"));
        }
        let input: crate::images::media_import::WorkspaceImage = serde_json::from_slice(&body)?;
        let service = state
            .images
            .as_ref()
            .ok_or_else(|| ApiError::new(503, "ANIMA_UNAVAILABLE", "图片服务暂不可用"))?;
        let owner = crate::generation::request_owner(headers, peer, &query);
        let admission = state.host.admit_owned()?;
        return service
            .import_workspace(storage, session.principal_id, input, owner, admission)
            .await
            .map(|value| Json(value).into_response());
    }
    if path == ["interrogate"] && method == Method::POST {
        crate::interrogate::local(headers, peer)?;
        if body.len() > 4096 {
            return Err(ApiError::new(413, "INVALID_IMAGE", "图片反推请求过大"));
        }
        let input: crate::interrogate::WorkspaceInput = serde_json::from_slice(&body)?;
        let service = state
            .interrogate
            .as_ref()
            .ok_or_else(|| ApiError::new(503, "INTERROGATE_UNAVAILABLE", "图片反推服务暂不可用"))?;
        let admission = state.host.admit_owned()?;
        return service
            .interrogate_workspace(storage, session.principal_id, input, admission)
            .await
            .map(|value| Json(value).into_response());
    }
    let writing = !matches!(*method, Method::GET | Method::HEAD);
    let _admitted = if writing && !capability {
        Some(state.host.admit()?)
    } else {
        None
    };
    let (command, chunk) = match json::prepare(
        body,
        method.clone(),
        path,
        query,
        capability,
        session.workspace_id.clone(),
        headers
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or(""),
    )
    .await?
    {
        json::Request::Capability(input) => {
            return media::grant(state, &storage, session, &input).await;
        }
        json::Request::Command(command) => (command, None),
        json::Request::Chunk(command, bytes) => (command, Some(bytes)),
    };
    let long_request = matches!(
        command["kind"].as_str(),
        Some("backup" | "restoreBackup" | "migration.verify")
    );
    let operation_id = command.get("operationId").cloned();
    let job_status = matches!(command["kind"].as_str(), Some("jobStatus" | "jobCancel"));
    let result = if job_status {
        storage.jobs.status(
            &session.principal_id,
            command["operationId"].as_str().unwrap_or(""),
            command["kind"] == "jobCancel",
        )
    } else if long_request {
        let admission = state.host.admit_owned()?;
        let owned = storage.clone();
        let principal = session.principal_id.clone();
        let input = command.clone();
        storage.jobs.start(
            &session.principal_id,
            command,
            state.shutdown.clone(),
            move |job| async move {
                let _admission = admission;
                owned.request_job(input, &principal, Some(job)).await
            },
        )
    } else {
        let result = tokio::time::timeout(
            Duration::from_secs(if command["kind"] == "restoreArtworks" {
                120
            } else {
                30
            }),
            async {
                match chunk {
                    Some(bytes) => {
                        storage
                            .upload_chunk(command, bytes, &session.principal_id)
                            .await
                    }
                    None => storage.request(command, &session.principal_id).await,
                }
            },
        )
        .await;
        result.unwrap_or_else(|_| {
            Err(ApiError::new(
                504,
                if operation_id.is_some() {
                    "COMMIT_UNKNOWN"
                } else {
                    "WORKSPACE_TIMEOUT"
                },
                "Workspace request timed out",
            ))
        })
    };
    let result = match result {
        Ok(result) => result,
        Err(error) => {
            return Ok((error.status, Json(json!({"ok": false, "error": error.message, "code": error.code, "operationId": operation_id}))).into_response());
        }
    };
    let mut envelope = json!({"ok": true, "result": null, "protocolVersion": 1, "workspaceId": storage.workspace_id(), "runtimeEpoch": storage.runtime_epoch()});
    envelope["result"] = result;
    // Profile archives and bulk workspace reads can contain megabytes of JSON.
    // Storage runs on its own worker; keep response encoding off the async
    // request worker as well, without occupying the serialized storage queue.
    json::encode(envelope).await.map_err(|error| {
        if error.code == "WORKSPACE_TIMEOUT" && operation_id.is_some() {
            ApiError::new(
                504,
                "COMMIT_UNKNOWN",
                "Commit is unconfirmed; query the original operation ID before retrying",
            )
        } else {
            error
        }
    })
}
