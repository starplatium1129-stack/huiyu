use crate::{
    byte_buffer::Buffer,
    error::{ApiError, Result},
    http_body::{self, ReadError},
};
use serde_json::Value;
use std::{
    net::{IpAddr, Ipv4Addr},
    sync::{Arc, LazyLock},
    time::Duration,
};
use tokio::sync::Semaphore;
use tokio_util::sync::CancellationToken;
use url::{Host, Url};

pub(crate) const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
pub(crate) const GENERATION_TIMEOUT: Duration = Duration::from_secs(20 * 60);
static JSON_DECODERS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(2)));

/// Keep the provider's actionable explanation, never serialize its complete
/// response (which may include request parameters or diagnostics).
pub(crate) fn diagnostic_message(value: &Value, fallback: &str) -> String {
    let message = value.as_str().or_else(|| {
        ["detail", "message", "error", "errors"]
            .iter()
            .filter_map(|field| value.get(field))
            .find_map(|entry| entry.as_str().or_else(|| entry.get("message")?.as_str()))
    });
    let Some(message) = message.filter(|text| !text.trim().is_empty() && !text.contains('<'))
    else {
        return fallback.into();
    };
    let detail: String = message
        .chars()
        .filter(|c| !c.is_control())
        .take(512)
        .collect();
    format!("{fallback}：{}", detail.trim())
}

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
        self.probe_json(base, path, body, timeout, max_bytes, cancel)
            .await
            .map(|(status, body, _)| (status, body))
    }
    pub(crate) async fn probe_json(
        &self,
        base: &str,
        path: &str,
        body: Option<&Value>,
        timeout: Duration,
        max_bytes: usize,
        cancel: &CancellationToken,
    ) -> Result<(u16, std::result::Result<Value, String>, usize)> {
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
            let data =
                http_body::collect(response, max_bytes)
                    .await
                    .map_err(|error| match error {
                        ReadError::Network(error) => upstream_error(error),
                        ReadError::TooLarge => too_large(),
                    })?;
            let bytes = data.as_ref().len();
            Ok((status, decode_body(data, cancel).await?, bytes))
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(cancelled()),
            result = tokio::time::timeout(timeout, future) => result
                .map_err(|_| ApiError::new(502, "UPSTREAM_TIMEOUT", "上游服务请求未完成"))?,
        }
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
async fn decode_body(
    data: Buffer,
    cancel: &CancellationToken,
) -> Result<std::result::Result<Value, String>> {
    if data.as_ref().len() < 512 * 1024 {
        return Ok(parse_body(data));
    }
    let scope = cancel.child_token();
    let _guard = scope.clone().drop_guard();
    let permit = JSON_DECODERS
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| cancelled())?;
    // Pure CPU work owns both the bytes and permit after a timeout/disconnect.
    // No unbounded set of detached parsers can occupy blocking worker threads.
    tokio::task::spawn_blocking(move || {
        let _permit = permit;
        if scope.is_cancelled() {
            return Err(cancelled());
        }
        let result = parse_body(data);
        if scope.is_cancelled() {
            return Err(cancelled());
        }
        Ok(result)
    })
    .await
    .map_err(|_| ApiError::new(502, "UPSTREAM_DECODE_FAILED", "上游解码未完成"))?
}
fn cancelled() -> ApiError {
    ApiError::new(499, "ABORTED", "上游请求已取消")
}
fn parse_body(data: Buffer) -> std::result::Result<Value, String> {
    serde_json::from_slice(data.as_ref()).map_err(|_| {
        String::from_utf8(data.into_vec())
            .unwrap_or_else(|error| String::from_utf8_lossy(error.as_bytes()).into_owned())
    })
}
