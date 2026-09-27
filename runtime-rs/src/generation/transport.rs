use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::StreamExt;
use reqwest::Method;
use std::time::Duration;
use tokio_util::sync::CancellationToken;
pub(super) struct Bounds {
    pub timeout: Duration,
    pub max_bytes: usize,
}

impl Inner {
    pub(super) async fn raw(
        &self,
        provider: &str,
        method: Method,
        path: &str,
        body: Option<&Value>,
        bounds: Bounds,
        cancel: &CancellationToken,
    ) -> Result<(u16, String, Vec<u8>)> {
        let Bounds { timeout, max_bytes } = bounds;
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
        let work = async {
            let response = request
                .send()
                .await
                .map_err(|error| network_error(provider, error))?;
            let status = response.status().as_u16();
            let mime = response
                .headers()
                .get("content-type")
                .and_then(|h| h.to_str().ok())
                .unwrap_or("")
                .to_string();
            if response
                .content_length()
                .is_some_and(|n| n > max_bytes as u64)
            {
                return Err(too_large(provider));
            }
            let mut bytes = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|error| network_error(provider, error))?;
                if bytes.len().saturating_add(chunk.len()) > max_bytes {
                    return Err(too_large(provider));
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok((status, mime, bytes))
        };
        tokio::select! {result=tokio::time::timeout(timeout,work)=>result.map_err(|_|ApiError::new(504,if provider=="webui"{"UPSTREAM_TIMEOUT"}else{"COMFY_TIMEOUT"},"上游请求超时"))?,_ = cancel.cancelled()=>Err(ApiError::new(499,"ABORT_ERR","上游请求已取消"))}
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
        let (status, _, bytes) = self
            .raw(
                provider,
                method,
                path,
                body,
                Bounds {
                    timeout,
                    max_bytes: if provider == "webui" {
                        constants::MAX_JSON
                    } else {
                        2 * 1024 * 1024
                    },
                },
                cancel,
            )
            .await?;
        let value = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).map_err(|_| {
                ApiError::new(
                    502,
                    if provider == "webui" {
                        "INVALID_UPSTREAM_RESPONSE"
                    } else {
                        "COMFY_INVALID_RESPONSE"
                    },
                    "上游返回无效 JSON",
                )
            })?
        };
        Ok((status, value))
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
        if !(200..300).contains(&status) {
            return Err(ApiError::new(
                502,
                if provider == "webui" {
                    "UPSTREAM_ERROR"
                } else {
                    "COMFY_UPSTREAM_ERROR"
                },
                "上游请求失败",
            ));
        }
        Ok(value)
    }
}
fn too_large(provider: &str) -> ApiError {
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
fn network_error(provider: &str, error: reqwest::Error) -> ApiError {
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
