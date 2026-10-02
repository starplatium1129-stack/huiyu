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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{config::Config, host::HostAuthority};
    use serde_json::json;
    use std::{
        io::Write,
        sync::Arc,
        time::{Duration, SystemTime},
    };
    use tokio_util::sync::CancellationToken;

    fn variants(file: &Path, bytes: &[u8]) -> [Vec<u8>; 3] {
        let mut brotli = Vec::new();
        brotli::BrotliCompress(
            &mut std::io::Cursor::new(bytes),
            &mut brotli,
            &brotli::enc::BrotliEncoderParams::default(),
        )
        .unwrap();
        let mut gzip = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gzip.write_all(bytes).unwrap();
        let gzip = gzip.finish().unwrap();
        for (suffix, value) in [
            ("", bytes),
            (".br", brotli.as_slice()),
            (".gz", gzip.as_slice()),
        ] {
            std::fs::write(format!("{}{suffix}", file.display()), value).unwrap();
        }
        [brotli, gzip, bytes.to_vec()]
    }

    #[tokio::test]
    async fn static_http_preserves_document_redirects_and_mutable_encoding_etags() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let config = Arc::new(Config {
            app_root: root.into(),
            runtime_root: root.join("runtime"),
            ai_workspace_root: root.join("unused-ai"),
            sd_host: "http://127.0.0.1:1".into(),
            sd_auth: None,
            comfy_host: "http://127.0.0.1:1".into(),
            bind: "127.0.0.1:0".parse().unwrap(),
            token: String::new(),
            desktop_secret: Some("fixture".into()),
            source_profile_id: None,
            workspace_pointer: None,
            workspace_candidate: None,
            config_root: None,
            gateway_origin: String::new(),
            workspace_root: None,
            workspace_id: None,
            create_workspace: false,
        });
        std::fs::create_dir_all(root.join("docs")).unwrap();
        std::fs::write(
            root.join("docs/redirects.json"),
            br#"{"/docs/art-direction.html":"/docs/guides/art/art-direction.html"}"#,
        )
        .unwrap();
        let data = config.content_root().join("data");
        std::fs::create_dir_all(&data).unwrap();
        let file = data.join("scenes.json");
        let old = variants(&file, br#"{"revision":"old"}"#);
        let shutdown = CancellationToken::new();
        let state = AppState::new(
            config,
            Arc::new(HostAuthority::new(
                None,
                Some(json!({"bundledUi":true})),
                None,
            )),
            shutdown.clone(),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(
                listener,
                crate::router(state).into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap();
        });
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(3))
            .build()
            .unwrap();
        let known = format!("{base}/docs/art-direction.html?v=2");
        for method in [Method::GET, Method::HEAD] {
            let response = client.request(method, &known).send().await.unwrap();
            assert_eq!(response.status(), 308);
            assert_eq!(
                response.headers()["location"],
                "/docs/guides/art/art-direction.html?v=2"
            );
        }
        for (method, url) in [
            (Method::GET, format!("{base}/docs/unknown.md")),
            (Method::POST, known),
        ] {
            let response = client.request(method, url).send().await.unwrap();
            assert!(!response.status().is_redirection());
            assert!(!response.headers().contains_key("location"));
        }
        let resource = format!("{base}/data/scenes.json");
        let mut etags = Vec::new();
        for ((accept, encoding), bytes) in [
            ("br", Some("br")),
            ("br;q=0,gzip;q=1", Some("gzip")),
            ("br;q=0,gzip;q=0", None),
        ]
        .into_iter()
        .zip(old)
        {
            let response = client
                .get(&resource)
                .header("accept-encoding", accept)
                .header("origin", "https://huiyu.localhost")
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), 200);
            assert_eq!(
                response
                    .headers()
                    .get("content-encoding")
                    .map(|h| h.to_str().unwrap()),
                encoding
            );
            assert_eq!(response.headers()["cache-control"], "private, no-cache");
            if encoding.is_some() {
                let vary = response
                    .headers()
                    .get_all("vary")
                    .iter()
                    .map(|v| v.to_str().unwrap())
                    .collect::<Vec<_>>()
                    .join(",")
                    .to_lowercase();
                assert!(
                    vary.contains("origin") && vary.contains("accept-encoding"),
                    "{vary}"
                );
            }
            let tag = response.headers()["etag"].to_str().unwrap().to_owned();
            assert_eq!(response.bytes().await.unwrap().as_ref(), bytes);
            let fresh = client
                .get(&resource)
                .header("accept-encoding", accept)
                .header("if-none-match", &tag)
                .send()
                .await
                .unwrap();
            assert_eq!(fresh.status(), 304);
            assert!(fresh.bytes().await.unwrap().is_empty());
            etags.push(tag);
        }
        assert_ne!(etags[0], etags[1]);
        assert_ne!(etags[1], etags[2]);
        let new = variants(&file, br#"{"revision":"new"}"#);
        let changed = SystemTime::now() + Duration::from_secs(2);
        for suffix in ["", ".br", ".gz"] {
            std::fs::OpenOptions::new()
                .write(true)
                .open(format!("{}{suffix}", file.display()))
                .unwrap()
                .set_modified(changed)
                .unwrap();
        }
        let response = client
            .get(&resource)
            .header("accept-encoding", "br")
            .header("if-none-match", &etags[0])
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_ne!(response.headers()["etag"], etags[0]);
        assert_eq!(response.bytes().await.unwrap().as_ref(), new[0]);
        std::fs::remove_file(format!("{}.br", file.display())).unwrap();
        let missing = client
            .get(&resource)
            .header("accept-encoding", "br,gzip")
            .send()
            .await
            .unwrap();
        assert_eq!(missing.headers()["content-encoding"], "gzip");
        std::fs::remove_file(&file).unwrap();
        assert_eq!(
            client
                .get(&resource)
                .header("accept-encoding", "gzip")
                .send()
                .await
                .unwrap()
                .status(),
            404
        );
        shutdown.cancel();
        server.abort();
    }
}
