mod result;
mod result_part;
mod submission;

use super::{Result, Service, generation, remote};
use crate::AppState;
use axum::{
    Extension, Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, OriginalUri, Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use result::result;
pub(super) use result_part::PART_BYTES;
use serde_json::{Value, json};
use std::{collections::HashMap, net::SocketAddr, sync::Arc};
use submission::{create, upload_raw};

struct Http {
    service: Arc<Service>,
}
pub(super) fn router(service: Arc<Service>) -> Router<AppState> {
    let mut router = Router::new();
    for family in ["anima", "creative", "qwen", "keyframe", "moss", "manga"] {
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
    } else if uri.path().starts_with("/api/keyframe/") {
        "keyframe"
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

fn job_response(result: Result<Value>, status: StatusCode, guest: bool) -> Response {
    if !guest {
        return response(result, status);
    }
    response(
        result.map(|mut value| {
            if let Some(job) = value["job"].as_object_mut() {
                job.retain(|key, _| {
                    matches!(
                        key.as_str(),
                        "id" | "status"
                            | "resultAvailable"
                            | "resultUrl"
                            | "resultBytes"
                            | "seed"
                            | "progress"
                            | "upstreamSettled"
                            | "unknown"
                    )
                });
                if job.get("status").is_some_and(|status| status == "failed") {
                    job.insert(
                        "error".into(),
                        json!("房主的出图服务未能完成，请让房主检查出图状态。"),
                    );
                }
            }
            if let Some(rejected) = value.get_mut("rejected")
                && rejected["code"] != "IMAGE_REQUEST_CANCELLED"
            {
                rejected["message"] = json!("房主的出图服务暂未接收请求，请稍后重试。");
            }
            value
        }),
        status,
    )
}
async fn status(
    State(state): State<AppState>,
    Extension(http): Extension<Arc<Http>>,
    guide: Option<Extension<remote::Guide>>,
    reuse: Option<Extension<Arc<remote::UploadIndex>>>,
    guest: Option<Extension<crate::guest_share::Guest>>,
    OriginalUri(uri): OriginalUri,
) -> Response {
    response(
        async {
            state.host.check_running()?;
            if guest.is_some() && http.service.is_remote() {
                return Ok(json!({"ready":false,"modelAvailable":false}));
            }
            let family = family(&uri);
            let mut status = http.service.get_status(family).await?;
            if guest.is_some() {
                let available = status["models"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|model| model["id"] == remote::muse::ANIMA && model["available"] == true);
                return Ok(json!({"modelAvailable":available,
                    "ready":available && (status["online"] == true || status["managedStartAvailable"] == true)}));
            }
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
async fn get_job(
    State(state): State<AppState>,
    Extension(http): Extension<Arc<Http>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    OriginalUri(uri): OriginalUri,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    guest: Option<Extension<crate::guest_share::Guest>>,
) -> Response {
    job_response(
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
        guest.is_some(),
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
    guest: Option<Extension<crate::guest_share::Guest>>,
) -> Response {
    job_response(
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
        guest.is_some(),
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
    guest: Option<Extension<crate::guest_share::Guest>>,
) -> Response {
    job_response(
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
        guest.is_some(),
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
