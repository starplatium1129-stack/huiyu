use futures_util::StreamExt;
use reqwest::{
    Response,
    header::{CONTENT_LENGTH, HeaderMap},
};
use std::{
    io,
    time::{Duration, Instant},
};
use tokio::io::{AsyncWrite, AsyncWriteExt};
use tokio_util::sync::CancellationToken;

#[derive(Debug)]
pub(crate) enum Error {
    Cancelled,
    Timeout,
    Network,
    Status(u16),
    Redirect,
    Encoding,
    Size,
    Range,
    Incomplete,
    Io(io::Error),
}
pub(crate) enum CopyError<E> {
    Transfer(Error),
    Observer(E),
}
pub(crate) enum CopyEvent {
    BeforeWrite,
    AfterWrite { received: u64, report: bool },
}

// Public files retain the original revision/path and are still verified by
// the caller's fixed digest. Credential-bearing requests must not use this.
pub(crate) fn public_mirror(url: &str) -> Option<String> {
    if let Some(path) = url.strip_prefix("https://huggingface.co/") {
        return path.contains("/resolve/").then(|| format!("https://hf-mirror.com/{path}"));
    }
    for origin in ["https://download.pytorch.org/whl/", "https://download-r2.pytorch.org/whl/"] {
        if let Some(path) = url.strip_prefix(origin) {
            return Some(format!("https://mirrors.nju.edu.cn/pytorch/whl/{path}"));
        }
    }
    url.strip_prefix("https://files.pythonhosted.org/packages/")
        .map(|path| format!("https://pypi.tuna.tsinghua.edu.cn/packages/{path}"))
}

/** The caller supplies its authorized URL/client policy. This layer never chooses destinations or publishes files. */
pub(crate) async fn response(
    client: &reqwest::Client,
    url: url::Url,
    headers: HeaderMap,
    timeout: Duration,
    cancel: &CancellationToken,
    reject_redirects: bool,
) -> Result<Response, Error> {
    let request = client
        .get(url)
        .headers(headers)
        .header("accept-encoding", "identity")
        .send();
    let response = tokio::select! {
        biased;
        _ = cancel.cancelled() => return Err(Error::Cancelled),
        response = tokio::time::timeout(timeout, request) => response.map_err(|_| Error::Timeout)?.map_err(|_| Error::Network)?,
    };
    if reject_redirects && response.status().is_redirection() {
        return Err(Error::Redirect);
    }
    if response
        .headers()
        .get("content-encoding")
        .is_some_and(|encoding| encoding != "identity")
    {
        return Err(Error::Encoding);
    }
    Ok(response)
}
pub(crate) fn length(response: &Response) -> Result<Option<u64>, Error> {
    response
        .headers()
        .get(CONTENT_LENGTH)
        .map(|header| {
            header
                .to_str()
                .ok()
                .filter(|text| !text.is_empty() && text.bytes().all(|byte| byte.is_ascii_digit()))
                .and_then(|text| text.parse::<u64>().ok())
                .filter(|value| *value <= 9_007_199_254_740_991)
                .ok_or(Error::Size)
        })
        .transpose()
}
pub(crate) fn range(
    response: &Response,
    offset: u64,
    total: u64,
    etag: Option<&str>,
) -> Result<u64, Error> {
    let length = length(response)?;
    if response.status() == reqwest::StatusCode::OK {
        if length.is_some_and(|length| length != total) {
            return Err(Error::Size);
        }
        return Ok(0);
    }
    if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(Error::Status(response.status().as_u16()));
    }
    let expected = format!("bytes {offset}-{}/{}", total.saturating_sub(1), total);
    if total == 0
        || offset >= total
        || response
            .headers()
            .get("content-range")
            .and_then(|value| value.to_str().ok())
            != Some(expected.as_str())
        || length.is_some_and(|length| length != total - offset)
        || etag.is_some_and(|etag| {
            response
                .headers()
                .get("etag")
                .and_then(|value| value.to_str().ok())
                != Some(etag)
        })
    {
        return Err(Error::Range);
    }
    Ok(offset)
}
/** Observer checks run before and after every write; only progress notification is throttled. Flush/sync remains with the file owner. */
pub(crate) async fn copy<W: AsyncWrite + Unpin, E>(
    response: Response,
    output: &mut W,
    start: u64,
    total: u64,
    idle: Duration,
    cancel: &CancellationToken,
    mut observe: impl FnMut(CopyEvent) -> Result<(), E>,
) -> Result<u64, CopyError<E>> {
    let mut received = start;
    let mut stream = response.bytes_stream();
    let mut progress: Option<Instant> = None;
    loop {
        let next = tokio::select! {
            biased;
            _ = cancel.cancelled() => return Err(CopyError::Transfer(Error::Cancelled)),
            next = tokio::time::timeout(idle, stream.next()) => next.map_err(|_| CopyError::Transfer(Error::Timeout))?,
        };
        let Some(chunk) = next else {
            break;
        };
        let chunk = chunk.map_err(|_| CopyError::Transfer(Error::Network))?;
        observe(CopyEvent::BeforeWrite).map_err(CopyError::Observer)?;
        let next = received
            .checked_add(chunk.len() as u64)
            .filter(|count| *count <= total)
            .ok_or(CopyError::Transfer(Error::Size))?;
        output
            .write_all(&chunk)
            .await
            .map_err(|error| CopyError::Transfer(Error::Io(error)))?;
        received = next;
        let report = progress.is_none_or(|last| last.elapsed() >= Duration::from_millis(250))
            || received == total;
        observe(CopyEvent::AfterWrite { received, report }).map_err(CopyError::Observer)?;
        if report {
            progress = Some(Instant::now());
        }
    }
    if received != total {
        return Err(CopyError::Transfer(Error::Incomplete));
    }
    Ok(received)
}
