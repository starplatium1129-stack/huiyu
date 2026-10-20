use super::commands::{Query, text};
use crate::{
    AppState,
    error::{ApiError, Result},
    host::Session,
    http_media::{self, Source},
    security::{host_allowed, is_direct_local},
    storage::{Media, OpenedMedia, Storage},
};
use axum::{
    Json,
    body::{Body, Bytes},
    http::{HeaderMap, HeaderValue, Method},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::{net::IpAddr, time::Duration};
use tokio::io::AsyncReadExt;
use url::Url;

pub(super) async fn grant(
    state: &AppState,
    storage: &Storage,
    session: Session,
    input: &Value,
) -> Result<Response> {
    let alias = text(&input["alias"])?;
    resolve(storage, alias)
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
    storage: &Storage,
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
    let source = resolve(storage, alias).await?;
    let media = &source.media;
    let range = match http_media::range(header(headers, "range"), media.total_bytes) {
        Ok(range) => range,
        Err(response) => return Ok(response),
    };
    let mut response = http_media::stream(
        method,
        range,
        Source::Opened(source.file, source.closed),
        state.shutdown.clone(),
    )
    .await?;
    let output = response.headers_mut();
    output.insert(
        "content-type",
        HeaderValue::from_str(&media.mime)
            .map_err(|_| ApiError::new(503, "MEDIA_INVALID", "Invalid media type"))?,
    );
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
    Ok(response)
}

fn metadata_headers(response: &mut Response, media: &Media, offset: u64) -> Result<()> {
    let output = response.headers_mut();
    output.insert(
        "content-type",
        HeaderValue::from_static("application/octet-stream"),
    );
    for (name, value) in [
        ("x-workspace-media-mime", media.mime.clone()),
        ("x-workspace-media-offset", offset.to_string()),
        (
            "x-workspace-media-total-bytes",
            media.total_bytes.to_string(),
        ),
        ("x-workspace-media-sha256", media.sha256.clone()),
    ] {
        output.insert(
            name,
            HeaderValue::from_str(&value)
                .map_err(|_| ApiError::new(503, "MEDIA_INVALID", "Invalid media metadata"))?,
        );
    }
    output.insert("access-control-expose-headers", HeaderValue::from_static("X-Workspace-Media-Mime, X-Workspace-Media-Offset, X-Workspace-Media-Total-Bytes, X-Workspace-Media-Sha256"));
    Ok(())
}

pub(super) async fn download(
    state: &AppState,
    storage: &Storage,
    method: &Method,
    alias: &str,
) -> Result<Response> {
    let source = tokio::time::timeout(Duration::from_secs(30), storage.open_media(alias))
        .await
        .map_err(|_| ApiError::new(504, "WORKSPACE_TIMEOUT", "Media verification timed out"))??;
    download_opened(state, storage, method, alias, source)
}

pub(crate) fn download_opened(
    state: &AppState,
    storage: &Storage,
    method: &Method,
    alias: &str,
    source: crate::storage::OpenedMedia,
) -> Result<Response> {
    let length = source.media.total_bytes;
    if length == 0 {
        return Err(ApiError::new(409, "MEDIA_INVALID", "Media is empty"));
    }
    let mut response = Body::empty().into_response();
    metadata_headers(&mut response, &source.media, 0)?;
    response
        .headers_mut()
        .insert("content-length", length.to_string().parse().unwrap());
    if method == Method::HEAD {
        return Ok(response);
    }
    let closed = source.closed.clone();
    let stop = closed.clone();
    let stream = futures_util::stream::try_unfold(
        Some((source, storage.clone(), alias.to_owned(), length)),
        move |pending| {
            let closed = closed.clone();
            async move {
                let Some((mut source, storage, alias, remaining)) = pending else {
                    return Ok::<_, ApiError>(None);
                };
                let mut bytes = vec![0; remaining.min(64 * 1024) as usize];
                source.file.read_exact(&mut bytes).await?;
                let remaining = remaining - bytes.len() as u64;
                let pending = if remaining == 0 {
                    // Withhold the last block: a failed final proof must never
                    // deliver Content-Length bytes and complete response.blob().
                    tokio::time::timeout(
                        Duration::from_secs(30),
                        storage.finish_media(&alias, source),
                    )
                    .await
                    .map_err(|_| {
                        ApiError::new(504, "WORKSPACE_TIMEOUT", "Media verification timed out")
                    })??;
                    if closed.is_cancelled() {
                        return Err(ApiError::new(
                            503,
                            "WORKSPACE_UNAVAILABLE",
                            "Workspace closed during download",
                        ));
                    }
                    None
                } else {
                    Some((source, storage, alias, remaining))
                };
                Ok(Some((Bytes::from(bytes), pending)))
            }
        },
    );
    // Read only on demand; disconnect/epoch shutdown drops the owned file and
    // final-check waiter. No producer queue or path/checker lock spans the stream.
    *response.body_mut() = Body::from_stream(
        stream
            .take_until(stop.cancelled_owned())
            .take_until(state.shutdown.clone().cancelled_owned()),
    );
    Ok(response)
}

async fn resolve(storage: &Storage, alias: &str) -> Result<OpenedMedia> {
    tokio::time::timeout(Duration::from_secs(30), storage.open_media(alias))
        .await
        .map_err(|_| ApiError::new(504, "WORKSPACE_TIMEOUT", "Media verification timed out"))?
}
