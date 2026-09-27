use super::commands::{Query, text};
use crate::{
    AppState,
    error::{ApiError, Result},
    host::Session,
    security::{host_allowed, is_direct_local},
    storage::Media,
};
use axum::{
    Json,
    body::Body,
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{io::SeekFrom, net::IpAddr, time::Duration};
use tokio::{
    fs::File,
    io::{AsyncReadExt, AsyncSeekExt},
};
use tokio_util::io::ReaderStream;
use url::Url;

pub(super) async fn grant(state: &AppState, session: Session, input: &Value) -> Result<Response> {
    let alias = text(&input["alias"])?;
    resolve(state, alias)
        .await
        .map_err(|_| ApiError::new(404, "MEDIA_UNAVAILABLE", "Media is unavailable"))?;
    let (cap, expires) = state.host.grant_media(alias.into(), session)?;
    let encoded: String = url::form_urlencoded::byte_serialize(alias.as_bytes())
        .collect::<String>()
        .replace('+', "%20");
    Ok(Json(json!({"url": format!("/api/workspace/media-content/{encoded}?cap={cap}"), "expiresAt": expires})).into_response())
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name)?.to_str().ok()
}

pub(super) async fn serve(
    state: &AppState,
    headers: &HeaderMap,
    peer: IpAddr,
    method: &Method,
    alias: &str,
    query: &Query,
) -> Result<Response> {
    let denied = || {
        ApiError::new(
            401,
            "WORKSPACE_AUTH",
            "Media capability is invalid or expired",
        )
    };
    let grant = query
        .get("cap")
        .and_then(|key| state.host.media_grant(key))
        .ok_or_else(denied)?;
    let storage = state
        .host
        .storage()
        .expect("Storage was checked by workspace router");
    let origin = if headers.contains_key("origin") {
        header(headers, "origin").map(str::to_owned)
    } else {
        header(headers, "referer")
            .and_then(|s| Url::parse(s).ok())
            .map(|url| url.origin().ascii_serialization())
    };
    let granted = Url::parse(&grant.session.origin).map_err(|_| denied())?;
    let same_origin_media = !headers.contains_key("origin")
        && !headers.contains_key("referer")
        && header(headers, "sec-fetch-site") == Some("same-origin")
        && granted.scheme() == "http"
        && granted[url::Position::BeforeHost..url::Position::AfterPort]
            .eq_ignore_ascii_case(header(headers, "host").unwrap_or(""));
    let mut effective = headers.clone();
    if let Some(origin) = &origin {
        effective.insert(
            "origin",
            HeaderValue::from_str(origin).map_err(|_| denied())?,
        );
    }
    if grant.alias != alias
        || grant.session.workspace_id != storage.workspace_id()
        || grant.session.runtime_epoch != storage.runtime_epoch()
        || (!same_origin_media && origin.as_deref() != Some(&grant.session.origin))
        || !host_allowed(header(headers, "host").unwrap_or(""))
        || !is_direct_local(&effective, peer)
    {
        return Err(denied());
    }
    let media = resolve(state, alias).await?;
    let range = match range(header(headers, "range"), media.total_bytes) {
        Ok(range) => range,
        Err(_) => {
            return Ok((
                StatusCode::RANGE_NOT_SATISFIABLE,
                [("content-range", format!("bytes */{}", media.total_bytes))],
            )
                .into_response());
        }
    };
    let mut response = stream(state, method, &media, range.start, range.length).await?;
    let output = response.headers_mut();
    output.insert(
        "content-type",
        HeaderValue::from_str(&media.mime)
            .map_err(|_| ApiError::new(503, "MEDIA_INVALID", "Invalid media type"))?,
    );
    output.insert("accept-ranges", HeaderValue::from_static("bytes"));
    output.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    output.insert(
        "cross-origin-resource-policy",
        HeaderValue::from_static("cross-origin"),
    );
    if let Some(origin) = origin {
        output.insert(
            "access-control-allow-origin",
            HeaderValue::from_str(&origin).map_err(|_| denied())?,
        );
    }
    if range.partial {
        output.insert(
            "content-range",
            format!(
                "bytes {}-{}/{}",
                range.start,
                range.start + range.length - 1,
                media.total_bytes
            )
            .parse()
            .unwrap(),
        );
        *response.status_mut() = StatusCode::PARTIAL_CONTENT;
    }
    Ok(response)
}

pub(super) async fn chunk(state: &AppState, method: &Method, command: &Value) -> Result<Response> {
    let media = resolve(state, command["alias"].as_str().unwrap()).await?;
    let offset = command["offset"].as_u64().unwrap();
    if offset > media.total_bytes {
        return Err(ApiError::invalid("Invalid media read range"));
    }
    let length = command["length"]
        .as_u64()
        .unwrap()
        .min(media.total_bytes - offset);
    let mut response = stream(state, method, &media, offset, length).await?;
    let output = response.headers_mut();
    output.insert(
        "content-type",
        HeaderValue::from_static("application/octet-stream"),
    );
    for (name, value) in [
        ("x-workspace-media-mime", media.mime),
        ("x-workspace-media-offset", offset.to_string()),
        (
            "x-workspace-media-total-bytes",
            media.total_bytes.to_string(),
        ),
        ("x-workspace-media-sha256", media.sha256),
    ] {
        output.insert(
            name,
            HeaderValue::from_str(&value)
                .map_err(|_| ApiError::new(503, "MEDIA_INVALID", "Invalid media metadata"))?,
        );
    }
    output.insert("access-control-expose-headers", HeaderValue::from_static("X-Workspace-Media-Mime, X-Workspace-Media-Offset, X-Workspace-Media-Total-Bytes, X-Workspace-Media-Sha256"));
    Ok(response)
}

async fn resolve(state: &AppState, alias: &str) -> Result<Media> {
    let storage = state
        .host
        .storage()
        .expect("Storage was checked by workspace router");
    tokio::time::timeout(Duration::from_secs(30), storage.media(alias))
        .await
        .map_err(|_| ApiError::new(504, "WORKSPACE_TIMEOUT", "Media verification timed out"))?
}

pub(crate) async fn stream(
    state: &AppState,
    method: &Method,
    media: &Media,
    start: u64,
    length: u64,
) -> Result<Response> {
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        let mut file = File::open(&media.path).await?;
        file.seek(SeekFrom::Start(start)).await?;
        // ReaderStream only reads when the HTTP consumer polls it. Dropping the
        // body on disconnect closes the file; no background producer or queue.
        Body::from_stream(
            ReaderStream::with_capacity(file.take(length), 64 * 1024)
                .take_until(state.shutdown.clone().cancelled_owned()),
        )
    };
    let mut response = body.into_response();
    response
        .headers_mut()
        .insert("content-length", length.to_string().parse().unwrap());
    Ok(response)
}

#[derive(Debug, PartialEq)]
pub(crate) struct ByteRange {
    pub start: u64,
    pub length: u64,
    pub partial: bool,
}
pub(crate) fn range(header: Option<&str>, total: u64) -> std::result::Result<ByteRange, ()> {
    let Some(header) = header else {
        return Ok(ByteRange {
            start: 0,
            length: total,
            partial: false,
        });
    };
    let (first, last) = header
        .strip_prefix("bytes=")
        .ok_or(())?
        .split_once('-')
        .ok_or(())?;
    if total == 0
        || (first.is_empty() && last.is_empty())
        || !first
            .bytes()
            .chain(last.bytes())
            .all(|b| b.is_ascii_digit())
    {
        return Err(());
    }
    let (start, end) = if first.is_empty() {
        let suffix: u64 = last.parse().map_err(|_| ())?;
        if suffix == 0 {
            return Err(());
        }
        (total.saturating_sub(suffix), total - 1)
    } else {
        let start = first.parse::<u64>().map_err(|_| ())?;
        let end = if last.is_empty() {
            total - 1
        } else {
            last.parse::<u64>().map_err(|_| ())?.min(total - 1)
        };
        (start, end)
    };
    if start > end || start >= total {
        return Err(());
    }
    Ok(ByteRange {
        start,
        length: end - start + 1,
        partial: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn range_handles_suffix_and_rejects_ambiguous_or_empty_requests() {
        assert_eq!(
            range(Some("bytes=-3"), 8).unwrap(),
            ByteRange {
                start: 5,
                length: 3,
                partial: true
            }
        );
        assert_eq!(
            range(Some("bytes=3-99"), 8).unwrap(),
            ByteRange {
                start: 3,
                length: 5,
                partial: true
            }
        );
        for invalid in [
            "bytes=8-",
            "bytes=-0",
            "bytes=1-2,4-5",
            "bytes=+1-2",
            "bytes=-",
        ] {
            assert!(range(Some(invalid), 8).is_err());
        }
        assert_eq!(range(None, 0).unwrap().length, 0);
    }
}
