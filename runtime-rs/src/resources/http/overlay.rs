use super::*;
use crate::resources::fs;
use axum::{
    body::{Body, Bytes},
    extract::Request,
    http::Method,
    middleware::Next,
};
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
    match path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "json" => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
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
    let head = request.method() == Method::HEAD;
    let no_cache = request
        .headers()
        .get("cache-control")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(',').any(|part| part.trim() == "no-cache"));
    let condition = request.headers().get("if-none-match").cloned();
    let owner = service.clone();
    let name = relative.clone();
    let mounted = crate::resources::blocking(move || Ok(owner.mount(&name))).await;
    let Ok(Some((configuration, snapshot))) = mounted else {
        return next.run(request).await;
    };
    let entry = snapshot.entries[&relative].clone();
    let etag = format!("\"{}\"", entry.sha256);
    let fresh = !no_cache
        && condition
            .as_ref()
            .and_then(|v| v.to_str().ok())
            .is_some_and(|value| {
                value.split(',').any(|part| {
                    let part = part.trim().strip_prefix("W/").unwrap_or(part.trim());
                    part == "*" || part == etag
                })
            });
    let group = relative
        .starts_with("assets/live2d/")
        .then(|| {
            snapshot
                .groups
                .iter()
                .enumerate()
                .find_map(|(group, value)| {
                    value
                        .paths
                        .iter()
                        .position(|name| name == &relative)
                        .map(|file| (group, file))
                })
        })
        .flatten();
    if relative.starts_with("assets/live2d/") && group.is_none() {
        return next.run(request).await;
    }
    let collect = !head && !fresh;
    let result = if group
        .is_some_and(|(group, _)| crate::resources::group_reads::size(&snapshot, group).is_some())
    {
        let (group, file) = group.unwrap();
        service
            .group_reads
            .get(&service, snapshot.clone(), group, file, collect)
            .await
            .map(|bytes| collect.then_some(bytes))
    } else {
        let (owner, snapshot, relative) = (service.clone(), snapshot.clone(), relative.clone());
        let entry = entry.clone();
        crate::resources::blocking(move || {
            if relative.starts_with("assets/live2d/") {
                let (group, _) = group.unwrap();
                for name in &snapshot.groups[group].paths {
                    if name != &relative
                        && !fs::file_matches(
                            &fs::child(&snapshot.root, name)?,
                            &snapshot.entries[name],
                            &owner.read_cancel,
                        )?
                    {
                        return Err(Error::new("CONTENT_INVALID", "Live2D dependency changed"));
                    }
                }
            }
            let file = fs::child(&snapshot.root, &entry.path)?;
            if collect {
                fs::verified_bytes(&file, &entry, &owner.read_cancel)
                    .map(|bytes| Some(Bytes::from(bytes)))
            } else if fs::file_matches(&file, &entry, &owner.read_cancel)? {
                Ok(None)
            } else {
                Err(Error::new("CONTENT_INVALID", "Installed bytes changed"))
            }
        })
        .await
    };
    let bytes = match result {
        Ok(bytes) => bytes,
        Err(error) if error.code == "RESOURCE_BUSY" => return super::failure(error, 503),
        Err(error) => {
            if error.code != "CANCELLED" {
                service.invalidate(&configuration, &snapshot, error);
            }
            return next.run(request).await;
        }
    };
    let version = snapshot.identity.clone();
    let (owner, name) = (service.clone(), relative.clone());
    let current = crate::resources::blocking(move || {
        Ok(owner
            .mount(&name)
            .is_some_and(|(latest_configuration, latest)| {
                Arc::ptr_eq(&configuration, &latest_configuration)
                    && Arc::ptr_eq(&snapshot, &latest)
            }))
    })
    .await;
    if !matches!(current, Ok(true)) {
        return next.run(request).await;
    }
    let (mime, length) = (mime(&relative), entry.bytes);
    let mut response = if fresh {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        bytes
            .map(Body::from)
            .unwrap_or_else(Body::empty)
            .into_response()
    };
    let headers = response.headers_mut();
    headers.insert("cache-control", "private, no-cache".parse().unwrap());
    headers.insert("x-content-type-options", "nosniff".parse().unwrap());
    headers.insert("x-resource-version", version.parse().unwrap());
    headers.insert("etag", etag.parse().unwrap());
    headers.insert("content-type", mime.parse().unwrap());
    if !fresh {
        headers.insert("content-length", length.to_string().parse().unwrap());
    }
    response
}
