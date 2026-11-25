//! Strictly read-only remote health summary and desktop gallery query/download endpoints.
//! Never exposes arbitrary file paths, secrets, tokens, environment variables, or mutations.
mod gallery;
mod health;
mod media;
mod sanitize;

use crate::{AppState, error::Result, generation::RateLimit};
use axum::{
    Extension, Json, Router,
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::get,
};
use serde_json::{Value, json};
use std::sync::Arc;

pub(crate) const PART_BYTES: u64 = 128 * 1024;
pub(crate) const MAX_PART_COUNT: u64 = 16;
pub(crate) const MAX_GALLERY_PAGE_SIZE: usize = 50;
const READ_PRINCIPAL: &str = "muse:readonly";

struct OpsLimits {
    health: RateLimit,
    gallery: RateLimit,
}

pub(crate) fn router() -> Router<AppState> {
    let limits = Arc::new(OpsLimits {
        health: RateLimit::with("远程健康检查", 30, 500),
        gallery: RateLimit::with("作品册只读查询", 60, 200),
    });
    Router::new()
        .route("/api/muse/health", get(health::health))
        .route("/api/muse/gallery", get(gallery::gallery_list))
        .route("/api/muse/gallery/{id}", get(gallery::gallery_item))
        .route("/api/muse/gallery/{id}/file", get(media::gallery_file))
        .layer(Extension(limits))
}

fn json_response(result: Result<Value>) -> Response {
    let mut response = match result {
        Ok(mut value) => {
            value["ok"] = json!(true);
            (StatusCode::OK, Json(value)).into_response()
        }
        Err(err) => err.into_response(),
    };
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store"),
    );
    response
}
