//! HTTP byte ranges and on-demand file delivery, after the caller authorizes its source.
use axum::{
    body::Body,
    http::{Method, StatusCode},
    response::{IntoResponse, Response},
};
use futures_util::StreamExt;
use std::{io::SeekFrom, path::PathBuf};
use tokio::{fs::File, io::{AsyncReadExt, AsyncSeekExt}};
use tokio_util::{io::ReaderStream, sync::CancellationToken};

pub(crate) enum Source {
    Opened(File, CancellationToken),
    // Provider results have no workspace lifetime. HEAD must not open their file.
    Path(PathBuf),
}

pub(crate) struct ByteRange {
    start: u64,
    length: u64,
    total: u64,
    partial: bool,
}

pub(crate) fn range(header: Option<&str>, total: u64) -> Result<ByteRange, Response> {
    parse_range(header, total).map_err(|()| {
        (StatusCode::RANGE_NOT_SATISFIABLE, [("content-range", format!("bytes */{total}"))])
            .into_response()
    })
}

fn parse_range(header: Option<&str>, total: u64) -> Result<ByteRange, ()> {
    let Some(header) = header else {
        return Ok(ByteRange { start: 0, length: total, total, partial: false });
    };
    let (first, last) = header
        .strip_prefix("bytes=")
        .ok_or(())?
        .split_once('-')
        .ok_or(())?;
    if total == 0
        || (first.is_empty() && last.is_empty())
        || !first.bytes().chain(last.bytes()).all(|b| b.is_ascii_digit())
    {
        return Err(());
    }
    let (start, end) = if first.is_empty() {
        let suffix: u64 = last.parse().map_err(|_| ())?;
        if suffix == 0 { return Err(()); }
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
    if start > end || start >= total { return Err(()); }
    Ok(ByteRange { start, length: end - start + 1, total, partial: true })
}

pub(crate) async fn stream(
    method: &Method,
    range: ByteRange,
    source: Source,
    shutdown: CancellationToken,
) -> std::io::Result<Response> {
    let body = if method == Method::HEAD {
        Body::empty()
    } else {
        let (mut file, closed) = match source {
            Source::Opened(file, closed) => (file, closed),
            Source::Path(path) => (File::open(path).await?, shutdown.clone()),
        };
        file.seek(SeekFrom::Start(range.start)).await?;
        // Disconnect and either source/runtime shutdown drop the owned file;
        // no producer queue or background file reader outlives this body.
        Body::from_stream(
            ReaderStream::with_capacity(file.take(range.length), 64 * 1024)
                .take_until(closed.cancelled_owned())
                .take_until(shutdown.cancelled_owned()),
        )
    };
    let mut response = body.into_response();
    let headers = response.headers_mut();
    headers.insert("content-length", range.length.to_string().parse().unwrap());
    headers.insert("accept-ranges", "bytes".parse().unwrap());
    if range.partial {
        headers.insert(
            "content-range",
            format!("bytes {}-{}/{}", range.start, range.start + range.length - 1, range.total)
                .parse().unwrap(),
        );
        *response.status_mut() = StatusCode::PARTIAL_CONTENT;
    }
    Ok(response)
}
