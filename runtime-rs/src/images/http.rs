use super::*;
use crate::{AppState, security};
use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{ConnectInfo, DefaultBodyLimit, OriginalUri, Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::future::BoxFuture;
use std::{collections::HashMap, net::SocketAddr, sync::Mutex};
use tokio_util::io::ReaderStream;
struct Http {
    service: Arc<Service>,
}
pub(super) fn router(service: Arc<Service>) -> Router<AppState> {
    let mut router = Router::new();
    for family in ["anima", "creative"] {
        router = router
            .route(&format!("/api/{family}/status"), get(status))
            .route(
                &format!("/api/{family}/images"),
                post(upload).layer(DefaultBodyLimit::max(28 * 1024 * 1024)),
            )
            .route(
                &format!("/api/{family}/jobs"),
                post(create).layer(DefaultBodyLimit::max(64 * 1024)),
            )
            .route(
                &format!("/api/{family}/jobs/{{id}}"),
                get(get_job).delete(cancel),
            )
            .route(&format!("/api/{family}/jobs/{{id}}/result"), get(result));
    }
    router
        .layer(Extension(Arc::new(Http { service })))
        .layer(axum::middleware::from_fn_with_state(
            Arc::new(generation::RateLimit::new("Anima 出图")),
            generation::limit_request,
        ))
}
fn family(uri: &axum::http::Uri) -> &'static str {
    if uri.path().starts_with("/api/anima/") {
        "anima"
    } else {
        "krea2"
    }
}
fn response(result: Result<Value>, status: StatusCode) -> Response {
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
    OriginalUri(uri): OriginalUri,
) -> Response {
    response(
        async {
            state.host.check_running()?;
            http.service.get_status(family(&uri)).await
        }
        .await,
        StatusCode::OK,
    )
}
async fn upload(
    State(state): State<AppState>,
    Extension(http): Extension<Arc<Http>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(mut body): Json<Value>,
) -> Response {
    if let Err(error) = state.host.check_running() {
        return error.into_response();
    }
    let owner = generation::request_owner(&headers, peer, &query);
    let result = async {
        let Some(Value::String(image)) = body.get_mut("image").map(Value::take) else {
            return Err(error("INVALID_BODY", "请求体必须包含 image base64 字符串"));
        };
        Ok(json!({"name":http.service.upload(image,owner,http.service.shutdown.child_token()).await?}))
    }.await;
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
    fn submitting(&self, _: String, _: String) -> BoxFuture<'_, Result<()>> {
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
    let result=async{
        let prepared=http.service.prepare_owned(body,family,local,Some(&owner),cancellation.clone()).await?;
        // Legacy routes retain their original filesystem input contract. Durable
        // TaskRuntime uses Service::submit and the real task.input hooks instead.
        inputs::protect_and_restore(&http.service.config,&prepared.originals,None,&cancellation).await?;
        let observation=Arc::new(LegacyObservation {job,cancel:cancellation});
        Ok(json!({"job":http.service.backend.clone().submit(prepared.backend,owner,Some(observation)).await?}))
    }.await;
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
    response(async{state.host.check_running()?;Ok(json!({"job":http.service.get_job(&id,&generation::request_owner(&headers,peer,&query),family(&uri)).await?}))}.await,StatusCode::OK)
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
    let result=async{state.host.check_running()?;Ok(json!({"job":http.service.cancel(&id,&generation::request_owner(&headers,peer,&query),family(&uri)).await?}))}.await;
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
async fn result(
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
        let output = http
            .service
            .result(
                &id,
                &generation::request_owner(&headers, peer, &query),
                family(&uri),
            )
            .await?;
        let Output::File { path, mime, .. } = output else {
            return Err(ApiError::new(404, "RESULT_NOT_FOUND", "结果不存在"));
        };
        let root =
            tokio::fs::canonicalize(http.service.config.runtime_root.join("outputs/anima")).await?;
        let file = tokio::fs::canonicalize(path).await?;
        if !file.starts_with(root) {
            return Err(ApiError::new(404, "RESULT_NOT_FOUND", "结果不存在"));
        }
        let file = tokio::fs::File::open(file).await?;
        let stat = file.metadata().await?;
        if !stat.is_file() {
            return Err(ApiError::new(404, "RESULT_NOT_FOUND", "结果不存在"));
        }
        Response::builder()
            .status(200)
            .header(header::CACHE_CONTROL, "no-store")
            .header(header::CONTENT_TYPE, mime)
            .header(header::CONTENT_LENGTH, stat.len())
            .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff")
            .body(Body::from_stream(ReaderStream::new(file)))
            .map_err(|_| ApiError::new(404, "RESULT_NOT_FOUND", "结果不存在"))
    }
    .await;
    match result {
        Ok(response) => response,
        Err(error) => error.into_response(),
    }
}
