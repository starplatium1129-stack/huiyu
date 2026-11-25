use super::super::*;
use super::{MAX_PART_COUNT, MuseVideo, PART_BYTES};
use crate::{
    AppState,
    file_identity::Version,
    http_media::{self, Source},
};
use axum::{
    body::Bytes,
    http::{HeaderMap, HeaderValue, Method, header},
    response::{IntoResponse, Response},
};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    io::{Read as _, Seek as _, SeekFrom},
};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

pub(super) async fn open_verified_video(
    muse: &MuseVideo,
    config: &Config,
    path: PathBuf,
    expected_bytes: u64,
    cancel: &CancellationToken,
) -> Result<(tokio::fs::File, String)> {
    let root = tokio::fs::canonicalize(config.runtime_root.join("outputs/video"))
        .await
        .map_err(|_| error(404, "RESULT_NOT_FOUND", "视频结果不存在"))?;
    let canonical = tokio::fs::canonicalize(path)
        .await
        .map_err(|_| error(404, "RESULT_NOT_FOUND", "视频结果不存在"))?;
    if !canonical.starts_with(&root) {
        return Err(error(404, "RESULT_NOT_FOUND", "视频结果不存在"));
    }
    let scope = cancel.child_token();
    let _guard = scope.clone().drop_guard();
    let check_path = canonical.clone();
    let (file, version) = tokio::task::spawn_blocking(move || -> Result<(std::fs::File, Version)> {
        let file = std::fs::File::open(&check_path)
            .map_err(|_| error(404, "RESULT_NOT_FOUND", "视频结果不存在"))?;
        let meta = file.metadata()?;
        if !meta.is_file() {
            return Err(error(404, "RESULT_NOT_FOUND", "视频结果不存在"));
        }
        if meta.len() != expected_bytes {
            return Err(error(409, "RESULT_CHANGED", "视频结果在读取前发生变化"));
        }
        let version = Version::of(&file)?;
        Ok((file, version))
    })
    .await
    .map_err(|_| error(503, "RESULT_UNAVAILABLE", "视频结果读取未完成"))??;

    if let Some(sha256) = muse.cached_digest(&canonical, &version) {
        return Ok((tokio::fs::File::from_std(file), sha256));
    }
    let hash_cancel = scope.clone();
    let (file, sha256) =
        tokio::task::spawn_blocking(move || -> Result<(std::fs::File, String)> {
            let mut file = file;
            let mut hasher = Sha256::new();
            let mut buffer = vec![0u8; 256 * 1024];
            let mut read_total = 0u64;
            loop {
                if hash_cancel.is_cancelled() {
                    return Err(error(499, "CANCELLED", "视频校验已取消"));
                }
                let count = file.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                hasher.update(&buffer[..count]);
                read_total += count as u64;
                if read_total > expected_bytes {
                    return Err(error(409, "RESULT_CHANGED", "视频结果在校验期间发生变化"));
                }
            }
            if read_total != expected_bytes {
                return Err(error(409, "RESULT_CHANGED", "视频结果在校验期间发生变化"));
            }
            file.seek(SeekFrom::Start(0))?;
            Ok((file, hex::encode(hasher.finalize())))
        })
        .await
        .map_err(|_| error(503, "RESULT_UNAVAILABLE", "视频校验未完成"))??;
    muse.remember_digest(canonical, version, sha256.clone());
    Ok((tokio::fs::File::from_std(file), sha256))
}

async fn serve_part(
    mut file: tokio::fs::File,
    total: u64,
    mime: &str,
    digest: &str,
    part_index: &str,
    count: Option<&String>,
    method: &Method,
    cancel: CancellationToken,
) -> Result<Response> {
    let start = part_index
        .parse::<u64>()
        .ok()
        .and_then(|index| index.checked_mul(PART_BYTES))
        .filter(|&start| start < total)
        .ok_or_else(|| {
            error(
                416,
                "RESULT_PART_INVALID",
                "分片从 0 开始，编号超出视频范围",
            )
        })?;
    let count = count
        .map_or(Some(1), |s| s.parse::<u64>().ok())
        .filter(|n| (1..=MAX_PART_COUNT).contains(n))
        .ok_or_else(|| ApiError::invalid("每次可取 1 至 16 片视频分片"))?;
    let size = (total - start).min(PART_BYTES * count) as usize;
    let mut part = vec![0u8; size];
    tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(error(499, "CANCELLED", "视频分片读取已取消")),
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

pub(super) async fn serve_video_output(
    state: &AppState,
    muse: &MuseVideo,
    service: &Service,
    output: Output,
    query: &HashMap<String, String>,
    headers: &HeaderMap,
    method: &Method,
) -> Result<Response> {
    let Output::File { path, mime, bytes } = output else {
        return Err(error(404, "RESULT_NOT_FOUND", "视频结果不存在"));
    };
    if bytes == 0 {
        return Err(error(404, "RESULT_NOT_FOUND", "视频结果为空"));
    }
    let (file, digest) =
        open_verified_video(muse, &service.config, path, bytes, &state.shutdown).await?;
    if let Some(part) = query.get("part") {
        if headers.contains_key(header::RANGE) {
            return Err(ApiError::invalid(
                "分片请求无需 Range；请单独使用 part 或 Range",
            ));
        }
        return serve_part(
            file,
            bytes,
            &mime,
            &digest,
            part,
            query.get("count"),
            method,
            state.shutdown.clone(),
        )
        .await;
    }
    let etag = format!("\"{digest}\"");
    let range_header = headers
        .get(header::RANGE)
        .filter(|_| {
            *method == Method::GET
                && headers
                    .get(header::IF_RANGE)
                    .is_none_or(|value| value.as_bytes() == etag.as_bytes())
        })
        .map(|value| value.to_str().unwrap_or(""));
    let mut response = match http_media::range(range_header, bytes) {
        Ok(range) => {
            http_media::stream(
                method,
                range,
                Source::Opened(file, service.shutdown.clone()),
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
        HeaderValue::from_str(&bytes.to_string()).unwrap(),
    );
    out_headers.insert(
        "x-result-sha256",
        HeaderValue::from_str(&digest).unwrap(),
    );
    Ok(response)
}
