mod activation;
mod authority;

pub(crate) use authority::OwnedWriteGuard;
pub use authority::{HostAuthority, Session};

use crate::{
    AppState,
    error::{ApiError, Result},
};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::post,
};
use serde_json::{Value, json};
use std::net::SocketAddr;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/desktop-host", post(request))
        .layer(DefaultBodyLimit::max(16 * 1024))
}

async fn request(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let mut response = perform(&state, peer, &headers, &body).await.into_response();
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
}

async fn perform(
    state: &AppState,
    peer: SocketAddr,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<Json<Value>> {
    let input: Value = serde_json::from_slice(body)
        .map_err(|_| ApiError::new(400, "HOST_REQUEST", "Invalid desktop host request"))?;
    let secret = state
        .config
        .desktop_secret
        .as_deref()
        .ok_or_else(|| ApiError::new(401, "HOST_AUTH", "Desktop host is unavailable"))?;
    if !state.host.verify(secret, headers, peer.ip(), body, &input) {
        return Err(ApiError::new(
            401,
            "HOST_AUTH",
            "Desktop host authentication failed",
        ));
    }
    let window = input["windowId"].as_str().unwrap_or("");
    let origin = input["origin"].as_str().unwrap_or("");
    if !["atelier", "companion", "companion-chat"].contains(&window)
        || input["sourceProfileId"].as_str() != state.config.source_profile_id.as_deref()
        || !state.host.origin_registered(state, origin)
    {
        return Err(ApiError::new(
            403,
            "HOST_WINDOW",
            "Desktop window is not authorized",
        ));
    }
    let action = input["action"].as_str().unwrap_or("");
    if [
        "shutdown",
        "prepare-candidate",
        "activate",
        "enable-bundled",
    ]
    .contains(&action)
        && window != "atelier"
    {
        return Err(ApiError::new(
            403,
            "HOST_ROLE",
            "Desktop operation requires atelier",
        ));
    }
    if action == "shutdown" {
        let _closing = state.host.operation.lock().await;
        // Stop streamed chat/audio before waiting for their admitted HTTP bodies.
        // Storage remains open until accepted writes finish.
        state.shutdown.cancel();
        if let Some(tasks) = &state.tasks {
            tasks.close().await;
        }
        state.host.drain().await;
        if let Some(storage) = state.host.storage() {
            storage.close().await?;
        }
        return Ok(Json(json!({"closed": true})));
    }
    state.host.check_running()?;
    if ["prepare-candidate", "activate", "enable-bundled"].contains(&action) {
        let _operation = state.host.operation.try_lock().map_err(|_| {
            ApiError::new(
                409,
                "WORKSPACE_BUSY",
                "Another host operation is in progress",
            )
        })?;
        let _maintenance = state.host.maintenance()?;
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            state.host.wait_for_writes(),
        )
        .await
        .map_err(|_| {
            ApiError::new(
                504,
                "WORKSPACE_TIMEOUT",
                "Waiting for workspace writes timed out",
            )
        })?;
        match action {
            "prepare-candidate" => activation::prepare(state, &input["candidate"], origin).await?,
            "activate" => {
                activation::activate(
                    state,
                    input["migrationId"].as_str().ok_or_else(|| {
                        ApiError::new(400, "HOST_REQUEST", "Missing migration identity")
                    })?,
                    input["bundledUi"] == true,
                )
                .await?
            }
            _ => {
                let active = state.host.active().ok_or_else(|| {
                    ApiError::new(
                        409,
                        "MIGRATION_NOT_VERIFIED",
                        "No active verified migration",
                    )
                })?;
                let id = active["migrationId"].as_str().ok_or_else(|| {
                    ApiError::new(
                        409,
                        "MIGRATION_NOT_VERIFIED",
                        "No active verified migration",
                    )
                })?;
                activation::activate(state, id, true).await?;
            }
        }
    } else if action != "session" {
        return Err(ApiError::new(
            400,
            "HOST_REQUEST",
            "Unknown desktop host action",
        ));
    }
    let Some(storage) = state.host.storage() else {
        return Ok(Json(json!({"workspace": null})));
    };
    let session = state.host.issue(
        storage.workspace_id(),
        storage.runtime_epoch(),
        &format!(
            "desktop:{}",
            state.config.source_profile_id.as_deref().unwrap_or("")
        ),
        origin,
        window == "atelier",
    )?;
    let active = state.host.active();
    let pointer = active.as_ref();
    let mut workspace = serde_json::to_value(&session).expect("Session is serializable");
    workspace["activeMigrationId"] = pointer
        .and_then(|p| p.get("migrationId"))
        .cloned()
        .unwrap_or(Value::Null);
    workspace["domains"] = pointer
        .and_then(|p| p.get("domains"))
        .cloned()
        .unwrap_or(json!([]));
    workspace["generation"] = pointer
        .and_then(|p| p.get("generation"))
        .cloned()
        .unwrap_or(json!(0));
    workspace["bundledUi"] = pointer
        .and_then(|p| p.get("bundledUi"))
        .cloned()
        .unwrap_or(json!(false));
    Ok(Json(json!({"workspace": workspace})))
}
