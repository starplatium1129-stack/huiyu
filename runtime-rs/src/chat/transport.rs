use super::{Duration, Error, Result};
use futures_util::StreamExt;
use serde_json::Value;
use std::{
    env,
    net::{IpAddr, Ipv6Addr, SocketAddr},
};
use url::Url;

pub(super) struct Transport {
    trusted: reqwest::Client,
}
pub(super) struct Request<'a> {
    pub body: Option<&'a Value>,
    pub key: &'a str,
    pub public_only: bool,
    pub idle: Duration,
    pub total: Duration,
    pub accept: &'a str,
}
fn builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(15))
        .pool_idle_timeout(Duration::from_secs(60))
        .pool_max_idle_per_host(32)
        .tcp_keepalive(Duration::from_secs(15))
}
impl Transport {
    pub fn new() -> Self {
        Self {
            trusted: builder()
                .proxy(reqwest::Proxy::custom(proxy))
                .build()
                .expect("Initialize chat HTTP client"),
        }
    }
    pub async fn send(&self, target: Url, options: Request<'_>) -> Result<reqwest::Response> {
        if !["http", "https"].contains(&target.scheme())
            || !target.username().is_empty()
            || target.password().is_some()
        {
            return Err(Error::invalid("Invalid upstream URL"));
        }
        let public;
        let client = if options.public_only {
            let address = tokio::time::timeout(options.idle, public_address(&target))
                .await
                .map_err(|_| timeout())??;
            public = builder()
                .pool_max_idle_per_host(0)
                .resolve(target.host_str().unwrap(), address)
                .build()
                .map_err(|_| unavailable())?;
            &public
        } else {
            &self.trusted
        };
        let mut request = if let Some(body) = options.body {
            client.post(target).json(body)
        } else {
            client.get(target)
        };
        if !options.key.is_empty() {
            request = request.bearer_auth(options.key);
        }
        tokio::time::timeout(
            options.idle,
            request
                .header("accept", options.accept)
                .timeout(options.total)
                .send(),
        )
        .await
        .map_err(|_| timeout())?
        .map_err(network_error)
    }
}

pub(super) async fn bounded(response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(Error::stream(
            "RESPONSE_TOO_LARGE",
            "Upstream response exceeded the size limit",
        ));
    }
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(network_error)?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(Error::stream(
                "RESPONSE_TOO_LARGE",
                "Upstream response exceeded the size limit",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
pub(super) async fn success(
    response: reqwest::Response,
    limit: usize,
    message: &str,
) -> Result<reqwest::Response> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status().as_u16();
    let body = bounded(response, limit).await?;
    let mut error = Error::new(
        if (400..500).contains(&status) {
            status
        } else {
            503
        },
        "UPSTREAM_STATUS",
        format!("{message} {status}"),
    );
    error.detail = String::from_utf8_lossy(&body).chars().take(500).collect();
    Err(error)
}
fn network_error(error: reqwest::Error) -> Error {
    if error.is_timeout() {
        timeout()
    } else {
        unavailable()
    }
}
fn unavailable() -> Error {
    Error::stream("UPSTREAM_UNAVAILABLE", "聊天上游暂不可用")
}
fn timeout() -> Error {
    Error::stream("UPSTREAM_TIMEOUT", "聊天上游请求超时")
}
fn forbidden() -> Error {
    Error::new(
        403,
        "PRIVATE_UPSTREAM_FORBIDDEN",
        "远程自配 API 只能访问公网 HTTPS 地址；本机服务需由站主托管",
    )
}

pub(super) fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(ip) => {
            let value = u32::from(ip);
            ![
                (0x00000000, 8),
                (0x0a000000, 8),
                (0x64400000, 10),
                (0x7f000000, 8),
                (0xa9fe0000, 16),
                (0xac100000, 12),
                (0xc0000000, 24),
                (0xc0000200, 24),
                (0xc0a80000, 16),
                (0xc6120000, 15),
                (0xc6336400, 24),
                (0xcb007100, 24),
                (0xe0000000, 4),
                (0xf0000000, 4),
            ]
            .iter()
            .any(|(base, prefix)| value >> (32 - prefix) == base >> (32 - prefix))
        }
        IpAddr::V6(ip) => {
            let value = u128::from(ip);
            let global = u128::from(Ipv6Addr::new(0x2000, 0, 0, 0, 0, 0, 0, 0));
            value >> 125 == global >> 125
                && ![
                    (0x2001, 0, 23),
                    (0x2001, 0xdb8, 32),
                    (0x2002, 0, 16),
                    (0x3fff, 0, 20),
                ]
                .iter()
                .any(|(a, b, prefix)| {
                    let base = u128::from(Ipv6Addr::new(*a, *b, 0, 0, 0, 0, 0, 0));
                    value >> (128 - prefix) == base >> (128 - prefix)
                })
        }
    }
}
async fn public_address(target: &Url) -> Result<SocketAddr> {
    if target.scheme() != "https" {
        return Err(forbidden());
    }
    let host = target
        .host_str()
        .ok_or_else(forbidden)?
        .trim_matches(['[', ']']);
    let port = target.port_or_known_default().ok_or_else(forbidden)?;
    let addresses = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        tokio::net::lookup_host((host, port))
            .await
            .map_err(|_| unavailable())?
            .collect::<Vec<_>>()
    };
    if addresses.is_empty() || addresses.iter().any(|address| !public_ip(address.ip())) {
        return Err(forbidden());
    }
    Ok(addresses[0])
}

fn no_proxy(host: &str, value: &str) -> bool {
    if ["localhost", "127.0.0.1", "::1", "[::1]"].contains(&host) {
        return true;
    }
    value
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .any(|entry| {
            if entry == "*" {
                return true;
            }
            let mut item = entry.to_lowercase();
            if item.contains("://") {
                item = Url::parse(&item)
                    .ok()
                    .and_then(|v| v.host_str().map(str::to_owned))
                    .unwrap_or_default();
            }
            item = item
                .trim_start_matches("*.")
                .trim_start_matches('.')
                .to_owned();
            if !item.contains(']')
                && let Some((without, _)) = item.rsplit_once(':')
            {
                item = without.to_owned();
            }
            !item.is_empty()
                && (host.eq_ignore_ascii_case(&item)
                    || host.to_lowercase().ends_with(&format!(".{item}")))
        })
}
fn proxy(target: &Url) -> Option<Url> {
    let bypass = env::var("NO_PROXY")
        .ok()
        .filter(|value| !value.is_empty())
        .or_else(|| env::var("no_proxy").ok())
        .unwrap_or_default();
    if no_proxy(target.host_str().unwrap_or(""), &bypass) {
        return None;
    }
    let keys = if target.scheme() == "https" {
        ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"]
    } else {
        ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]
    };
    let raw = keys
        .iter()
        .find_map(|key| env::var(key).ok().filter(|v| !v.is_empty()))?;
    let raw = raw.trim();
    let mut url = Url::parse(&if raw.contains("://") {
        raw.into()
    } else {
        format!("http://{raw}")
    })
    .ok()?;
    if url.scheme() != "http" || url.host_str().is_none() {
        return None;
    }
    if url.port().is_none() {
        url.set_port(Some(8080)).ok()?;
    }
    Some(url)
}

#[cfg(test)]
#[path = "transport_tests.rs"]
mod tests;
