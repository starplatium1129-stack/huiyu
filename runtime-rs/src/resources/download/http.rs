use super::*;
use futures_util::StreamExt;
use reqwest::{
    Response,
    header::{CONTENT_LENGTH, HeaderMap},
};
pub(super) async fn response(
    client: &reqwest::Client,
    url: url::Url,
    headers: HeaderMap,
    cancel: &CancellationToken,
) -> Result<Response> {
    cancelled(cancel)?;
    let request = client
        .get(url)
        .headers(headers)
        .header("accept-encoding", "identity")
        .send();
    let response = tokio::select! {_ = cancel.cancelled()=>return Err(Error::new("CANCELLED","Download cancelled")),result=tokio::time::timeout(std::time::Duration::from_secs(30),request)=>result.map_err(|_|Error::new("HTTP_TIMEOUT","Resource source timed out"))?.map_err(|_|Error::new("HTTP_FAILED","Resource source unavailable"))?};
    if response.status().is_redirection() {
        return Err(Error::new(
            "REDIRECT_REJECTED",
            "Resource redirects rejected",
        ));
    }
    if response
        .headers()
        .get("content-encoding")
        .is_some_and(|encoding| encoding != "identity")
    {
        return Err(Error::new(
            "HTTP_ENCODING",
            "Encoded response cannot verify byte ranges",
        ));
    }
    Ok(response)
}
pub(super) fn length(response: &Response) -> Result<Option<u64>> {
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
                .ok_or_else(|| Error::new("HTTP_SIZE", "Invalid Content-Length"))
        })
        .transpose()
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
    let length = length(response)?;
    if response.status() == reqwest::StatusCode::OK {
        if length.is_some_and(|length| length != total) {
            return Err(Error::new("HTTP_SIZE", "Full length differs from manifest"));
        }
        return Ok(0);
    }
    if response.status() != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(Error::new("HTTP_STATUS", "Resource request failed"));
    }
    let header = response
        .headers()
        .get("content-range")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let expected = format!("bytes {offset}-{}/{}", total.saturating_sub(1), total);
    if total == 0
        || header != expected
        || length.is_some_and(|length| length != total.saturating_sub(offset))
        || etag.is_some_and(|etag| {
            response
                .headers()
                .get("etag")
                .and_then(|value| value.to_str().ok())
                != Some(etag)
        })
    {
        return Err(Error::new("HTTP_RANGE", "Response range or ETag differs"));
    }
    Ok(offset)
}
