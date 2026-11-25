use super::{
    MAX_PART_COUNT, PART_BYTES,
    gallery::{lookup_artwork, require_storage},
    sanitize::safe_alias,
};
use crate::{
    AppState,
    error::{ApiError, Result},
    http_media::{self, Source},
};
use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, Method, header},
    response::{IntoResponse, Response},
};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, io::SeekFrom, time::Duration};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

async fn serve_gallery_part(
    mut file: tokio::fs::File,
    total: u64,
    mime: &str,
    digest: &str,
    part_index: &str,
    count: Option<&String>,
    method: &Method,
    closed: tokio_util::sync::CancellationToken,
    shutdown: tokio_util::sync::CancellationToken,
) -> Result<Response> {
    let start = part_index
        .parse::<u64>()
        .ok()
        .and_then(|index| index.checked_mul(PART_BYTES))
        .filter(|&start| start < total)
        .ok_or_else(|| {
            ApiError::new(
                416,
                "RESULT_PART_INVALID",
                "分片从 0 开始，编号超出作品文件范围",
            )
        })?;
    let count = count
        .map_or(Some(1), |s| s.parse::<u64>().ok())
        .filter(|n| (1..=MAX_PART_COUNT).contains(n))
        .ok_or_else(|| ApiError::invalid("每次可取 1 至 16 片作品分片"))?;
    let size = (total - start).min(PART_BYTES * count) as usize;
    let mut part = vec![0u8; size];
    tokio::select! {
        biased;
        _ = closed.cancelled() => return Err(ApiError::new(503, "MEDIA_CLOSED", "作品媒体已关闭")),
        _ = shutdown.cancelled() => return Err(ApiError::new(499, "CANCELLED", "作品下载已取消")),
        io = async {
            file.seek(SeekFrom::Start(start)).await?;
            file.read_exact(&mut part).await
        } => { io?; }
    }
    let part_digest = hex::encode(Sha256::digest(&part));
    let body = if *method == Method::HEAD {
        Bytes::new()
    } else {
        Bytes::from(part)
    };
    let mut response = body.into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    headers.insert(
        header::CONTENT_LENGTH,
        HeaderValue::from_str(&size.to_string()).unwrap(),
    );
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("private, no-store, no-transform"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if let Ok(value) = HeaderValue::from_str(mime) {
        headers.insert("x-result-mime", value);
    }
    headers.insert(
        "x-result-offset",
        HeaderValue::from_str(&start.to_string()).unwrap(),
    );
    headers.insert(
        "x-result-bytes",
        HeaderValue::from_str(&total.to_string()).unwrap(),
    );
    headers.insert("x-result-sha256", HeaderValue::from_str(digest).unwrap());
    headers.insert(
        "x-part-sha256",
        HeaderValue::from_str(&part_digest).unwrap(),
    );
    headers.insert(
        "x-part-bytes",
        HeaderValue::from_str(&PART_BYTES.to_string()).unwrap(),
    );
    Ok(response)
}

pub(super) async fn gallery_file(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
    headers: HeaderMap,
    method: Method,
) -> Response {
    match async {
        state.host.check_running()?;
        let storage = require_storage(&state)?;
        let id_type = query.get("idType").map(String::as_str);
        let record = lookup_artwork(&storage, &id, id_type).await?;
        let alias = safe_alias(&record["body"]).ok_or_else(|| {
            ApiError::new(
                404,
                "GALLERY_MEDIA_NOT_FOUND",
                "该作品没有可读取的媒体文件",
            )
        })?;
        let source = tokio::time::timeout(Duration::from_secs(30), storage.open_media(alias))
            .await
            .map_err(|_| ApiError::new(504, "WORKSPACE_TIMEOUT", "读取作品媒体超时"))??;
        let total = source.media.total_bytes;
        if total == 0 {
            return Err(ApiError::new(404, "GALLERY_MEDIA_NOT_FOUND", "作品媒体为空"));
        }
        let mime = source.media.mime.clone();
        let digest = source.media.sha256.clone();

        if let Some(part) = query.get("part") {
            if headers.contains_key(header::RANGE) {
                return Err(ApiError::invalid(
                    "分片请求无需 Range；请单独使用 part 或 Range",
                ));
            }
            return serve_gallery_part(
                source.file,
                total,
                &mime,
                &digest,
                part,
                query.get("count"),
                &method,
                source.closed,
                state.shutdown.clone(),
            )
            .await;
        }

        let etag = format!("\"{digest}\"");
        let range_header = headers
            .get(header::RANGE)
            .filter(|_| {
                method == Method::GET
                    && headers
                        .get(header::IF_RANGE)
                        .is_none_or(|value| value.as_bytes() == etag.as_bytes())
            })
            .map(|value| value.to_str().unwrap_or(""));
        let mut response = match http_media::range(range_header, total) {
            Ok(range) => {
                http_media::stream(
                    &method,
                    range,
                    Source::Opened(source.file, source.closed),
                    state.shutdown.clone(),
                )
                .await?
            }
            Err(response) => response,
        };
        let out_headers = response.headers_mut();
        out_headers.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("private, no-store, no-transform"),
        );
        out_headers.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        out_headers.insert(
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        );
        if let Ok(value) = HeaderValue::from_str(&mime) {
            out_headers.insert(header::CONTENT_TYPE, value);
        }
        if let Ok(value) = HeaderValue::from_str(&etag) {
            out_headers.insert(header::ETAG, value);
        }
        out_headers.insert(
            "x-result-bytes",
            HeaderValue::from_str(&total.to_string()).unwrap(),
        );
        out_headers.insert("x-result-sha256", HeaderValue::from_str(&digest).unwrap());
        Ok::<_, ApiError>(response)
    }
    .await
    {
        Ok(response) => response,
        Err(err) => err.into_response(),
    }
}
