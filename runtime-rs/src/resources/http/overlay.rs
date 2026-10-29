use super::*;
use axum::{body::Body, extract::Request, http::Method, middleware::Next};
use futures_util::StreamExt;
use tower_http::services::ServeFile;
fn resource_path(raw: &str) -> Option<String> {
    let lower = raw.to_ascii_lowercase();
    if !(lower == "/assets" || lower.starts_with("/assets/"))
        || ["%2f", "%5c", "%25", "%00"]
            .iter()
            .any(|value| lower.contains(value))
    {
        return None;
    }
    let value = percent_encoding::percent_decode_str(raw)
        .decode_utf8()
        .ok()?;
    if value.chars().any(|c| c <= '\u{1f}' || "\\:%?#".contains(c))
        || value
            .split('/')
            .skip(1)
            .any(|part| part.is_empty() || part.starts_with('.'))
    {
        return None;
    }
    let relative = value.strip_prefix('/')?;
    Some(
        relative
            .strip_prefix("assets/live2d-current/")
            .map(|tail| format!("assets/live2d/{tail}"))
            .unwrap_or_else(|| relative.into()),
    )
}
fn mime(path: &str) -> &'static str {
    let extension = path.rsplit('.').next().unwrap_or("");
    [
        ("png", "image/png"),
        ("jpg", "image/jpeg"),
        ("jpeg", "image/jpeg"),
        ("webp", "image/webp"),
        ("avif", "image/avif"),
        ("gif", "image/gif"),
        ("ico", "image/x-icon"),
        ("mp3", "audio/mpeg"),
        ("ogg", "audio/ogg"),
        ("wav", "audio/wav"),
        ("flac", "audio/flac"),
        ("m4a", "audio/mp4"),
        ("mp4", "video/mp4"),
        ("webm", "video/webm"),
        ("json", "application/json; charset=utf-8"),
    ]
    .into_iter()
    .find_map(|(candidate, mime)| extension.eq_ignore_ascii_case(candidate).then_some(mime))
    .unwrap_or("application/octet-stream")
}
pub async fn overlay(
    State(service): State<Arc<Service>>,
    request: Request,
    next: Next,
) -> Response {
    let local = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .is_some_and(|peer| security::is_direct_local(request.headers(), peer.0.ip()));
    if !matches!(*request.method(), Method::GET | Method::HEAD)
        || !local
        || !request
            .headers()
            .get("host")
            .and_then(|value| value.to_str().ok())
            .is_some_and(security::host_allowed)
    {
        return next.run(request).await;
    }
    let Some(relative) = resource_path(request.uri().path()) else {
        return next.run(request).await;
    };
    // Frontend scripts, styles and fonts are bundled assets. They never need
    // to initialize the optional resource library before reaching ServeFile.
    if !crate::resources::resolve::serviceable(&relative) {
        return next.run(request).await;
    }
    let no_cache = request
        .headers()
        .get("cache-control")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(',').any(|part| part.trim() == "no-cache"));
    let condition = request.headers().get("if-none-match").cloned();
    let owner = service.clone();
    let name = relative.clone();
    let mounted = crate::resources::blocking(move || {
        let Some((_, snapshot)) = owner.mount(&name) else {
            return Ok(None);
        };
        let path = crate::resources::fs::child(&snapshot.root, &name)?;
        let stat = crate::resources::fs::safe(&path, true, false)?;
        Ok(stat
            .filter(|stat| stat.is_file())
            .map(|stat| (snapshot, path, stat)))
    })
    .await;
    let Ok(Some((snapshot, path, stat))) = mounted else {
        return next.run(request).await;
    };
    let modified = stat
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|time| time.as_nanos())
        .unwrap_or(0);
    let etag = format!("\"{}-{:x}-{modified:x}\"", snapshot.identity, stat.len());
    let fresh = !no_cache
        && condition
            .as_ref()
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value.split(',').any(|part| {
                    let part = part.trim().strip_prefix("W/").unwrap_or(part.trim());
                    part == "*" || part == etag
                })
            });
    // Installed content was admitted on import. Ordinary HTTP reads do not
    // rehash a file, preload a Live2D group or buffer complete response bodies.
    let mut response = if fresh {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        let mut request = request;
        if condition.is_some() {
            request.headers_mut().remove("if-modified-since");
        }
        match ServeFile::new_with_mime(path, &mime(&relative).parse().unwrap())
            .try_call(request)
            .await
        {
            Ok(response) => response.map(|body| {
                Body::from_stream(
                    Body::new(body)
                        .into_data_stream()
                        .take_until(service.read_cancel.clone().cancelled_owned()),
                )
            }),
            Err(_) => return StatusCode::NOT_FOUND.into_response(),
        }
    };
    let headers = response.headers_mut();
    headers.insert("cache-control", "private, no-cache".parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert("x-resource-version", snapshot.identity.parse().unwrap());
    headers.insert("etag", etag.parse().unwrap());
    response
}
