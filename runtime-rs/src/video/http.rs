use super::*;
use crate::{AppState, security};
use axum::{
    Extension, Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Path, Query, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use futures_util::future::BoxFuture;
use std::{collections::HashMap, net::SocketAddr, sync::Mutex};
struct Http {
    service: Arc<Service>,
}
pub(super) fn router(service: Arc<Service>) -> Router<AppState> {
    Router::new()
        .route("/api/video/status", get(status))
        .route(
            "/api/video/images",
            post(upload).layer(DefaultBodyLimit::max(28 * 1024 * 1024)),
        )
        .route(
            "/api/video/jobs",
            post(create).layer(DefaultBodyLimit::max(32 * 1024)),
        )
        .route("/api/video/jobs/{id}", get(get_job).delete(cancel))
        .route("/api/video/jobs/{id}/result", get(result))
        .route(
            "/api/video/batches",
            post(create_batch).layer(DefaultBodyLimit::max(1024 * 1024)),
        )
        .route(
            "/api/video/batches/{id}",
            get(get_batch).delete(cancel_batch),
        )
        .route("/api/video/batches/{id}/result", get(batch_result))
        .route("/api/video/batches/{id}/concat", post(concat))
        .route("/api/video/batches/{id}/shots/{index}/retry", post(retry))
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
async fn upload(
    State(state): State<AppState>,
    Extension(http): Extension<Arc<Http>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = state.host.check_running() {
        return e.into_response();
    }
    let owner = generation::request_owner(&headers, peer, &query);
    response(
        async {
            let data = body["data"]
                .as_str()
                .filter(|s| !s.is_empty())
                .ok_or_else(|| error(400, "INVALID_IMAGE", "缺少图片数据"))?;
            let name = http
                .service
                .upload(
                    data.into(),
                    owner,
                    body["kind"] == "reference",
                    http.service.shutdown.child_token(),
                )
                .await?;
            let bytes = tokio::fs::metadata(inputs::path(&http.service.config, &name)?)
                .await?
                .len();
            Ok(json!({"name":name,"bytes":bytes}))
        }
        .await,
        StatusCode::OK,
    )
}
struct Guard {
    service: Arc<Service>,
    owner: String,
    id: Arc<Mutex<Option<String>>>,
    cancel: CancellationToken,
    armed: bool,
}
impl Drop for Guard {
    fn drop(&mut self) {
        if self.armed {
            self.cancel.cancel();
            if let Some(id) = self.id.lock().unwrap().clone() {
                let service = self.service.clone();
                let owner = self.owner.clone();
                tokio::spawn(async move {
                    let _ = service.cancel(&id, &owner).await;
                });
            }
        }
    }
}
struct Legacy {
    identity: Arc<Mutex<Option<String>>>,
    cancel: CancellationToken,
}
impl ExecutionHooks for Legacy {
    fn checkpoint(&self, value: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            *self.identity.lock().unwrap() = value["gatewayJobId"].as_str().map(str::to_owned);
            if self.cancel.is_cancelled() {
                Err(error(499, "VIDEO_CANCELLED", "视频请求已取消"))
            } else {
                Ok(())
            }
        })
    }
    fn submitting(&self, _: String, _: String) -> BoxFuture<'_, Result<()>> {
        Box::pin(async {
            if self.cancel.is_cancelled() {
                Err(error(499, "VIDEO_CANCELLED", "视频请求已取消"))
            } else {
                Ok(())
            }
        })
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
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = state.host.check_running() {
        return e.into_response();
    }
    let local = security::is_direct_local(&headers, peer.ip());
    let owner = generation::request_owner(&headers, peer, &query);
    let cancellation = http.service.shutdown.child_token();
    let id = Arc::new(Mutex::new(None));
    let mut guard = Guard {
        service: http.service.clone(),
        owner: owner.clone(),
        id: id.clone(),
        cancel: cancellation.clone(),
        armed: true,
    };
    let result = async {
        let prepared = http
            .service
            .prepare_owned(body, local, Some(&owner), cancellation.clone())
            .await?;
        inputs::protect_restore(
            &http.service.config,
            &prepared.originals,
            None,
            &cancellation,
        )
        .await?;
        let hooks = Arc::new(Legacy {
            identity: id,
            cancel: cancellation,
        });
        let job = http
            .service
            .backend
            .clone()
            .submit(prepared.backend, owner.clone(), Some(hooks))
            .await?;
        Ok(json!({"job":http.service.get_job(job["id"].as_str().unwrap(),&owner).await?}))
    }
    .await;
    if result.is_ok() {
        guard.armed = false;
    }
    response(result, StatusCode::ACCEPTED)
}
async fn create_batch(
    State(state): State<AppState>,
    Extension(http): Extension<Arc<Http>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if let Err(e) = state.host.check_running() {
        return e.into_response();
    }
    let local = security::is_direct_local(&headers, peer.ip());
    let owner = generation::request_owner(&headers, peer, &query);
    let cancellation = http.service.shutdown.child_token();
    let _guard = cancellation.clone().drop_guard();
    response(
        async {
            let prepared = http
                .service
                .prepare_batch_owned(body, local, Some(&owner), cancellation)
                .await?;
            Ok(json!({"batch":http.service.clone().submit_batch(prepared,owner,None).await?}))
        }
        .await,
        StatusCode::ACCEPTED,
    )
}
macro_rules! lookup{($name:ident,$method:ident,$key:literal)=>{async fn $name(State(state):State<AppState>,Extension(http):Extension<Arc<Http>>,ConnectInfo(peer):ConnectInfo<SocketAddr>,Path(id):Path<String>,Query(query):Query<HashMap<String,String>>,headers:HeaderMap)->Response{response(async{state.host.check_running()?;Ok(json!({$key:http.service.$method(&id,&generation::request_owner(&headers,peer,&query)).await?}))}.await,StatusCode::OK)}}}
lookup!(get_job, get_job, "job");
lookup!(cancel, cancel, "job");
lookup!(get_batch, get_batch, "batch");
lookup!(cancel_batch, cancel_batch, "batch");
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
    response(async{state.host.check_running()?;Ok(json!({"batch":http.service.clone().batch_action(&id,&generation::request_owner(&headers,peer,&query),"concat",cancel).await?}))}.await,StatusCode::OK)
}
async fn retry(
    State(state): State<AppState>,
    Extension(http): Extension<Arc<Http>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path((id, index)): Path<(String, usize)>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    response(async{state.host.check_running()?;let index=index.checked_sub(1).ok_or_else(||error(400,"SHOT_INDEX_INVALID","分镜序号无效"))?;Ok(json!({"batch":http.service.clone().retry_shot(&id,&generation::request_owner(&headers,peer,&query),index).await?}))}.await,StatusCode::ACCEPTED)
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
    let range = crate::workspace_http::media_range(
        headers.get("range").and_then(|v| v.to_str().ok()),
        bytes,
    );
    let range = match range {
        Ok(r) => r,
        Err(_) => {
            let mut response = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
            response
                .headers_mut()
                .insert("content-range", format!("bytes */{bytes}").parse().unwrap());
            return Ok(response);
        }
    };
    let media = crate::storage::Media {
        path,
        mime: mime.clone(),
        total_bytes: bytes,
        sha256: String::new(),
    };
    let mut response =
        crate::workspace_http::stream_media(state, method, &media, range.start, range.length)
            .await?;
    response
        .headers_mut()
        .insert("content-type", mime.parse().unwrap());
    response
        .headers_mut()
        .insert("accept-ranges", "bytes".parse().unwrap());
    response
        .headers_mut()
        .insert("cache-control", "no-store".parse().unwrap());
    if range.partial {
        *response.status_mut() = StatusCode::PARTIAL_CONTENT;
        response.headers_mut().insert(
            "content-range",
            format!(
                "bytes {}-{}/{bytes}",
                range.start,
                range.start + range.length - 1
            )
            .parse()
            .unwrap(),
        );
    }
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
