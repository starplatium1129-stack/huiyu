use crate::http_media::Source;
use crate::images::{ApiError, Result, inputs};
use axum::{
    body::Bytes,
    http::{Method, header},
    response::{IntoResponse, Response},
};
use sha2::{Digest, Sha256};
use std::io::SeekFrom;
use tokio::io::{AsyncReadExt, AsyncSeekExt};

pub(in crate::images) const PART_BYTES: u64 = 128 * 1024;

pub(super) async fn serve(
    source: Source,
    total: u64,
    digest: &str,
    index: &str,
    count: Option<&String>,
    method: &Method,
) -> Result<Response> {
    let start = index
        .parse::<u64>()
        .ok()
        .and_then(|i| i.checked_mul(PART_BYTES))
        .filter(|&start| start < total)
        .ok_or_else(|| {
            ApiError::new(
                416,
                "RESULT_PART_INVALID",
                "分片从 0 开始，编号超出原图范围",
            )
        })?;
    let count = count
        .map_or(Some(1), |s| s.parse::<u64>().ok())
        .filter(|n| (1..=16).contains(n))
        .ok_or_else(|| ApiError::invalid("每次可取 1 至 16 片原图"))?;
    let size = (total - start).min(PART_BYTES * count) as usize;
    let bytes = match source {
        Source::Bytes(bytes) => bytes.slice(start as usize..start as usize + size),
        Source::Opened(mut file, cancel) => {
            let mut part = vec![0; size];
            tokio::select! {
                _ = cancel.cancelled() => return Err(inputs::cancelled()),
                io = async {
                    file.seek(SeekFrom::Start(start)).await?;
                    file.read_exact(&mut part).await
                } => { io?; }
            }
            Bytes::from(part)
        }
        Source::Path(_) => return Err(ApiError::new(500, "RESULT_SOURCE_INVALID", "原图尚未打开")),
    };
    let part_digest = hex::encode(Sha256::digest(&bytes));
    let body = if method == Method::HEAD {
        Bytes::new()
    } else {
        bytes
    };
    Ok((
        [
            (
                header::CONTENT_TYPE.as_str(),
                "application/octet-stream".to_owned(),
            ),
            (header::CONTENT_LENGTH.as_str(), size.to_string()),
            (
                header::CACHE_CONTROL.as_str(),
                "private, no-store, no-transform".to_owned(),
            ),
            ("x-content-type-options", "nosniff".to_owned()),
            ("x-result-offset", start.to_string()),
            ("x-result-bytes", total.to_string()),
            ("x-result-sha256", digest.to_owned()),
            ("x-part-sha256", part_digest),
        ],
        body,
    )
        .into_response())
}
