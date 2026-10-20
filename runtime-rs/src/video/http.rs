use super::*;
use crate::images::{
    upload_body::RawUploadBody,
};
use crate::{AppState, security};
use axum::{
    Extension, Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, OriginalUri, Path, Query, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use std::{collections::HashMap, net::SocketAddr};
struct Http {
    service: Arc<Service>,
}
pub(super) fn router(service: Arc<Service>) -> Router<AppState> {
    Router::new()
        .route("/api/video/status", get(status))
        .route(
            "/api/video/images/raw",
            post(upload_raw).layer(DefaultBodyLimit::max(20 * 1024 * 1024)),
        )
        .route(
            "/api/video/jobs",
            post(create).layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route("/api/video/jobs/{id}", get(get_job).delete(cancel))
        .route("/api/video/requests/{key}", get(request_status).delete(cancel_request))
        .route("/api/video/jobs/{id}/result", get(result))
        .route(
            "/api/video/batches",
            post(create).layer(DefaultBodyLimit::max(1024 * 1024)),
        )
        .route(
            "/api/video/batches/{id}",
            get(get_batch).delete(cancel_batch),
        )
        .route("/api/video/batches/{id}/result", get(batch_result))
        .route("/api/video/batch-requests/{key}", get(request_status).delete(cancel_request))
        .route("/api/video/batches/{id}/concat", post(concat))
        .route(
            "/api/video/batches/{id}/retry",
            post(retry_many).layer(DefaultBodyLimit::max(4096)),
        )
        .layer(Extension(Arc::new(Http { service })))
        .layer(axum::middleware::from_fn_with_state(
            Arc::new(generation::RateLimit::with("视频生成", 3, 60000)),
            generation::limit_request,
        ))
}
fn response(result: Result<Value>, status: StatusCode) -> Response {
    let mut response = match result {
        Ok(mut value) => {
            value["ok"] = json!(true);
            (status, Json(value)).into_response()
        }
        Err(e) => e.into_response(),
    };
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    response
}
async fn status(State(state): State<AppState>, Extension(http): Extension<Arc<Http>>) -> Response {
    response(
        async {
            state.host.check_running()?;
            http.service.get_status().await
        }
        .await,
        StatusCode::OK,
    )
}
async fn upload_raw(
    State(state): State<AppState>,
    Extension(http): Extension<Arc<Http>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    RawUploadBody(data, admission): RawUploadBody,
) -> Response {
    if let Err(e) = state.host.check_running() {
        return e.into_response();
    }
    let owner = generation::request_owner(&headers, peer, &query);
    let reference = query.get("kind").is_some_and(|kind| kind == "reference");
    response(
        store_image(&http, data, owner, reference, admission).await,
        StatusCode::OK,
    )
}
async fn store_image(
    http: &Http,
    data: axum::body::Bytes,
    owner: String,
    reference: bool,
    admission: tokio::sync::OwnedSemaphorePermit,
) -> Result<Value> {
    let name = http
        .service
        .upload(
            data,
            owner,
            reference,
            http.service.shutdown.child_token(),
            admission,
        )
        .await?;
    let bytes = tokio::fs::metadata(inputs::path(&http.service.config, &name)?)
        .await?
        .len();
    Ok(json!({"name":name,"bytes":bytes}))
}
async fn create(
    State(state): State<AppState>,
    Extension(http): Extension<Arc<Http>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    OriginalUri(uri): OriginalUri,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(mut body): Json<Value>,
) -> Response {
    let result = async {
        state.host.check_running()?;
        let key = body.get("requestKey").and_then(Value::as_str)
            .ok_or_else(|| ApiError::invalid("视频请求必须携带请求编号"))?.to_owned();
        body.as_object_mut().unwrap().remove("requestKey");
        let input = if uri.path() == "/api/video/batches" { requests::RequestInput::Batch(body) }
            else { requests::RequestInput::Job(body) };
        http.service.accept_request(input, key, generation::request_owner(&headers, peer, &query),
            security::is_direct_local(&headers, peer.ip())).await
    }.await;
    response(result, StatusCode::ACCEPTED)
}
macro_rules! lookup {
    ($name:ident,$method:ident,$key:literal) => {
        async fn $name(
            State(state): State<AppState>,
            Extension(http): Extension<Arc<Http>>,
            ConnectInfo(peer): ConnectInfo<SocketAddr>,
            Path(id): Path<String>,
            Query(query): Query<HashMap<String, String>>,
            headers: HeaderMap,
        ) -> Response {
            response(async {
                state.host.check_running()?;
                let mut value = json!({$key:null});
                value[$key] = http.service.$method(&id,&generation::request_owner(&headers,peer,&query)).await?;
                Ok(value)
            }.await, StatusCode::OK)
        }
    };
}
lookup!(get_job, get_job, "job");
lookup!(cancel, cancel, "job");
lookup!(get_batch, get_batch, "batch");
lookup!(cancel_batch, cancel_batch, "batch");
fn request_family(uri: &axum::http::Uri) -> &'static str {
    if uri.path().starts_with("/api/video/batch-requests/") { requests::BATCH } else { requests::JOB }
}
async fn request_status(
    State(state): State<AppState>, Extension(http): Extension<Arc<Http>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>, OriginalUri(uri): OriginalUri,
    Path(key): Path<String>, Query(query): Query<HashMap<String, String>>, headers: HeaderMap,
) -> Response {
    response(async { state.host.check_running()?; http.service.request_status(&key,
        &generation::request_owner(&headers, peer, &query), request_family(&uri)).await }.await, StatusCode::OK)
}
async fn cancel_request(
    State(state): State<AppState>, Extension(http): Extension<Arc<Http>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>, OriginalUri(uri): OriginalUri,
    Path(key): Path<String>, Query(query): Query<HashMap<String, String>>, headers: HeaderMap,
) -> Response {
    response(async { state.host.check_running()?; http.service.cancel_request(&key,
        &generation::request_owner(&headers, peer, &query), request_family(&uri)).await }.await, StatusCode::ACCEPTED)
}
async fn concat(
    State(state): State<AppState>,
    Extension(http): Extension<Arc<Http>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let cancel = http.service.shutdown.child_token();
    let _guard = cancel.clone().drop_guard();
    response(async {
        state.host.check_running()?;
        let mut value = json!({"batch":null});
        value["batch"] = http.service.clone().batch_action(&id,&generation::request_owner(&headers,peer,&query),"concat",cancel).await?;
        Ok(value)
    }.await, StatusCode::OK)
}
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RetrySelection {
    indices: Vec<usize>,
    request_key: String,
}
async fn retry_many(
    State(state): State<AppState>,
    Extension(http): Extension<Arc<Http>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(selection): Json<RetrySelection>,
) -> Response {
    response(async {
        state.host.check_running()?;
        let indices = selection.indices.into_iter().map(|index| index.checked_sub(1)
            .ok_or_else(||error(400,"SHOT_INDEX_INVALID","分镜序号无效"))).collect::<Result<Vec<_>>>()?;
        let owner = generation::request_owner(&headers, peer, &query);
        http.service.accept_request(requests::RequestInput::Retry { batch_id: id, indices }, selection.request_key, owner, false).await
    }.await,StatusCode::ACCEPTED)
}
async fn stream(
    state: &AppState,
    method: &Method,
    headers: &HeaderMap,
    output: Output,
) -> Result<Response> {
    let Output::File { path, mime, bytes } = output else {
        return Err(error(404, "RESULT_NOT_FOUND", "视频结果不存在"));
    };
    let range = crate::http_media::range(
        headers.get("range").and_then(|v| v.to_str().ok()),
        bytes,
    );
    let range = match range {
        Ok(r) => r,
        Err(response) => return Ok(response),
    };
    let mut response = crate::http_media::stream(
        method, range, crate::http_media::Source::Path(path), state.shutdown.clone(),
    ).await?;
    response
        .headers_mut()
        .insert("content-type", mime.parse().unwrap());
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    Ok(response)
}
macro_rules! results {
    ($name:ident,$method:ident) => {
        async fn $name(
            State(state): State<AppState>,
            Extension(http): Extension<Arc<Http>>,
            ConnectInfo(peer): ConnectInfo<SocketAddr>,
            Path(id): Path<String>,
            Query(query): Query<HashMap<String, String>>,
            headers: HeaderMap,
            method: Method,
        ) -> Response {
            match async {
                state.host.check_running()?;
                let output = http
                    .service
                    .$method(&id, &generation::request_owner(&headers, peer, &query))
                    .await?;
                stream(&state, &method, &headers, output).await
            }
            .await
            {
                Ok(r) => r,
                Err(e) => e.into_response(),
            }
        }
    };
}
results!(result, result);
results!(batch_result, batch_result);
