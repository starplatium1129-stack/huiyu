use super::*;
use crate::download_transport::{self as transfer, Error as TransferError};
use futures_util::StreamExt;
use reqwest::{Response, header::HeaderMap};
pub(super) fn error(error: TransferError) -> Error {
    match error {
        TransferError::Cancelled => Error::new("CANCELLED", "Download cancelled"),
        TransferError::Timeout => Error::new("HTTP_TIMEOUT", "Resource source timed out"),
        TransferError::Network => Error::new("HTTP_FAILED", "Resource source unavailable"),
        TransferError::Status(_) => Error::new("HTTP_STATUS", "Resource request failed"),
        TransferError::Redirect => Error::new("REDIRECT_REJECTED", "Resource redirects rejected"),
        TransferError::Encoding => Error::new(
            "HTTP_ENCODING",
            "Encoded response cannot verify byte ranges",
        ),
        TransferError::Range => Error::new("HTTP_RANGE", "Response range or ETag differs"),
        TransferError::Size | TransferError::Incomplete => {
            Error::new("HTTP_SIZE", "Resource response size differs from manifest")
        }
        TransferError::Io(error) => error.into(),
    }
}
pub(super) async fn response(
    client: &reqwest::Client,
    url: url::Url,
    headers: HeaderMap,
    cancel: &CancellationToken,
) -> Result<Response> {
    transfer::response(client, url, headers, Duration::from_secs(30), cancel, true)
        .await
        .map_err(error)
}
pub(super) fn length(response: &Response) -> Result<Option<u64>> {
    transfer::length(response).map_err(error)
}
pub(super) async fn metadata(
    client: &reqwest::Client,
    url: url::Url,
    cancel: &CancellationToken,
) -> Result<Vec<u8>> {
    let response = response(client, url, HeaderMap::new(), cancel).await?;
    if response.status() != reqwest::StatusCode::OK {
        return Err(Error::new("HTTP_STATUS", "Metadata request failed"));
    }
    let declared = length(&response)?;
    if declared.is_some_and(|size| size > fs::MAX_JSON) {
        return Err(Error::new("HTTP_SIZE", "Metadata too large"));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    loop {
        let next = tokio::select! {_ = cancel.cancelled()=>return Err(Error::new("CANCELLED","Download cancelled")),value=tokio::time::timeout(std::time::Duration::from_secs(30),stream.next())=>value.map_err(|_|Error::new("HTTP_TIMEOUT","Resource source timed out"))?};
        let Some(next) = next else {
            break;
        };
        let chunk = next.map_err(|_| Error::new("HTTP_FAILED", "Metadata response interrupted"))?;
        if bytes.len() as u64 + chunk.len() as u64 > fs::MAX_JSON {
            return Err(Error::new("HTTP_SIZE", "Metadata too large"));
        }
        bytes.extend_from_slice(&chunk);
    }
    if declared.is_some_and(|size| size != bytes.len() as u64) {
        return Err(Error::new("HTTP_SIZE", "Metadata response incomplete"));
    }
    Ok(bytes)
}
pub(super) fn range(
    response: &Response,
    offset: u64,
    total: u64,
    etag: Option<&str>,
) -> Result<u64> {
    transfer::range(response, offset, total, etag).map_err(error)
}
