use super::{Proxy, READ_PATHS, client::local_url};
use crate::AppState;
use axum::{
    Extension, Json,
    body::{Body, HttpBody},
    extract::{Request, State},
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::StreamExt;
use serde_json::json;
use std::sync::Arc;

fn fail(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({"ok":false,"error":message,"msg":message,"code":code})),
    )
        .into_response()
}

pub(super) async fn unavailable(request: Request) -> Response {
    fail(
        StatusCode::NOT_FOUND,
        "NOT_FOUND",
        &format!("该接口未开放：{}", request.uri().path()),
    )
}

fn clean_headers(headers: &HeaderMap) -> HeaderMap {
    let mut clean = headers.clone();
    let named: Vec<String> = headers
        .get_all("connection")
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(',').map(|name| name.trim().to_owned()))
        .collect();
    for name in named {
        clean.remove(name);
    }
    for name in [
        "connection",
        "keep-alive",
        "proxy-authenticate",
        "proxy-authorization",
        "te",
        "trailer",
        "transfer-encoding",
        "upgrade",
        "host",
    ] {
        clean.remove(name);
    }
    clean
}

pub(super) async fn forward(
    State(state): State<AppState>,
    Extension(proxy): Extension<Arc<Proxy>>,
    request: Request,
) -> Response {
    let path = request.uri().path();
    if ![Method::GET, Method::HEAD].contains(request.method()) || !READ_PATHS.contains(&path) {
        return fail(
            StatusCode::METHOD_NOT_ALLOWED,
            "METHOD_NOT_ALLOWED",
            "该原生 SD 接口不支持此请求方法",
        );
    }
    let mut target = match local_url(&proxy.sd_host) {
        Ok(target) => target,
        Err(error) => return error.into_response(),
    };
    target.set_path(path);
    target.set_query(request.uri().query());
    let (parts, body) = request.into_parts();
    let mut headers = clean_headers(&parts.headers);
    if let Some(auth) = &proxy.sd_auth {
        let Ok(value) = format!("Basic {}", STANDARD.encode(auth)).parse() else {
            return gateway_error();
        };
        headers.insert("authorization", value);
    }
    let send = proxy
        .transport
        .client
        .request(parts.method, target)
        .headers(headers);
    let send = if body.size_hint().exact() == Some(0) {
        send
    } else {
        send.body(reqwest::Body::wrap_stream(body.into_data_stream()))
    };
    let send = send.send();
    let result = tokio::select! { value = send => value, _ = state.shutdown.cancelled() => return gateway_error() };
    let upstream = match result {
        Ok(value) => value,
        Err(_) => return gateway_error(),
    };
    let status = upstream.status();
    let headers = clean_headers(upstream.headers());
    // Body owns the upstream stream: slow readers apply backpressure and dropping
    // the downstream response cancels further upstream reads without a relay task.
    let stream = upstream
        .bytes_stream()
        .take_until(state.shutdown.cancelled_owned());
    let mut response = Response::new(Body::from_stream(stream));
    *response.status_mut() = status;
    *response.headers_mut() = headers;
    response
}

fn gateway_error() -> Response {
    fail(
        StatusCode::BAD_GATEWAY,
        "UPSTREAM_UNAVAILABLE",
        "SD WebUI 未响应，请确认已经启动",
    )
}
