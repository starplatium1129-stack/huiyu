use axum::{
    http::{HeaderMap, HeaderValue, Method, StatusCode, Uri},
    response::{IntoResponse, Response},
};
use hmac::{Hmac, Mac};
use sha2::Sha256;

fn matches(expected: &str, supplied: &str) -> bool {
    if expected.is_empty() || expected.len() != supplied.len() {
        return false;
    }
    // Reuse HMAC's constant-time verifier; no ordinary secret string comparison.
    let mut wanted =
        Hmac::<Sha256>::new_from_slice(expected.as_bytes()).expect("HMAC accepts any key length");
    let mut actual =
        Hmac::<Sha256>::new_from_slice(supplied.as_bytes()).expect("HMAC accepts any key length");
    wanted.update(b"aics-runtime-token-comparison:v1");
    actual.update(b"aics-runtime-token-comparison:v1");
    wanted.verify_slice(&actual.finalize().into_bytes()).is_ok()
}
pub(super) fn authorize(
    expected: &str,
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
) -> Option<Response> {
    let parameters: Vec<_> = url::form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
        .into_owned()
        .collect();
    let tokens: Vec<_> = parameters
        .iter()
        .filter(|(key, _)| key == "token")
        .map(|(_, value)| value.as_str())
        .collect();
    let query = tokens.first().copied().filter(|token| !token.is_empty());
    let header = headers
        .get("x-token")
        .and_then(|header| header.to_str().ok())
        .filter(|token| !token.is_empty());
    let cookie = headers
        .get("cookie")
        .and_then(|header| header.to_str().ok())
        .and_then(|cookie| {
            cookie
                .split(';')
                .find_map(|part| part.trim().strip_prefix("aics_token="))
        });
    let supplied = query.or(header).or(cookie).unwrap_or("");
    if tokens.len() <= 1 && matches(expected, supplied) {
        query?;
        // Emit only the parsed path/query; a network-path URL must never become
        // an open redirect with the newly issued authentication cookie.
        let Ok(mut clean) = url::Url::parse("http://localhost/")
            .unwrap()
            .join(&uri.to_string())
        else {
            return Some(denied(method, uri));
        };
        clean
            .query_pairs_mut()
            .clear()
            .extend_pairs(parameters.iter().filter(|(key, _)| key != "token"));
        let location = format!(
            "{}{}",
            clean.path(),
            clean
                .query()
                .filter(|value| !value.is_empty())
                .map(|query| format!("?{query}"))
                .unwrap_or_default()
        );
        let secure = headers
            .get("x-forwarded-proto")
            .is_some_and(|value| value == "https")
            || uri.scheme_str() == Some("https");
        let cookie = format!(
            "aics_token={expected}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400{}",
            if secure { "; Secure" } else { "" }
        );
        let mut response = StatusCode::FOUND.into_response();
        let Ok(cookie) = HeaderValue::from_str(&cookie) else {
            return Some(denied(method, uri));
        };
        let Ok(location) = HeaderValue::from_str(&location) else {
            return Some(denied(method, uri));
        };
        response.headers_mut().insert("set-cookie", cookie);
        response.headers_mut().insert("location", location);
        response
            .headers_mut()
            .insert("cache-control", HeaderValue::from_static("no-store"));
        return Some(response);
    }
    Some(denied(method, uri))
}
fn denied(method: &Method, uri: &Uri) -> Response {
    let api = ["/api/", "/sdapi", "/controlnet", "/adetailer", "/comfy"]
        .iter()
        .any(|prefix| uri.path().starts_with(prefix));
    if api {
        crate::error::ApiError::new(401, "UNAUTHORIZED", "Unauthorized — 缺少 token 参数")
            .into_response()
    } else {
        let text = "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><title>绘遇 · HUIYU</title><body><h1>绘遇 · HUIYU</h1><p>请使用朋友分享的含 token 链接访问。</p></body></html>";
        (
            StatusCode::FORBIDDEN,
            [
                ("content-type", "text/html; charset=utf-8"),
                ("cache-control", "no-store"),
            ],
            if method == Method::HEAD { "" } else { text },
        )
            .into_response()
    }
}
