use crate::error::{ApiError, Result};
use futures_util::StreamExt;
use serde_json::Value;
use std::{
    net::{IpAddr, Ipv4Addr},
    time::Duration,
};
use tokio_util::sync::CancellationToken;
use url::{Host, Url};

pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const GENERATION_TIMEOUT: Duration = Duration::from_secs(20 * 60);

/// This transport is restricted to configured loopback HTTP services. Public
/// custom providers need their separate DNS/HTTPS/authorization contract.
pub fn local_url(raw: &str) -> Result<Url> {
    let mut url = Url::parse(raw).map_err(|_| ApiError::invalid("Invalid local upstream URL"))?;
    let allowed = match url.host() {
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        Some(Host::Domain("localhost")) => true,
        _ => false,
    };
    if url.scheme() != "http"
        || !allowed
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err(ApiError::new(
            503,
            "LOCAL_UPSTREAM_REQUIRED",
            "上游服务必须为本机 HTTP 地址",
        ));
    }
    // Avoid DNS rebinding through an edited localhost resolver/hosts entry.
    if url.host_str() == Some("localhost") {
        url.set_ip_host(IpAddr::V4(Ipv4Addr::LOCALHOST))
            .map_err(|_| ApiError::invalid("Invalid local upstream URL"))?;
    }
    Ok(url)
}

#[derive(Clone)]
pub struct LocalUpstream {
    pub(crate) client: reqwest::Client,
}

impl Default for LocalUpstream {
    fn default() -> Self {
        Self::new()
    }
}

impl LocalUpstream {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(GENERATION_TIMEOUT)
            .pool_idle_timeout(Duration::from_secs(60))
            .pool_max_idle_per_host(32)
            .tcp_keepalive(Duration::from_secs(15))
            .build()
            .expect("Initialize local HTTP client");
        Self { client }
    }

    /// Bounded JSON transport for status/model catalogs; non-success HTTP statuses
    /// are returned to callers, preserving provider-specific reachability rules.
    /// The body is parsed JSON, or the original lossy text when parsing fails.
    pub async fn json(
        &self,
        base: &str,
        path: &str,
        body: Option<&Value>,
        timeout: Duration,
        max_bytes: usize,
        cancel: &CancellationToken,
    ) -> Result<(u16, std::result::Result<Value, String>)> {
        let base = local_url(base)?;
        if !path.starts_with('/') || path.starts_with("//") {
            return Err(ApiError::invalid("Invalid upstream path"));
        }
        let url = base
            .join(path)
            .map_err(|_| ApiError::invalid("Invalid upstream path"))?;
        if url.origin() != base.origin() {
            return Err(ApiError::invalid("Invalid upstream origin"));
        }
        let request = if let Some(body) = body {
            self.client.post(url).json(body)
        } else {
            self.client.get(url)
        };
        let future = async {
            let response = request
                .timeout(timeout)
                .send()
                .await
                .map_err(upstream_error)?;
            let status = response.status().as_u16();
            if response
                .content_length()
                .is_some_and(|size| size > max_bytes as u64)
            {
                return Err(too_large());
            }
            let mut stream = response.bytes_stream();
            let mut data = Vec::new();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(upstream_error)?;
                if data.len().saturating_add(chunk.len()) > max_bytes {
                    return Err(too_large());
                }
                data.extend_from_slice(&chunk);
            }
            Ok((status, decode_body(data)))
        };
        tokio::select! { result = future => result, _ = cancel.cancelled() => Err(ApiError::new(499, "ABORTED", "上游请求已取消")) }
    }
}

fn too_large() -> ApiError {
    ApiError::new(502, "UPSTREAM_TOO_LARGE", "上游响应超过大小限制")
}
fn upstream_error(error: reqwest::Error) -> ApiError {
    ApiError::new(
        502,
        if error.is_timeout() {
            "UPSTREAM_TIMEOUT"
        } else {
            "UPSTREAM_UNAVAILABLE"
        },
        "上游服务请求未完成",
    )
}

// Catalog JSON and plain-text tagger replies are mutually exclusive. Avoid
// retaining a duplicate UTF-8 body alongside parsed JSON; reuse the byte buffer
// for plain text. Invalid UTF-8 retains the provider fallback's lossy semantics.
fn decode_body(data: Vec<u8>) -> std::result::Result<Value, String> {
    serde_json::from_slice(&data).map_err(|_| {
        String::from_utf8(data)
            .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned())
    })
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;
