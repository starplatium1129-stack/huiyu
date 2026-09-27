use crate::{AppState, error::ApiError};
use axum::{
    extract::{ConnectInfo, Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use std::net::{IpAddr, SocketAddr};

pub fn host_allowed(host: &str) -> bool {
    if host == "::1" {
        return true;
    }
    url::Url::parse(&format!("http://{host}")).is_ok_and(|url| {
        url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
    })
}

pub fn is_direct_local(headers: &HeaderMap, peer: IpAddr) -> bool {
    let loopback = peer.is_loopback()
        || matches!(peer, IpAddr::V6(ip) if ip.to_ipv4_mapped().is_some_and(|v| v.is_loopback()));
    if !loopback
        || [
            "cf-connecting-ip",
            "x-forwarded-for",
            "forwarded",
            "x-forwarded-host",
            "x-forwarded-proto",
            "x-real-ip",
        ]
        .iter()
        .any(|key| headers.contains_key(*key))
    {
        return false;
    }
    match headers.get("origin") {
        Some(origin) => origin.to_str().is_ok_and(local_origin),
        None => headers
            .get("sec-fetch-site")
            .is_none_or(|site| site != "cross-site"),
    }
}

pub fn local_origin(origin: &str) -> bool {
    if matches!(
        origin,
        "tauri://localhost"
            | "http://tauri.localhost"
            | "https://tauri.localhost"
            | "https://huiyu.localhost"
    ) {
        return true;
    }
    url::Url::parse(origin).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https")
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/"
            && url.query().is_none()
            && url.fragment().is_none()
            && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
    })
}

pub async fn guard(
    State(state): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    request: Request,
    next: Next,
) -> Response {
    let path = request.uri().path().to_owned();
    let headers = request.headers();
    let cors = native_resource_origin(&state, headers, peer.ip(), request.method());
    let preflight = request.method() == Method::OPTIONS;
    let navigation =
        local_document_navigation(headers, peer.ip(), request.method(), request.uri().path());
    let mut response = if !headers
        .get("host")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|host| {
            state
                .remote
                .as_ref()
                .map_or_else(|| host_allowed(host), |remote| remote.host_allowed(host))
        }) {
        ApiError::new(421, "HOST_REJECTED", "Host is not allowed").into_response()
    } else if !is_direct_local(headers, peer.ip()) && !navigation && cors.is_none() {
        if let Some(remote) = &state.remote {
            match remote
                .guard(
                    &state.config.token,
                    request.method(),
                    request.uri(),
                    headers,
                    peer.ip(),
                )
                .await
            {
                Some(response) => response,
                None => next.run(request).await,
            }
        } else {
            ApiError::new(
                403,
                "LOCAL_ONLY",
                "This runtime only serves direct local requests",
            )
            .into_response()
        }
    } else if cors.is_some() && request.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        next.run(request).await
    };
    let headers = response.headers_mut();
    if let Some(origin) = cors {
        headers.insert("access-control-allow-origin", origin);
        headers.append("vary", HeaderValue::from_static("Origin"));
        headers.insert(
            "cross-origin-resource-policy",
            HeaderValue::from_static("cross-origin"),
        );
        if preflight {
            headers.insert(
                "access-control-allow-methods",
                HeaderValue::from_static("GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"),
            );
            headers.insert(
                "access-control-allow-headers",
                HeaderValue::from_static("Content-Type, Authorization, x-aics-workspace-session"),
            );
        }
    }
    headers.insert(
        "x-content-type-options",
        HeaderValue::from_static("nosniff"),
    );
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    let voice = matches!(path.as_str(), "/chat" | "/companion" | "/companion-chat");
    headers.insert(
        "permissions-policy",
        HeaderValue::from_static(if voice {
            "camera=(), microphone=(self), geolocation=()"
        } else {
            "camera=(), microphone=(), geolocation=()"
        }),
    );
    let script = if matches!(path.as_str(), "/chat" | "/companion") {
        "'self' 'unsafe-eval'"
    } else {
        "'self'"
    };
    let csp = format!(
        "default-src 'self'; img-src 'self' data: blob: https:; media-src 'self' data: blob:; script-src {script}; style-src 'self' 'unsafe-inline'; font-src 'self' data:; connect-src 'self' data: blob: https:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    );
    headers.insert(
        "content-security-policy",
        HeaderValue::from_str(&csp).expect("static CSP is a valid header"),
    );
    if !headers.contains_key("cache-control") {
        headers.insert("cache-control", HeaderValue::from_static("no-store"));
    }
    response
}

fn native_resource_origin(
    state: &AppState,
    headers: &HeaderMap,
    peer: IpAddr,
    method: &Method,
) -> Option<HeaderValue> {
    if state.config.desktop_secret.is_none()
        || !state.host.active().is_some_and(|p| p["bundledUi"] == true)
    {
        return None;
    }
    let origin = headers
        .get("origin")
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
        .or_else(|| {
            matches!(*method, Method::GET | Method::HEAD)
                .then(|| {
                    headers
                        .get("referer")
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| url::Url::parse(s).ok())
                        .map(|u| u.origin().ascii_serialization())
                })
                .flatten()
        })?;
    if ![
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "https://huiyu.localhost",
    ]
    .contains(&origin.as_str())
    {
        return None;
    }
    let origin = HeaderValue::from_str(&origin).ok()?;
    let mut projected = headers.clone();
    projected.insert("origin", origin.clone());
    (is_direct_local(&projected, peer)
        && headers
            .get("host")
            .and_then(|s| s.to_str().ok())
            .is_some_and(host_allowed))
    .then_some(origin)
}
fn local_document_navigation(
    headers: &HeaderMap,
    peer: IpAddr,
    method: &Method,
    path: &str,
) -> bool {
    if headers.contains_key("origin")
        || headers
            .get("sec-fetch-mode")
            .is_none_or(|v| v != "navigate")
        || !matches!(*method, Method::GET | Method::HEAD)
        || !crate::static_files::PAGES.contains(&path.trim_end_matches('/')) && path != "/"
    {
        return false;
    }
    let mut projected = headers.clone();
    projected.remove("sec-fetch-site");
    is_direct_local(&projected, peer)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_identity_does_not_trust_proxy_or_remote_origin() {
        let peer = "127.0.0.1".parse().unwrap();
        let mut headers = HeaderMap::new();
        assert!(is_direct_local(&headers, peer));
        headers.insert("x-forwarded-for", "127.0.0.1".parse().unwrap());
        assert!(!is_direct_local(&headers, peer));
        headers.clear();
        headers.insert("origin", "https://attacker.example".parse().unwrap());
        assert!(!is_direct_local(&headers, peer));
        assert!(!host_allowed("localhost.attacker.example:3210"));
        assert!(host_allowed("[::1]:3210"));
    }
}
