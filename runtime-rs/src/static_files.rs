use crate::{AppState, error::ApiError};
use axum::{
    body::Body,
    extract::{Request, State},
    http::{HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use std::path::Path;
use tower_http::services::ServeFile;
mod extra;

use crate::remote_content::PUBLIC_DATA_FILES;
pub(crate) const PAGES: &[&str] = &[
    "/",
    "/index.html",
    "/scene-explorer",
    "/popular-scenes",
    "/prompt-builder",
    "/video-studio",
    "/chat",
    "/showcase",
    "/gallery",
    "/character",
    "/style",
    "/lora",
    "/scene-manager",
    "/color-script",
    "/scenario",
    "/companion",
    "/companion-chat",
    "/control",
];

pub async fn serve(State(state): State<AppState>, mut request: Request) -> Response {
    let raw = request.uri().path();
    if raw == "/api"
        || raw.starts_with("/api/")
        || raw.starts_with("/sdapi/")
        || raw.starts_with("/comfy/")
    {
        return ApiError::new(404, "NOT_FOUND", "接口不存在").into_response();
    }
    if request.method() != Method::GET && request.method() != Method::HEAD {
        return StatusCode::METHOD_NOT_ALLOWED.into_response();
    }
    let Ok(path) = percent_encoding::percent_decode_str(raw).decode_utf8() else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if path.contains(['\\', '\0', ':']) || path.split('/').any(|part| part.starts_with('.')) {
        return StatusCode::NOT_FOUND.into_response();
    }
    if path.starts_with("/scene-showcase") && raw.contains('%') {
        return StatusCode::NOT_FOUND.into_response();
    }
    let root = &state.config.app_root;
    let assets = state.config.assets_root();
    if let Some(response) = extra::redirect(&state, &path, request.uri().query()).await {
        return response;
    }
    let (base, relative, immutable) = if PAGES.contains(&path.as_ref()) {
        (root.join("dist"), "index.html".to_owned(), false)
    } else if let Some(name) = path.strip_prefix("/data/") {
        if !PUBLIC_DATA_FILES.contains(&name) {
            return StatusCode::NOT_FOUND.into_response();
        }
        (root.join("data"), name.to_owned(), false)
    } else if let Some(name) = path.strip_prefix("/assets/") {
        if name
            .split('/')
            .next()
            .is_some_and(|part| part.eq_ignore_ascii_case("live2d-candidates"))
        {
            return StatusCode::NOT_FOUND.into_response();
        }
        (assets.clone(), name.to_owned(), false)
    } else if let Some(name) = path.strip_prefix("/_app/") {
        (root.join("dist/_app"), name.to_owned(), true)
    } else if path == "/favicon.ico" || path == "/favicon.svg" {
        (root.join("dist"), path[1..].to_owned(), false)
    } else if let Some((base, relative)) = extra::location(&state, &path) {
        (base, relative, false)
    } else if ![
        "scene-showcase",
        "character-references",
        "data",
        "assets",
        "docs",
        "tools",
        "_app",
        "src",
        "css",
    ]
    .contains(&path.split('/').nth(1).unwrap_or(""))
        && Path::new(path.as_ref())
            .extension()
            .is_none_or(|extension| extension == "html")
    {
        (root.join("dist"), "index.html".into(), false)
    } else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let file = base.join(&relative);
    let Some(metadata) = inside(&base, &file).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tag = format!("{:x}-{modified:x}", metadata.len());
    let condition = request.headers().get("if-none-match").cloned();
    if condition.is_some() {
        request.headers_mut().remove("if-modified-since");
    }
    if let Some(response) = crate::remote_content::precompressed(
        root,
        &assets,
        request.method(),
        request.uri(),
        request.headers(),
    )
    .await
    {
        return conditional(
            response.map(|body| {
                Body::from_stream(
                    body.into_data_stream()
                        .take_until(state.shutdown.clone().cancelled_owned()),
                )
            }),
            &tag,
            condition.as_ref(),
        );
    }
    // tower-http provides streaming, Range/HEAD and conditional date handling;
    // it never buffers entire images in the gateway heap.
    let mut service = ServeFile::new(file);
    match service.try_call(request).await {
        Ok(response) => {
            let mut response = response.map(|body| {
                Body::from_stream(
                    Body::new(body)
                        .into_data_stream()
                        .take_until(state.shutdown.clone().cancelled_owned()),
                )
            });
            response.headers_mut().insert(
                "cache-control",
                HeaderValue::from_static(if immutable {
                    "public, max-age=31536000, immutable"
                } else {
                    "private, no-cache"
                }),
            );
            conditional(response, &tag, condition.as_ref())
        }
        Err(_) => StatusCode::NOT_FOUND.into_response(),
    }
}

async fn inside(root: &Path, file: &Path) -> Option<std::fs::Metadata> {
    let Ok(root) = tokio::fs::canonicalize(root).await else {
        return None;
    };
    let Ok(file) = tokio::fs::canonicalize(file).await else {
        return None;
    };
    if !file.starts_with(root) {
        return None;
    }
    tokio::fs::metadata(file)
        .await
        .ok()
        .filter(|metadata| metadata.is_file())
}

fn conditional(mut response: Response, tag: &str, condition: Option<&HeaderValue>) -> Response {
    if !response.status().is_success() {
        return response;
    }
    let encoding = response
        .headers()
        .get("content-encoding")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("identity");
    let etag = format!("W/\"{tag}-{encoding}\"");
    let fresh = condition
        .and_then(|h| h.to_str().ok())
        .is_some_and(|value| {
            value.split(',').any(|part| {
                part.trim() == "*"
                    || part.trim().trim_start_matches("W/") == etag.trim_start_matches("W/")
            })
        });
    response.headers_mut().insert("etag", etag.parse().unwrap());
    if fresh {
        *response.status_mut() = StatusCode::NOT_MODIFIED;
        *response.body_mut() = Body::empty();
        response.headers_mut().remove("content-length");
        response.headers_mut().remove("content-range");
    }
    response
}
