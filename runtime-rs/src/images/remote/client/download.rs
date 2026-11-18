use super::*;
use crate::download_transport::{self, CopyError, Error};
use reqwest::{Response, StatusCode, header};

const MAX_RESULT: usize = 32 * 1024 * 1024;
const READ_TIMEOUT: Duration = Duration::from_secs(60);

impl Client {
    pub(super) async fn download_result(
        &self,
        job: &Value,
        family: &str,
        cancel: &CancellationToken,
    ) -> Result<Output> {
        if job["status"] != "succeeded" {
            return Err(ApiError::new(409, "RESULT_NOT_READY", "远程结果尚未就绪"));
        }
        let id = job["id"]
            .as_str()
            .filter(|id| id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(protocol)?;
        let digest = job
            .get("resultSha256")
            .filter(|v| !v.is_null())
            .map(|value| {
                let mut digest = [0u8; 32];
                hex::decode_to_slice(value.as_str().ok_or_else(protocol)?, &mut digest)
                    .map_err(|_| protocol())?;
                Ok::<_, ApiError>(digest)
            })
            .transpose()?;
        let size = job
            .get("resultBytes")
            .filter(|v| !v.is_null())
            .map(|value| value.as_u64().ok_or_else(protocol))
            .transpose()?;
        let path = format!("/api/{}/jobs/{id}/result", route(family)?);
        let get = || {
            self.request(Method::GET, &path)
                .header(header::ACCEPT_ENCODING, "identity")
                .timeout(READ_TIMEOUT)
        };
        let response = self.send(get(), cancel).await?;
        if response.status() != StatusCode::OK {
            return Err(protocol());
        }
        let size = size.or(download_transport::length(&response).map_err(|_| protocol())?);
        let bytes = if let Some(size) = size {
            if size == 0 || size > MAX_RESULT as u64 {
                return Err(protocol());
            }
            let etag = response
                .headers()
                .get(header::ETAG)
                .and_then(|v| v.to_str().ok())
                .filter(|v| v.len() >= 2 && v.starts_with('"') && v.ends_with('"'))
                .map(str::to_owned);
            let mut bytes = Vec::with_capacity(size as usize);
            let result = copy_result(response, &mut bytes, size, None, cancel).await;
            if let Err(error) = result {
                let offset = bytes.len() as u64;
                let Some(etag) = etag.filter(|_| {
                    offset > 0
                        && offset < size
                        && matches!(error, Error::Network | Error::Timeout | Error::Incomplete)
                }) else {
                    return Err(transfer_error(error));
                };
                let resume = get()
                    .header(header::RANGE, format!("bytes={offset}-"))
                    .header(header::IF_RANGE, &etag);
                let response = self.send(resume, cancel).await?;
                copy_result(response, &mut bytes, size, Some(&etag), cancel)
                    .await
                    .map_err(transfer_error)?;
            }
            bytes
        } else {
            read_body(response, MAX_RESULT, cancel).await?
        };
        let bytes = Arc::new(bytes);
        crate::image_decode::validate_png_bytes(bytes.clone(), digest, cancel).await?;
        Ok(Output::Bytes {
            bytes,
            mime: "image/png".into(),
        })
    }
}

async fn copy_result(
    response: Response,
    bytes: &mut Vec<u8>,
    size: u64,
    etag: Option<&str>,
    cancel: &CancellationToken,
) -> std::result::Result<(), Error> {
    // A peer may ignore Range or replace the representation. A complete 200
    // replaces the prefix. Only a matching 206 can append to it.
    let start = download_transport::range(&response, bytes.len() as u64, size, etag)?;
    bytes.truncate(start as usize);
    download_transport::copy(response, bytes, start, size, READ_TIMEOUT, cancel, |_| {
        Ok::<_, Error>(())
    })
    .await
    .map(|_| ())
    .map_err(|error| match error {
        CopyError::Transfer(e) | CopyError::Observer(e) => e,
    })
}

fn transfer_error(error: Error) -> ApiError {
    match error {
        Error::Cancelled => inputs::cancelled(),
        Error::Network | Error::Timeout | Error::Incomplete => unavailable(),
        _ => protocol(),
    }
}
