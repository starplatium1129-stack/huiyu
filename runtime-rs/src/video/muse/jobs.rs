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
use std::{collections::HashMap, net::SocketAddr};

async fn enrich_job(
    muse: &MuseVideo,
    service: &Service,
    owner: &str,
    job: &mut Value,
    cancel: &CancellationToken,
) {
    let Some(id) = job.get("id").and_then(Value::as_str).map(str::to_owned) else {
        return;
    };
    let available = job["resultAvailable"] == true
        || job
            .get("resultUrl")
            .and_then(Value::as_str)
            .is_some_and(|u| !u.is_empty());
    if !available {
        return;
    }
    job["resultUrl"] = json!(format!("/api/muse/video/jobs/{id}/result"));
    job["partBytes"] = json!(PART_BYTES);
    if let Ok(Output::File { path, mime, bytes }) = service.result(&id, owner).await {
        job["resultBytes"] = json!(bytes);
        job["resultMime"] = json!(mime);
        if let Ok((_, sha256)) =
            open_verified_video(muse, &service.config, path, bytes, cancel).await
        {
            job["resultSha256"] = json!(sha256);
        }
    }
}

pub(super) async fn create_job(
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
                .ok_or_else(|| ApiError::invalid("视频请求必须携带请求编号 requestKey"))?
                .to_owned();
            if let Some(object) = body.as_object_mut() {
                object.remove("requestKey");
            }
            let owner = generation::request_owner(&headers, peer, &query);
            let mut value = service
                .accept_request(requests::RequestInput::Job(body), key, owner.clone(), false)
                .await?;
            if let Some(job) = value.get_mut("job") {
                enrich_job(&muse, service, &owner, job, &state.shutdown).await;
            }
            Ok(value)
        }
        .await,
        StatusCode::ACCEPTED,
    )
}

pub(super) async fn get_job(
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
            let mut job = service.get_job(&id, &owner).await?;
            enrich_job(&muse, service, &owner, &mut job, &state.shutdown).await;
            Ok(json!({"job": job}))
        }
        .await,
        StatusCode::OK,
    )
}

pub(super) async fn cancel_job(
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
            let mut job = service.cancel(&id, &owner).await?;
            enrich_job(&muse, service, &owner, &mut job, &state.shutdown).await;
            Ok(json!({"job": job}))
        }
        .await,
        StatusCode::OK,
    )
}

pub(super) async fn job_request_status(
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
            let mut value = service.request_status(&key, &owner, requests::JOB).await?;
            if let Some(job) = value.get_mut("job") {
                enrich_job(&muse, service, &owner, job, &state.shutdown).await;
            }
            Ok(value)
        }
        .await,
        StatusCode::OK,
    )
}

pub(super) async fn cancel_job_request(
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
            service.cancel_request(&key, &owner, requests::JOB).await
        }
        .await,
        StatusCode::ACCEPTED,
    )
}

pub(super) async fn job_result(
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
        let output = service.result(&id, &owner).await?;
        serve_video_output(&state, &muse, service, output, &query, &headers, &method).await
    }
    .await
    {
        Ok(response) => response,
        Err(err) => err.into_response(),
    }
}
