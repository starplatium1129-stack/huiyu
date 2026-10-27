use super::*;
use crate::http_body::{self, ReadError};
use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::Method;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
impl Inner {
    pub(super) fn request(
        &self,
        provider: &str,
        method: Method,
        path: &str,
        body: Option<&Value>,
        timeout: Duration,
    ) -> Result<reqwest::RequestBuilder> {
        let base = crate::upstream::local_url(if provider == "webui" {
            &self.config.sd_host
        } else {
            &self.config.comfy_host
        })?;
        let url = base
            .join(path)
            .map_err(|_| ApiError::new(502, "UPSTREAM_CONFIG_INVALID", "上游地址无效"))?;
        if !path.starts_with('/') || path.starts_with("//") || url.origin() != base.origin() {
            return Err(ApiError::new(
                502,
                "UPSTREAM_CONFIG_INVALID",
                "上游地址无效",
            ));
        }
        let mut request = self
            .transport
            .client
            .request(method, url)
            .header("Accept", "application/json")
            .timeout(timeout);
        if provider == "webui"
            && let Some(auth) = &self.config.sd_auth
        {
            request = request.header("Authorization", format!("Basic {}", STANDARD.encode(auth)));
        }
        if let Some(body) = body {
            request = request.json(body);
        }
        Ok(request)
    }
    async fn read_json(
        &self,
        provider: &str,
        request: reqwest::RequestBuilder,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<(u16, Value)> {
        let max_bytes = if provider == "webui" {
            constants::MAX_JSON
        } else {
            2 * 1024 * 1024
        };
        let work = async {
            let response = request
                .send()
                .await
                .map_err(|error| network_error(provider, error))?;
            let status = response.status().as_u16();
            if response
                .content_length()
                .is_some_and(|n| n > max_bytes as u64)
            {
                return Err(too_large(provider));
            }
            let bytes =
                http_body::collect(response, max_bytes)
                    .await
                    .map_err(|error| match error {
                        ReadError::Network(error) => network_error(provider, error),
                        ReadError::TooLarge => too_large(provider),
                    })?;
            Ok((status, bytes))
        };
        let (status, bytes) = tokio::select! {result=tokio::time::timeout(timeout,work)=>result.map_err(|_|ApiError::new(504,if provider=="webui"{"UPSTREAM_TIMEOUT"}else{"COMFY_TIMEOUT"},"上游请求超时"))?,_ = cancel.cancelled()=>Err(ApiError::new(499,"ABORT_ERR","上游请求已取消"))}?;
        let value = self
            .decoder
            .json(provider, status, bytes, cancel, &self.cancel)
            .await?;
        Ok((status, value))
    }
    pub(super) async fn raw_json(
        &self,
        provider: &str,
        method: Method,
        path: &str,
        body: Option<&Value>,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<(u16, Value)> {
        let request = self.request(provider, method, path, body, timeout)?;
        self.read_json(provider, request, timeout, cancel).await
    }
    pub(super) async fn json(
        &self,
        provider: &str,
        method: Method,
        path: &str,
        body: Option<&Value>,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let (status, value) = self
            .raw_json(provider, method, path, body, timeout, cancel)
            .await?;
        json_success(provider, status, value)
    }
    pub(super) async fn json_payload<T: serde::Serialize + ?Sized>(
        &self,
        provider: &str,
        method: Method,
        path: &str,
        body: &T,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<Value> {
        let request = self
            .request(provider, method, path, None, timeout)?
            .json(body);
        let (status, value) = self.read_json(provider, request, timeout, cancel).await?;
        json_success(provider, status, value)
    }
}
fn json_success(provider: &str, status: u16, value: Value) -> Result<Value> {
    if !(200..300).contains(&status) {
        return Err(ApiError::new(
            502,
            if provider == "webui" {
                "UPSTREAM_ERROR"
            } else {
                "COMFY_UPSTREAM_ERROR"
            },
            crate::upstream::diagnostic_message(&value, "上游请求失败"),
        ));
    }
    Ok(value)
}
pub(super) fn too_large(provider: &str) -> ApiError {
    ApiError::new(
        502,
        if provider == "webui" {
            "UPSTREAM_RESPONSE_TOO_LARGE"
        } else {
            "COMFY_RESPONSE_TOO_LARGE"
        },
        "上游响应过大",
    )
}
pub(super) fn network_error(provider: &str, error: reqwest::Error) -> ApiError {
    ApiError::new(
        if error.is_timeout() { 504 } else { 502 },
        if error.is_timeout() {
            if provider == "webui" {
                "UPSTREAM_TIMEOUT"
            } else {
                "COMFY_TIMEOUT"
            }
        } else {
            if provider == "webui" {
                "UPSTREAM_UNAVAILABLE"
            } else {
                "COMFY_UNAVAILABLE"
            }
        },
        "上游连接不可用或响应中断",
    )
}
