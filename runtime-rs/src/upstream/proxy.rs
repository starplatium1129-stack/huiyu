use super::{
    LOCAL_READ_PATHS, Proxy, READ_PATHS, WRITE_PATHS,
    client::{CONNECT_TIMEOUT, local_url},
};
use crate::{AppState, security};
use axum::{
    Extension, Json,
    body::{Body, HttpBody},
    extract::{
        ConnectInfo, Request, State,
        ws::{WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, Method, StatusCode},
    response::{IntoResponse, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use std::{net::SocketAddr, sync::Arc};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{self, client::IntoClientRequest},
};
use tokio_util::sync::CancellationToken;

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
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    ws: std::result::Result<
        WebSocketUpgrade,
        axum::extract::ws::rejection::WebSocketUpgradeRejection,
    >,
    request: Request,
) -> Response {
    let path = request.uri().path();
    let local_read = LOCAL_READ_PATHS.contains(&path);
    let read = [Method::GET, Method::HEAD].contains(request.method())
        && (READ_PATHS.contains(&path) || local_read);
    let write = request.method() == Method::POST && WRITE_PATHS.contains(&path);
    let upgrading = request
        .headers()
        .get("upgrade")
        .is_some_and(|value| value.as_bytes().eq_ignore_ascii_case(b"websocket"));
    if (!read && !write) || (upgrading && request.method() != Method::GET) {
        return fail(
            StatusCode::METHOD_NOT_ALLOWED,
            "METHOD_NOT_ALLOWED",
            "该原生 SD 接口不支持此请求方法",
        );
    }
    if (write || upgrading || local_read)
        && !security::is_direct_local(request.headers(), peer.ip())
    {
        return fail(
            StatusCode::FORBIDDEN,
            "SD_NATIVE_LOCAL_ONLY",
            "原生 SD 全局进度和写操作仅限本机；请使用应用任务接口",
        );
    }
    let mut target = match local_url(&proxy.sd_host) {
        Ok(target) => target,
        Err(error) => return error.into_response(),
    };
    target.set_path(path);
    target.set_query(request.uri().query());
    if upgrading {
        let Ok(ws) = ws else {
            return fail(
                StatusCode::BAD_REQUEST,
                "WEBSOCKET_REQUEST",
                "WebSocket 握手无效",
            );
        };
        return websocket(proxy, target, request.headers(), ws, state.shutdown).await;
    }
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

async fn websocket(
    proxy: Arc<Proxy>,
    mut target: url::Url,
    headers: &HeaderMap,
    ws: WebSocketUpgrade,
    cancel: CancellationToken,
) -> Response {
    if target.set_scheme("ws").is_err() {
        return gateway_error();
    }
    let mut request = match target.as_str().into_client_request() {
        Ok(value) => value,
        Err(_) => return gateway_error(),
    };
    for (key, value) in clean_headers(headers) {
        if let Some(key) = key
            && ![
                "sec-websocket-key",
                "sec-websocket-version",
                "sec-websocket-extensions",
            ]
            .contains(&key.as_str())
        {
            request.headers_mut().insert(key, value);
        }
    }
    if let Some(auth) = &proxy.sd_auth {
        let Ok(value) = format!("Basic {}", STANDARD.encode(auth)).parse() else {
            return gateway_error();
        };
        request.headers_mut().insert("authorization", value);
    }
    let result = tokio::select! {
        result = tokio::time::timeout(CONNECT_TIMEOUT, connect_async(request)) => result,
        _ = cancel.cancelled() => return gateway_error(),
    };
    let Ok(Ok((upstream, response))) = result else {
        return gateway_error();
    };
    let ws = if let Some(protocol) = response
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
    {
        ws.protocols([protocol.to_owned()])
    } else {
        ws
    };
    ws.on_upgrade(move |downstream| relay(downstream, upstream, cancel))
}

async fn relay(
    downstream: WebSocket,
    upstream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    cancel: CancellationToken,
) {
    let (mut to_browser, mut from_browser) = downstream.split();
    let (mut to_sd, mut from_sd) = upstream.split();
    let outbound = async {
        while let Some(Ok(message)) = from_browser.next().await {
            use axum::extract::ws::Message as A;
            use tungstenite::Message as T;
            let message = match message {
                A::Text(value) => T::Text(value.to_string().into()),
                A::Binary(value) => T::Binary(value),
                A::Ping(value) => T::Ping(value),
                A::Pong(value) => T::Pong(value),
                A::Close(value) => T::Close(value.map(|value| tungstenite::protocol::CloseFrame {
                    code: value.code.into(),
                    reason: value.reason.to_string().into(),
                })),
            };
            if to_sd.send(message).await.is_err() {
                break;
            }
        }
    };
    let inbound = async {
        while let Some(Ok(message)) = from_sd.next().await {
            use axum::extract::ws::{CloseFrame, Message as A};
            use tungstenite::Message as T;
            let message = match message {
                T::Text(value) => A::Text(value.to_string().into()),
                T::Binary(value) => A::Binary(value),
                T::Ping(value) => A::Ping(value),
                T::Pong(value) => A::Pong(value),
                T::Close(value) => A::Close(value.map(|value| CloseFrame {
                    code: value.code.into(),
                    reason: value.reason.to_string().into(),
                })),
                T::Frame(_) => continue,
            };
            if to_browser.send(message).await.is_err() {
                break;
            }
        }
    };
    tokio::select! { _ = outbound => {}, _ = inbound => {}, _ = cancel.cancelled() => {} }
}
