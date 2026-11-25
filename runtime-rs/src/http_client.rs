use std::time::Duration;

/// Tune a `reqwest::ClientBuilder` for external/proxied HTTP(S) traffic:
/// lowers first-byte latency (`TCP_NODELAY`, adaptive HTTP/2 flow-control window)
/// and prevents silent NAT/proxy drops via TCP & HTTP/2 keepalive probes.
pub(crate) fn tune_proxy(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    builder
        .tcp_nodelay(true)
        .tcp_keepalive(Duration::from_secs(15))
        .http2_keep_alive_interval(Duration::from_secs(15))
        .http2_keep_alive_timeout(Duration::from_secs(10))
        .http2_keep_alive_while_idle(true)
        .http2_adaptive_window(true)
        .pool_idle_timeout(Duration::from_secs(60))
}

/// Tune a `reqwest::ClientBuilder` for loopback or HTTP/1.1 multi-lane traffic
/// where HTTP/2 keepalive is not used.
pub(crate) fn tune_http1(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    builder
        .tcp_nodelay(true)
        .tcp_keepalive(Duration::from_secs(15))
        .pool_idle_timeout(Duration::from_secs(60))
}
