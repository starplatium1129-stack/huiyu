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
pub(crate) mod preview;
mod showcase;

use crate::remote_content::PUBLIC_DATA_FILES;
const PAGES: &[&str] = &[
    "/",
    "/index.html",
    "/guide",
    "/scene-explorer",
    "/popular-scenes",
    "/prompt-builder",
    "/qwen-studio",
    "/moss-studio",
    "/video-studio",
    "/studio-projects",
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

pub(crate) fn page_path(path: &str) -> bool {
    path == "/" || PAGES.contains(&path.trim_end_matches('/'))
}

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
    if let Some(name) = path.strip_prefix("/data/") {
        let config = state.config.clone();
        let projections = state.catalog_projections.clone();
        let selected = name.to_owned();
        let condition = request.headers().get("if-none-match").cloned();
        let head = request.method() == Method::HEAD;
        let accepts_gzip = request.headers().get("accept-encoding").and_then(|value| value.to_str().ok())
            .is_some_and(|value| crate::remote_content::encoding_quality(value, "gzip") > 0.0);
        match tokio::task::spawn_blocking(move || {
            // Presence checks stay with file/SQLite work, not on the request worker.
            if !config.runtime_root.join("content/catalog.sqlite").is_file()
                && !config
                    .runtime_root
                    .join("content/catalog.identity.json")
                    .is_file()
                && !config
                    .content_root()
                    .join("data/catalog/manifest.json")
                    .is_file()
            {
                return Ok(None);
            }
            // Reuse encoded bytes while this projection's dependencies are unchanged.
            projections
                .read(crate::catalog::Options::from_config(&config), &selected)
                .map(|value| {
                    value.map(|projection| {
                        let vary = projection.gzip.is_some();
                        let gzip = accepts_gzip && vary;
                        let bytes = if gzip { projection.gzip.unwrap() } else { projection.bytes };
                        let length = bytes.len();
                        let mut response = (
                            [
                                ("cache-control", "no-cache"),
                                ("content-type", "application/json"),
                            ],
                            bytes,
                        )
                            .into_response();
                        if vary { response.headers_mut().append("vary", HeaderValue::from_static("Accept-Encoding")); }
                        if gzip { response.headers_mut().insert("content-encoding", HeaderValue::from_static("gzip")); }
                        if head {
                            *response.body_mut() = Body::empty();
                            response
                                .headers_mut()
                                .insert("content-length", length.into());
                        }
                        conditional(response, &projection.tag, condition.as_ref())
                    })
                })
        })
        .await
        {
            Ok(Ok(Some(response))) => return response,
            Ok(Err(error)) => return error.into_response(),
            Err(_) => {
                return ApiError::new(503, "CATALOG_UNAVAILABLE", "内容读取失败").into_response();
            }
            _ => (),
        }
    }
    if let Some(response) = extra::redirect(&state, &path, request.uri().query()).await {
        return response;
    }
    let (base, relative, immutable) = if path == "/companion.html" {
        (root.join("dist"), "companion.html".to_owned(), false)
    } else if page_path(&path) {
        (root.join("dist"), "index.html".to_owned(), false)
    } else if let Some(name) = path.strip_prefix("/data/") {
        if !PUBLIC_DATA_FILES.contains(&name) {
            return StatusCode::NOT_FOUND.into_response();
        }
        (
            state.config.content_root().join("data"),
            name.to_owned(),
            false,
        )
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
    } else if let Some(name) = path.strip_prefix("/vendor/anime25d/") {
        if ![
            "runtime.js",
            "rigger.js",
            "renderer.js",
            "stage.js",
            "psd-worker.js",
            "ag-psd.min.js",
            "genericparts.js",
        ]
        .contains(&name)
        {
            return StatusCode::NOT_FOUND.into_response();
        }
        (root.join("dist/vendor/anime25d"), name.to_owned(), false)
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
    let content_root = state.config.content_root();
    let compressed_root = if path.starts_with("/data/") {
        &content_root
    } else {
        root
    };
    let file = base.join(&relative);
    let (base, file, metadata) = if let Some(metadata) = inside(&base, &file).await {
        (base, file, metadata)
    } else if path.starts_with("/assets/")
        && let Some(pack_assets) = state
            .media_packs
            .as_ref()
            .and_then(|packs| packs.portraits_assets_root())
        && let Some(metadata) = inside(&pack_assets, &pack_assets.join(&relative)).await
    {
        let pack_file = pack_assets.join(&relative);
        (pack_assets, pack_file, metadata)
    } else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if path == "/scene-showcase/manifest.json" {
        let mut refresh = false;
        let mut view = showcase::View::Full;
        let mut ids = Vec::new();
        for (key, value) in url::form_urlencoded::parse(request.uri().query().unwrap_or_default().as_bytes()) {
            refresh |= key == "refresh" && value == "1";
            if key == "view" {
                view = match value.as_ref() {
                    "cards" => showcase::View::Cards, "index" => showcase::View::Index,
                    "stories" => showcase::View::Stories, "details" => showcase::View::Details(Vec::new()),
                    _ => showcase::View::Full,
                };
            } else if key == "id" && ids.len() < 8 && !value.is_empty() && value.len() <= 320
                && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            {
                ids.push(value.into_owned());
            }
        }
        if let showcase::View::Details(selected) = &mut view { *selected = ids; }
        let gzip = !matches!(view, showcase::View::Full) && request.headers().get("accept-encoding")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| crate::remote_content::encoding_quality(value, "gzip") > 0.0);
        return showcase::serve(
            base,
            request.method() == Method::HEAD,
            request.headers().get("if-none-match").cloned(),
            refresh,
            view,
            gzip,
        )
        .await;
    }
    if path.starts_with("/scene-showcase/images/")
        && let Some(width) = url::form_urlencoded::parse(request.uri().query().unwrap_or_default().as_bytes())
            .find_map(|(key, value)| (key == "preview").then(|| value.parse::<u32>().ok()).flatten())
            .filter(|width| [560, 1120, 1680, 2240, 2800, 3360].contains(width))
    {
        return preview::serve(base, file, width, request.method() == Method::HEAD,
            request.headers().get("if-none-match").cloned()).await;
    }
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
        compressed_root,
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
