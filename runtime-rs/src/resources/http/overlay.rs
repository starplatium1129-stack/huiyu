use super::*;
use crate::resources::{fs, manifest};
use axum::{body::Body, extract::Request, http::Method, middleware::Next};
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
fn bytes(root: &std::path::Path, entry: &manifest::Entry) -> Result<Vec<u8>> {
    let value = fs::bytes(&fs::child(root, &entry.path)?, entry.bytes, false)?;
    if value.len() as u64 != entry.bytes || crate::resources::digest(&value) != entry.sha256 {
        return Err(Error::new("CONTENT_INVALID", "Installed bytes changed"));
    }
    Ok(value)
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
    let owner = service.clone();
    let loaded = crate::resources::blocking(move || {
        let Some((configuration, snapshot)) = owner.mount() else {
            return Ok(None);
        };
        let Some(entry) = snapshot.entries.get(&relative) else {
            return Ok(None);
        };
        let result = (|| {
            if relative.starts_with("assets/live2d/") {
                let Some(group) = snapshot
                    .groups
                    .iter()
                    .find(|group| group.paths.contains(&relative))
                else {
                    return Ok(None);
                };
                for name in &group.paths {
                    let entry = &snapshot.entries[name];
                    if !fs::file_matches(
                        &fs::child(&snapshot.root, name)?,
                        entry,
                        &configuration.ctx.shutdown,
                    )? {
                        return Err(Error::new("CONTENT_INVALID", "Live2D dependency changed"));
                    }
                }
            }
            let bytes = bytes(&snapshot.root, entry)?;
            let Some((_, latest)) = owner.mount() else {
                return Ok(None);
            };
            if latest.sequence != snapshot.sequence || latest.identity != snapshot.identity {
                return Ok(None);
            }
            Ok(Some((
                bytes,
                entry.sha256.clone(),
                snapshot.identity.clone(),
                mime(&relative),
            )))
        })();
        if let Err(error) = result {
            owner.invalidate(error);
            return Ok(None);
        }
        result
    })
    .await;
    let Ok(Some((bytes, hash, version, mime))) = loaded else {
        return next.run(request).await;
    };
    let etag = format!("\"{hash}\"");
    let fresh = !request
        .headers()
        .get("cache-control")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(',').any(|part| part.trim() == "no-cache"))
        && request
            .headers()
            .get("if-none-match")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| {
                value.split(',').any(|part| {
                    let part = part.trim().strip_prefix("W/").unwrap_or(part.trim());
                    part == "*" || part == etag
                })
            });
    let length = bytes.len();
    let mut response = if fresh {
        StatusCode::NOT_MODIFIED.into_response()
    } else if request.method() == Method::HEAD {
        Body::empty().into_response()
    } else {
        Body::from(bytes).into_response()
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
