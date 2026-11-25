use super::super::*;
use super::{
    MuseVideo, PART_BYTES,
    media::{open_verified_video, serve_video_output},
    response, video_service,
};
use crate::AppState;
use axum::{
    Extension, Json,
    extract::{ConnectInfo, Path, Query, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
};
use serde::Deserialize;
use std::{collections::HashMap, net::SocketAddr};

async fn enrich_batch(
    muse: &MuseVideo,
    service: &Service,
    owner: &str,
    batch: &mut Value,
    cancel: &CancellationToken,
) {
    if let Some(shots) = batch.get_mut("shots").and_then(Value::as_array_mut) {
        for shot in shots {
            if let Some(url) = shot.get("resultUrl").and_then(Value::as_str)
                && let Some(suffix) = url.strip_prefix("/api/video/jobs/")
            {
                shot["resultUrl"] = json!(format!("/api/muse/video/jobs/{suffix}"));
            }
        }
    }
    let Some(id) = batch.get("id").and_then(Value::as_str).map(str::to_owned) else {
        return;
    };
    if batch["concatAvailable"] == true {
        batch["concatUrl"] = json!(format!("/api/muse/video/batches/{id}/result"));
        batch["partBytes"] = json!(PART_BYTES);
        if let Ok(Output::File { path, mime, bytes }) = service.batch_result(&id, owner).await {
            batch["concatBytes"] = json!(bytes);
            batch["concatMime"] = json!(mime);
            if let Ok((_, sha256)) =
                open_verified_video(muse, &service.config, path, bytes, cancel).await
            {
                batch["concatSha256"] = json!(sha256);
            }
        }
    }
}

pub(super) async fn create_batch(
    State(state): State<AppState>,
    Extension(muse): Extension<Arc<MuseVideo>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(mut body): Json<Value>,
) -> Response {
    if let Some(limited) = muse.job_limit.check(false) {
        return limited;
    }
    response(
        async {
            state.host.check_running()?;
            let service = video_service(&state)?;
            let key = body
                .get("requestKey")
                .and_then(Value::as_str)
                .ok_or_else(|| ApiError::invalid("分镜批次请求必须携带请求编号 requestKey"))?
                .to_owned();
            if let Some(object) = body.as_object_mut() {
                object.remove("requestKey");
            }
            let owner = generation::request_owner(&headers, peer, &query);
            let mut value = service
                .accept_request(requests::RequestInput::Batch(body), key, owner.clone(), false)
                .await?;
            if let Some(batch) = value.get_mut("batch") {
                enrich_batch(&muse, service, &owner, batch, &state.shutdown).await;
            }
            Ok(value)
        }
        .await,
        StatusCode::ACCEPTED,
    )
}

pub(super) async fn get_batch(
    State(state): State<AppState>,
    Extension(muse): Extension<Arc<MuseVideo>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if let Some(limited) = muse.query_limit.check(false) {
        return limited;
    }
    response(
        async {
            state.host.check_running()?;
            let service = video_service(&state)?;
            let owner = generation::request_owner(&headers, peer, &query);
            let mut batch = service.get_batch(&id, &owner).await?;
            enrich_batch(&muse, service, &owner, &mut batch, &state.shutdown).await;
            Ok(json!({"batch": batch}))
        }
        .await,
        StatusCode::OK,
    )
}

pub(super) async fn cancel_batch(
    State(state): State<AppState>,
    Extension(muse): Extension<Arc<MuseVideo>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    response(
        async {
            state.host.check_running()?;
            let service = video_service(&state)?;
            let owner = generation::request_owner(&headers, peer, &query);
            let mut batch = service.cancel_batch(&id, &owner).await?;
            enrich_batch(&muse, service, &owner, &mut batch, &state.shutdown).await;
            Ok(json!({"batch": batch}))
        }
        .await,
        StatusCode::OK,
    )
}

pub(super) async fn concat_batch(
    State(state): State<AppState>,
    Extension(muse): Extension<Arc<MuseVideo>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if let Some(limited) = muse.job_limit.check(false) {
        return limited;
    }
    response(
        async {
            state.host.check_running()?;
            let service = video_service(&state)?;
            let cancel = service.shutdown.child_token();
            let _guard = cancel.clone().drop_guard();
            let owner = generation::request_owner(&headers, peer, &query);
            let mut batch = service
                .clone()
                .batch_action(&id, &owner, "concat", cancel)
                .await?;
            enrich_batch(&muse, service, &owner, &mut batch, &state.shutdown).await;
            Ok(json!({"batch": batch}))
        }
        .await,
        StatusCode::OK,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct RetrySelection {
    indices: Vec<usize>,
    request_key: String,
}

pub(super) async fn retry_batch(
    State(state): State<AppState>,
    Extension(muse): Extension<Arc<MuseVideo>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(selection): Json<RetrySelection>,
) -> Response {
    if let Some(limited) = muse.job_limit.check(false) {
        return limited;
    }
    response(
        async {
            state.host.check_running()?;
            let service = video_service(&state)?;
            let indices = selection
                .indices
                .into_iter()
                .map(|index| {
                    index
                        .checked_sub(1)
                        .ok_or_else(|| error(400, "SHOT_INDEX_INVALID", "分镜序号无效"))
                })
                .collect::<Result<Vec<_>>>()?;
            let owner = generation::request_owner(&headers, peer, &query);
            let mut value = service
                .accept_request(
                    requests::RequestInput::Retry {
                        batch_id: id,
                        indices,
                    },
                    selection.request_key,
                    owner.clone(),
                    false,
                )
                .await?;
            if let Some(batch) = value.get_mut("batch") {
                enrich_batch(&muse, service, &owner, batch, &state.shutdown).await;
            }
            Ok(value)
        }
        .await,
        StatusCode::ACCEPTED,
    )
}

pub(super) async fn batch_request_status(
    State(state): State<AppState>,
    Extension(muse): Extension<Arc<MuseVideo>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(key): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    if let Some(limited) = muse.query_limit.check(false) {
        return limited;
    }
    response(
        async {
            state.host.check_running()?;
            let service = video_service(&state)?;
            let owner = generation::request_owner(&headers, peer, &query);
            let mut value = service.request_status(&key, &owner, requests::BATCH).await?;
            if let Some(batch) = value.get_mut("batch") {
                enrich_batch(&muse, service, &owner, batch, &state.shutdown).await;
            }
            Ok(value)
        }
        .await,
        StatusCode::OK,
    )
}

pub(super) async fn cancel_batch_request(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(key): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    response(
        async {
            state.host.check_running()?;
            let service = video_service(&state)?;
            let owner = generation::request_owner(&headers, peer, &query);
            service.cancel_request(&key, &owner, requests::BATCH).await
        }
        .await,
        StatusCode::ACCEPTED,
    )
}

pub(super) async fn batch_result(
    State(state): State<AppState>,
    Extension(muse): Extension<Arc<MuseVideo>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    method: Method,
) -> Response {
    match async {
        state.host.check_running()?;
        let service = video_service(&state)?;
        let owner = generation::request_owner(&headers, peer, &query);
        let output = service.batch_result(&id, &owner).await?;
        serve_video_output(&state, &muse, service, output, &query, &headers, &method).await
    }
    .await
    {
        Ok(response) => response,
        Err(err) => err.into_response(),
    }
}
