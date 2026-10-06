use super::*;
use crate::{AppState, security};
use axum::{
    Extension, Json, Router,
    body::{Body, Bytes},
    extract::{ConnectInfo, DefaultBodyLimit, Path, Query, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use sha2::{Digest, Sha256};
use std::{net::SocketAddr, sync::Mutex as SyncMutex};
use tokio_util::io::ReaderStream;

struct Http {
    service: Arc<Service>,
}
pub(crate) struct RateLimit {
    bucket: SyncMutex<(u8, Instant)>,
    label: &'static str,
    capacity: u8,
    refill_ms: u64,
}
impl RateLimit {
    pub(crate) fn new(label: &'static str) -> Self {
        Self::with(label, 12, 5000)
    }
    pub(crate) fn with(label: &'static str, capacity: u8, refill_ms: u64) -> Self {
        Self {
            bucket: SyncMutex::new((capacity, Instant::now())),
            label,
            capacity,
            refill_ms,
        }
    }
    pub(crate) fn check(&self, local: bool) -> Option<Response> {
        if local {
            return None;
        }
        let allowed = {
            let mut bucket = self.bucket.lock().unwrap();
            let gained = bucket.1.elapsed().as_millis() / u128::from(self.refill_ms);
            if gained > 0 {
                bucket.0 = (u128::from(bucket.0) + gained).min(u128::from(self.capacity)) as u8;
                bucket.1 += Duration::from_millis(
                    (gained * u128::from(self.refill_ms)).min(u128::from(u64::MAX)) as u64,
                );
            }
            if bucket.0 == 0 {
                false
            } else {
                bucket.0 -= 1;
                if bucket.0 == self.capacity - 1 {
                    bucket.1 = Instant::now();
                }
                true
            }
        };
        let retry = self.refill_ms.div_ceil(1000);
        (!allowed).then(||(StatusCode::TOO_MANY_REQUESTS,[(header::RETRY_AFTER,retry.to_string())],Json(json!({"ok":false,"error":format!("{}请求过于频繁，请稍后再试",self.label),"code":"RATE_LIMITED","retryAfterSeconds":retry}))).into_response())
    }
}
pub(super) fn router(service: Arc<Service>) -> Router<AppState> {
    Router::new()
        .route("/api/generation/status", get(status))
        .route(
            "/api/generation/jobs",
            post(create).layer(DefaultBodyLimit::max(64 * 1024)),
        )
        .route("/api/generation/jobs/{id}", get(get_job).delete(cancel))
        .route("/api/generation/jobs/{id}/result", get(result))
        .layer(Extension(Arc::new(Http { service })))
        .layer(axum::middleware::from_fn_with_state(
            Arc::new(RateLimit::new("WAI 出图")),
            limit_request,
        ))
}
pub(crate) async fn limit_request(
    State(limit): State<Arc<RateLimit>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    request: Request,
    next: Next,
) -> Response {
    // Admission runs before Json allocates an upload body. Sharing clients use
    // one bucket even when they change forwarded IP headers.
    if request.method() == Method::POST
        && request
            .uri()
            .path()
            .rsplit('/')
            .next()
            .is_some_and(|part| ["images", "jobs", "batches", "retry"].contains(&part))
        && let Some(response) = limit.check(security::is_direct_local(request.headers(), peer.ip()))
    {
        return response;
    }
    next.run(request).await
}
pub(crate) fn owner(
    headers: &HeaderMap,
    peer: SocketAddr,
    query: &HashMap<String, String>,
) -> String {
    if security::is_direct_local(headers, peer.ip()) {
        return "local".into();
    }
    let cookie = headers
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|cookie| {
            cookie
                .split(';')
                .find_map(|part| part.trim_start().strip_prefix("aics_token="))
        });
    let token = headers
        .get("x-token")
        .and_then(|v| v.to_str().ok())
        .filter(|s| !s.is_empty())
        .or(cookie)
        .or_else(|| query.get("token").map(String::as_str))
        .unwrap_or("");
    hex::encode(Sha256::digest(token.as_bytes()))
}
fn no_store(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}
fn envelope(result: Result<Value>) -> Response {
    no_store(match result {
        Ok(mut value) => {
            value["ok"] = json!(true);
            Json(value).into_response()
        }
        Err(error) => error.into_response(),
    })
}
async fn status(State(state): State<AppState>, Extension(http): Extension<Arc<Http>>) -> Response {
    envelope(match state.host.check_running() {
        Ok(()) => http.service.get_status().await,
        Err(error) => Err(error),
    })
}
async fn create() -> Response {
    ApiError::new(
        410,
        "SD_RETIRED",
        "SD 新生成已退役，旧任务仍可查询与取消；请使用 Anima 或 Krea 2",
    )
    .into_response()
}
async fn get_job(
    State(state): State<AppState>,
    Extension(http): Extension<Arc<Http>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let result = async {
        state.host.check_running()?;
        Ok(json!({"job":http.service.get_job(&id,&owner(&headers,peer,&query)).await?}))
    }
    .await;
    envelope(result)
}
async fn cancel(
    State(state): State<AppState>,
    Extension(http): Extension<Arc<Http>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let result = async {
        state.host.check_running()?;
        Ok(json!({"job":http.service.cancel(&id,&owner(&headers,peer,&query)).await?}))
    }
    .await;
    envelope(result)
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
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    let result = async {
        state.host.check_running()?;
        let output = http
            .service
            .result(&id, &owner(&headers, peer, &query))
            .await?;
        let length = output.len();
        let mime = output.mime().to_string();
        let body = match output {
            Output::Bytes { bytes, .. } => Body::from(Bytes::from_owner(SharedBytes(bytes))),
            Output::File { path, .. } => {
                Body::from_stream(ReaderStream::new(tokio::fs::File::open(path).await?))
            }
        };
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, mime)
            .header(header::CONTENT_LENGTH, length)
            .body(body)
            .map_err(|_| ApiError::new(500, "RESULT_NOT_FOUND", "结果不存在"))
    }
    .await;
    no_store(match result {
        Ok(response) => response,
        Err(error) => error.into_response(),
    })
}
