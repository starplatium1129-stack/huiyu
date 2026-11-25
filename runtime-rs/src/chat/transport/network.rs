use super::{
    Result,
    errors::{forbidden, unavailable},
};
use std::{
    env,
    net::{IpAddr, Ipv6Addr, SocketAddr},
};
use url::Url;

pub(in crate::chat) fn public_ip(ip: IpAddr) -> bool {
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

pub(super) async fn public_address(target: &Url) -> Result<SocketAddr> {
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
    let mut lower_host = None;
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
            let item = item.trim_start_matches("*.").trim_start_matches('.');
            let item = if !item.contains(']') {
                item.rsplit_once(':').map_or(item, |(without, _)| without)
            } else {
                item
            };
            !item.is_empty()
                && (host.eq_ignore_ascii_case(item)
                    || lower_host
                        .get_or_insert_with(|| host.to_lowercase())
                        .strip_suffix(item)
                        .is_some_and(|prefix| prefix.ends_with('.')))
        })
}

pub(super) fn proxy(target: &Url) -> Option<Url> {
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
