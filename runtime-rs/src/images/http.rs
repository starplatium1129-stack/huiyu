mod result_part;
use super::upload_body::RawUploadBody;
use super::*;
use crate::{AppState, security};
use axum::{
    Extension, Json, Router,
    body::Bytes,
    extract::{ConnectInfo, DefaultBodyLimit, OriginalUri, Path, Query, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::future::BoxFuture;
pub(super) use result_part::PART_BYTES;
use std::{collections::HashMap, net::SocketAddr, sync::Mutex};
struct Http {
    service: Arc<Service>,
}
pub(super) fn router(service: Arc<Service>) -> Router<AppState> {
    let mut router = Router::new();
    for family in ["anima", "creative", "qwen", "moss", "manga"] {
        router = router
            .route(&format!("/api/{family}/status"), get(status))
            .route(
                &format!("/api/{family}/images/raw"),
                post(upload_raw).layer(DefaultBodyLimit::max(16 * 1024 * 1024)),
            )
            .route(
                &format!("/api/{family}/jobs"),
                post(create).layer(DefaultBodyLimit::max(64 * 1024)),
            )
            .route(
                &format!("/api/{family}/jobs/{{id}}"),
                get(get_job).delete(cancel),
            )
            .route(
                &format!("/api/{family}/requests/{{key}}"),
                get(request_status).delete(cancel_request),
            )
            .route(&format!("/api/{family}/jobs/{{id}}/result"), get(result));
    }
    router
        .route("/api/manga/jobs/{id}/lineart", get(result))
        .layer(Extension(Arc::new(Http { service })))
        .layer(axum::middleware::from_fn_with_state(
            Arc::new(generation::RateLimit::new("Anima 出图")),
            generation::limit_request,
        ))
}
pub(super) fn family(uri: &axum::http::Uri) -> &'static str {
    if uri.path().starts_with("/api/anima/") {
        "anima"
    } else if uri.path().starts_with("/api/qwen/") {
        "qwen-image"
    } else if uri.path().starts_with("/api/moss/") {
        "moss-image"
    } else if uri.path().starts_with("/api/manga/") {
        "manga-screen"
    } else {
        "krea2"
    }
}
pub(super) fn response(result: Result<Value>, status: StatusCode) -> Response {
    let mut response = match result {
        Ok(mut value) => {
            value["ok"] = json!(true);
            (status, Json(value)).into_response()
        }
        Err(error) => error.into_response(),
    };
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
async fn status(
    State(state): State<AppState>,
    Extension(http): Extension<Arc<Http>>,
    guide: Option<Extension<remote::Guide>>,
    reuse: Option<Extension<Arc<remote::UploadIndex>>>,
    OriginalUri(uri): OriginalUri,
) -> Response {
    response(
        async {
            state.host.check_running()?;
            let mut status = http.service.get_status(family(&uri)).await?;
            if guide.is_some() {
                status["museGuide"] = remote::Guide::document().clone();
            }
            if let Some(Extension(index)) = reuse {
                status["inputReuse"] = json!(index.has_uploads());
            }
            Ok(status)
        }
        .await,
        StatusCode::OK,
    )
}
async fn upload_raw(
    State(state): State<AppState>,
    Extension(http): Extension<Arc<Http>>,
    reuse: Option<Extension<Arc<remote::UploadIndex>>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    RawUploadBody(bytes, admission): RawUploadBody,
) -> Response {
    if let Err(error) = state.host.check_running() {
        return error.into_response();
    }
    let owner = generation::request_owner(&headers, peer, &query);
    let indexed = reuse.is_some();
    let result = http
        .service
        .upload(
            bytes,
            owner,
            http.service.shutdown.child_token(),
            admission,
            reuse.map(|Extension(index)| index),
        )
        .await
        .map(|name| {
            if indexed {
                json!({"name":name,"inputReuse":true})
            } else {
                json!({"name":name})
            }
        });
    response(result, StatusCode::OK)
}
struct SubmissionGuard {
    service: Arc<Service>,
    owner: String,
    family: &'static str,
    job: Arc<Mutex<Option<String>>>,
    cancel: CancellationToken,
    armed: bool,
}
impl Drop for SubmissionGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        self.cancel.cancel();
        let job = self.job.lock().unwrap().clone();
        if let Some(id) = job {
            let service = self.service.clone();
            let owner = self.owner.clone();
            let family = self.family;
            tokio::spawn(async move {
                let _ = service.cancel(&id, &owner, family).await;
            });
        }
    }
}
struct LegacyObservation {
    job: Arc<Mutex<Option<String>>>,
    cancel: CancellationToken,
}
impl LegacyObservation {
    fn check(&self) -> Result<()> {
        if self.cancel.is_cancelled() {
            Err(inputs::cancelled())
        } else {
            Ok(())
        }
    }
}
impl ExecutionHooks for LegacyObservation {
    fn checkpoint(&self, value: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            *self.job.lock().unwrap() = value["gatewayJobId"].as_str().map(str::to_owned);
            self.check()
        })
    }
    fn submitting(&self, _: String) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move { self.check() })
    }
    fn observed(&self, _: String, _: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn collect(&self, _: Vec<Output>) -> BoxFuture<'_, Result<()>> {
        Box::pin(async { Ok(()) })
    }
}
async fn create(
    State(state): State<AppState>,
    Extension(http): Extension<Arc<Http>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    OriginalUri(uri): OriginalUri,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(error) = state.host.check_running() {
        return error.into_response();
    }
    let local = security::is_direct_local(&headers, peer.ip());
    let family = family(&uri);
    let owner = generation::request_owner(&headers, peer, &query);
    if let Some(key) = body.get("requestKey") {
        let result = match key.as_str().map(str::to_owned) {
            Some(key) => {
                http.service
                    .accept_request(body, key, owner, family, local)
                    .await
            }
            None => Err(ApiError::invalid("图片请求编号无效")),
        };
        return response(result, StatusCode::ACCEPTED);
    }
    let cancellation = http.service.shutdown.child_token();
    let job = Arc::new(Mutex::new(None));
    let mut guard = SubmissionGuard {
        service: http.service.clone(),
        owner: owner.clone(),
        family,
        job: job.clone(),
        cancel: cancellation.clone(),
        armed: true,
    };
    let result = async {
        let prepared = http
            .service
            .prepare_owned(body, family, local, Some(&owner), cancellation.clone())
            .await?;
        // Legacy routes retain their original filesystem input contract. Durable
        // TaskRuntime uses Service::submit and the real task.input hooks instead.
        inputs::protect_and_restore(
            &http.service.config,
            &prepared.originals,
            None,
            &cancellation,
        )
        .await?;
        let observation = Arc::new(LegacyObservation {
            job,
            cancel: cancellation,
        });
        let mut value = json!({"job":null});
        value["job"] = http
            .service
            .clone()
            .submit_protected(prepared, owner, Some(observation))
            .await?;
        Ok(value)
    }
    .await;
    if result.is_ok() {
        guard.armed = false;
    }
    response(result, StatusCode::ACCEPTED)
}
async fn get_job(
    State(state): State<AppState>,
    Extension(http): Extension<Arc<Http>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    response(
        async {
            state.host.check_running()?;
            let mut value = json!({"job":null});
            value["job"] = http
                .service
                .get_job(
                    &id,
                    &generation::request_owner(&headers, peer, &query),
                    family(&uri),
                )
                .await?;
            Ok(value)
        }
        .await,
        StatusCode::OK,
    )
}
async fn request_status(
    State(state): State<AppState>,
    Extension(http): Extension<Arc<Http>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    OriginalUri(uri): OriginalUri,
    Path(key): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    response(
        async {
            state.host.check_running()?;
            http.service
                .request_status(
                    &key,
                    &generation::request_owner(&headers, peer, &query),
                    family(&uri),
                )
                .await
        }
        .await,
        StatusCode::OK,
    )
}
async fn cancel_request(
    State(state): State<AppState>,
    Extension(http): Extension<Arc<Http>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    OriginalUri(uri): OriginalUri,
    Path(key): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    response(
        async {
            state.host.check_running()?;
            http.service
                .cancel_request(
                    &key,
                    &generation::request_owner(&headers, peer, &query),
                    family(&uri),
                )
                .await
        }
        .await,
        StatusCode::ACCEPTED,
    )
}
async fn cancel(
    State(state): State<AppState>,
    Extension(http): Extension<Arc<Http>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let result = async {
        state.host.check_running()?;
        let mut value = json!({"job":null});
        value["job"] = http
            .service
            .cancel(
                &id,
                &generation::request_owner(&headers, peer, &query),
                family(&uri),
            )
            .await?;
        Ok(value)
    }
    .await;
    let status = if result
        .as_ref()
        .is_ok_and(|value| value["job"]["status"] == "cancelling")
    {
        StatusCode::ACCEPTED
    } else {
        StatusCode::OK
    };
    response(result, status)
}
struct SharedBytes(Arc<Vec<u8>>);
impl AsRef<[u8]> for SharedBytes {
    fn as_ref(&self) -> &[u8] {
        self.0.as_slice()
    }
}
async fn result(
    State(state): State<AppState>,
    Extension(http): Extension<Arc<Http>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    method: Method,
) -> Response {
    use crate::http_media::{self, Source};
    let result = async {
        state.host.check_running()?;
        let owner = generation::request_owner(&headers, peer, &query);
        let family = family(&uri);
        let lineart = uri.path().ends_with("/lineart");
        let output = http.service.result(&id, &owner, family).await?;
        let (output, etag) = if lineart {
            (
                http.service.lineart_result(&id, &owner, output).await?,
                None,
            )
        } else {
            let etag = if http
                .service
                .backend
                .remote_store()
                .is_some_and(|store| store.owner == owner)
            {
                let receipt = http.service.get_job(&id, &owner, family).await?;
                if receipt["resultBytes"].as_u64() != Some(output.len()) {
                    return Err(ApiError::new(
                        409,
                        "RESULT_CHANGED",
                        "原图与回执长度不符，请重新查询任务",
                    ));
                }
                let sha = receipt["resultSha256"]
                    .as_str()
                    .filter(|sha| sha.len() == 64 && sha.bytes().all(|b| b.is_ascii_hexdigit()))
                    .ok_or_else(|| {
                        ApiError::new(
                            409,
                            "RESULT_DIGEST_MISSING",
                            "原图暂缺校验值，请重新查询任务",
                        )
                    })?;
                Some(format!("\"{sha}\""))
            } else {
                None
            };
            (output, etag)
        };
        let mime = output.mime().to_string();
        let (source, length) = match output {
            Output::Bytes { bytes, .. } => {
                let length = bytes.len() as u64;
                (Source::Bytes(Bytes::from_owner(SharedBytes(bytes))), length)
            }
            Output::File { path, bytes, .. } => {
                let root =
                    tokio::fs::canonicalize(http.service.config.runtime_root.join("outputs/anima"))
                        .await?;
                let file = tokio::fs::canonicalize(path).await?;
                if !file.starts_with(root) {
                    return Err(ApiError::new(404, "RESULT_NOT_FOUND", "结果不存在"));
                }
                let file = tokio::fs::File::open(file).await?;
                let stat = file.metadata().await?;
                if !stat.is_file() {
                    return Err(ApiError::new(404, "RESULT_NOT_FOUND", "结果不存在"));
                }
                if stat.len() != bytes {
                    return Err(ApiError::new(409, "RESULT_CHANGED", "原图在读取前发生变化"));
                }
                (
                    Source::Opened(file, http.service.shutdown.clone()),
                    stat.len(),
                )
            }
        };
        if let Some(part) = query.get("part") {
            if headers.contains_key(header::RANGE) {
                return Err(ApiError::invalid(
                    "分片请求无需 Range；请单独使用 part 或 Range",
                ));
            }
            let digest = etag
                .as_deref()
                .and_then(|value| value.strip_prefix('"')?.strip_suffix('"'))
                .ok_or_else(|| ApiError::invalid("分片只适用于带 SHA-256 回执的远程成图"))?;
            return result_part::serve(source, length, digest, part, &method).await;
        }
        let range = headers
            .get(header::RANGE)
            .filter(|_| {
                method == Method::GET
                    && headers.get(header::IF_RANGE).is_none_or(|value| {
                        etag.as_deref()
                            .is_some_and(|etag| value.as_bytes() == etag.as_bytes())
                    })
            })
            .map(|value| value.to_str().unwrap_or(""));
        let mut response = match http_media::range(range, length) {
            Ok(range) => {
                http_media::stream(&method, range, source, http.service.shutdown.clone()).await?
            }
            Err(response) => response,
        };
        let headers = response.headers_mut();
        headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-store, no-transform"),
        );
        headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        headers.insert(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        );
        if let Ok(mime) = HeaderValue::from_str(&mime) {
            headers.insert(header::CONTENT_TYPE, mime);
        }
        if let Some(etag) = etag.and_then(|value| HeaderValue::from_str(&value).ok()) {
            headers.insert(header::ETAG, etag);
        }
        Ok::<_, ApiError>(response)
    }
    .await;
    match result {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}
