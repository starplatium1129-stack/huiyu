use super::{PUBLIC_DATA_FILES, is_private_asset_path, rooted};
use axum::{
    body::Body,
    extract::Request,
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use std::path::Path;
use tower_http::services::ServeFile;

fn mime(path: &str) -> Option<&'static str> {
    match path.rsplit_once('.')?.1.to_ascii_lowercase().as_str() {
        "js" => Some("application/javascript; charset=utf-8"),
        "css" => Some("text/css; charset=utf-8"),
        "html" => Some("text/html; charset=utf-8"),
        "json" | "map" => Some("application/json; charset=utf-8"),
        "svg" => Some("image/svg+xml; charset=utf-8"),
        "txt" => Some("text/plain; charset=utf-8"),
        _ => None,
    }
}
fn quality(header: &str, encoding: &str) -> f32 {
    let mut wildcard = None;
    let mut exact = None;
    for item in header.split(',') {
        let mut fields = item.trim().split(';');
        let name = fields.next().unwrap_or("").trim();
        let q = fields
            .find_map(|field| field.trim().strip_prefix("q="))
            .map(|q| {
                q.parse::<f32>()
                    .ok()
                    .filter(|q| q.is_finite() && (0.0..=1.0).contains(q))
                    .unwrap_or(0.0)
            })
            .unwrap_or(1.0);
        if name.eq_ignore_ascii_case(encoding) {
            exact = Some(q);
        } else if name == "*" {
            wildcard = Some(q);
        }
    }
    exact.or(wildcard).unwrap_or(0.0)
}

/// Invoke only after Host/token, remote projection and private path policy.
/// Never redirects mutable content into precompressed bytes before review.
pub async fn serve(
    root: &Path,
    assets: &Path,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
) -> Option<Response> {
    if !matches!(*method, Method::GET | Method::HEAD) {
        return None;
    }
    let raw = uri.path();
    if is_private_asset_path(raw) {
        return Some(StatusCode::NOT_FOUND.into_response());
    }
    let path = percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .ok()?;
    if path.contains(['\\', '\0']) || path.split('/').any(|part| part.starts_with('.')) {
        return None;
    }
    let content_type = mime(&path)?;
    let (base, relative, immutable) = if let Some(name) = path.strip_prefix("/assets/") {
        (assets.to_path_buf(), name.to_owned(), false)
    } else if let Some(name) = path.strip_prefix("/data/") {
        if !PUBLIC_DATA_FILES.contains(&name) {
            return None;
        }
        (root.to_path_buf(), format!("data/{name}"), false)
    } else if path == "/index.html" || path.starts_with("/_app/") {
        (
            root.to_path_buf(),
            format!("dist{path}"),
            path.starts_with("/_app/"),
        )
    } else if path.starts_with("/css/") || path.starts_with("/docs/") {
        (
            root.to_path_buf(),
            path.trim_start_matches('/').to_owned(),
            false,
        )
    } else {
        return None;
    };
    let encoding = headers
        .get("accept-encoding")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let source = rooted(&base, &relative).await.ok()?;
    let metadata = tokio::fs::metadata(source).await.ok()?;
    if !metadata.is_file() {
        return None;
    }
    let modified = metadata.modified().ok()?;
    let mut selected = None;
    for (name, suffix) in [("br", ".br"), ("gzip", ".gz")] {
        let q = quality(encoding, name);
        if q == 0.0 || selected.as_ref().is_some_and(|(_, _, score)| *score >= q) {
            continue;
        }
        let Ok(file) = rooted(&base, &format!("{relative}{suffix}")).await else {
            continue;
        };
        if tokio::fs::metadata(&file)
            .await
            .is_ok_and(|meta| meta.is_file() && meta.modified().is_ok_and(|time| time >= modified))
        {
            selected = Some((file, name, q));
        }
    }
    let (file, encoding, _) = selected?;
    let mut request = Request::new(Body::empty());
    *request.method_mut() = method.clone();
    *request.uri_mut() = uri.clone();
    *request.headers_mut() = headers.clone();
    let mut response = ServeFile::new(file)
        .try_call(request)
        .await
        .ok()?
        .map(Body::new);
    if response.status() == StatusCode::NOT_FOUND {
        return None;
    }
    response
        .headers_mut()
        .insert("content-type", HeaderValue::from_static(content_type));
    response
        .headers_mut()
        .insert("content-encoding", HeaderValue::from_static(encoding));
    response
        .headers_mut()
        .insert("vary", HeaderValue::from_static("Accept-Encoding"));
    response.headers_mut().insert(
        "cache-control",
        HeaderValue::from_static(if immutable {
            "public, max-age=31536000, immutable"
        } else {
            "private, no-cache"
        }),
    );
    Some(response)
}
