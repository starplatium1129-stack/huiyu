mod errors;
mod network;

pub(super) use errors::upstream_error;
#[allow(unused_imports)]
pub(super) use network::public_ip;

use super::{Duration, Error, Result};
use crate::byte_buffer::Buffer;
use crate::http_body::{self, ReadError};
use axum::body::Bytes;
use errors::{network_error, timeout, unavailable};
use network::{proxy, public_address};
use url::Url;

#[derive(Clone)]
pub(super) struct Transport {
    trusted: reqwest::Client,
}

pub(super) struct Request<'a> {
    pub body: Option<Bytes>,
    pub key: &'a str,
    pub session_id: Option<&'a str>,
    pub public_only: bool,
    pub idle: Duration,
    pub total: Duration,
    pub accept: &'a str,
}

fn builder() -> reqwest::ClientBuilder {
    crate::http_client::tune_proxy(reqwest::Client::builder())
        .user_agent(concat!("Huiyu/", env!("CARGO_PKG_VERSION")))
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .connect_timeout(Duration::from_secs(15))
        .pool_max_idle_per_host(16)
}

impl Transport {
    pub fn new() -> Self {
        // Respect Windows system proxy + standard env vars first; fall back to
        // custom HTTP-only env proxy if an unsupported scheme (e.g. socks5) is set.
        let trusted = builder()
            .build()
            .or_else(|_| {
                builder()
                    .no_proxy()
                    .proxy(reqwest::Proxy::custom(proxy))
                    .build()
            })
            .expect("Initialize chat HTTP client");
        Self { trusted }
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
                .no_proxy()
                .pool_max_idle_per_host(0)
                .resolve(target.host_str().unwrap(), address)
                .build()
                .map_err(|_| unavailable())?;
            &public
        } else {
            &self.trusted
        };
        let opencode = super::validation::vendor(&target) == "opencode";
        let mut request = if let Some(body) = options.body {
            client
                .post(target)
                .header("content-type", "application/json")
                .body(body)
        } else {
            client.get(target)
        };
        if !options.key.is_empty() {
            request = request.bearer_auth(options.key);
        }
        if opencode && let Some(session_id) = options.session_id {
            request = request.header("x-opencode-session", session_id);
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

    pub async fn send_form(
        &self,
        target: Url,
        form: &[(&str, &str)],
        idle: Duration,
    ) -> Result<reqwest::Response> {
        if target.scheme() != "https" || !target.username().is_empty() || target.password().is_some()
        {
            return Err(Error::invalid("Invalid OAuth URL"));
        }
        let body: String = url::form_urlencoded::Serializer::new(String::new())
            .extend_pairs(form.iter().copied())
            .finish();
        tokio::time::timeout(
            idle,
            self.trusted
                .post(target)
                .header("accept", "application/json")
                .header("content-type", "application/x-www-form-urlencoded")
                .body(body)
                .timeout(idle)
                .send(),
        )
        .await
        .map_err(|_| timeout())?
        .map_err(network_error)
    }
}

pub(super) async fn bounded(response: reqwest::Response, limit: usize) -> Result<Buffer> {
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(Error::stream(
            "RESPONSE_TOO_LARGE",
            "Upstream response exceeded the size limit",
        ));
    }
    http_body::collect(response, limit)
        .await
        .map_err(|error| match error {
            ReadError::Network(error) => network_error(error),
            ReadError::TooLarge => Error::stream(
                "RESPONSE_TOO_LARGE",
                "Upstream response exceeded the size limit",
            ),
        })
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
    let vendor = super::validation::vendor(response.url());
    // Providers may echo authorization headers, keys, or credential-bearing URLs.
    // Only recognize known error types; never publish/log upstream error bodies.
    let bytes = bounded(response, limit).await?;
    let body = serde_json::from_slice::<serde_json::Value>(bytes.as_ref()).unwrap_or_default();
    Err(upstream_error(
        status,
        &vendor,
        body.get("error").unwrap_or(&body),
        message,
    ))
}
