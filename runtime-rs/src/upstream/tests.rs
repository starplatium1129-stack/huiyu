use super::*;
use crate::{config::Config, host::HostAuthority};
use axum::{
    body::Body,
    extract::{
        ConnectInfo, Request,
        ws::{Message, WebSocketUpgrade},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
};
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use std::{net::SocketAddr, time::Duration};
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

fn state() -> AppState {
    AppState::new(
        Arc::new(Config {
            app_root: std::env::temp_dir(),
            runtime_root: std::env::temp_dir().join("unused-runtime"),
            ai_workspace_root: std::env::temp_dir().join("unused-ai"),
            sd_host: "http://127.0.0.1:1".into(),
            sd_auth: None,
            comfy_host: "http://127.0.0.1:1".into(),
            bind: "127.0.0.1:3210".parse().unwrap(),
            token: String::new(),
            desktop_secret: None,
            source_profile_id: None,
            workspace_pointer: None,
            workspace_candidate: None,
            config_root: None,
            gateway_origin: "http://127.0.0.1:3210".into(),
            workspace_root: None,
            workspace_id: None,
            create_workspace: false,
        }),
        Arc::new(HostAuthority::new(None, None, None)),
        CancellationToken::new(),
    )
}

async fn mock(
    ws: std::result::Result<
        WebSocketUpgrade,
        axum::extract::ws::rejection::WebSocketUpgradeRejection,
    >,
    request: Request,
) -> Response {
    let progress = request.uri().path() == "/ws";
    if let Ok(ws) = ws {
        return ws.on_upgrade(move |mut socket| async move {
            if progress {
                socket.send(Message::Binary(vec![0, 159, 255].into())).await.unwrap();
                socket.send(Message::Text(r#"{"type":"progress","data":{"prompt_id":"foreign","value":1,"max":1}}"#.into())).await.unwrap();
                socket.send(Message::Text(r#"{"type":"progress","data":{"prompt_id":"fixture","value":4,"max":8,"node":"7"}}"#.into())).await.unwrap();
            }
            while let Some(Ok(message)) = socket.next().await { if socket.send(message).await.is_err() { break; } }
        });
    }
    if request.uri().path() == "/sdapi/v1/options" {
        return (
            StatusCode::FOUND,
            [("location", "http://203.0.113.1/never-follow")],
            "redirect",
        )
            .into_response();
    }
    let (parts, body) = request.into_parts();
    let body = body.collect().await.unwrap().to_bytes();
    let mut response = (
        StatusCode::ACCEPTED,
        [
            ("content-type", "application/octet-stream"),
            ("x-fixture", "preserved"),
        ],
        body,
    )
        .into_response();
    if let Some(auth) = parts.headers.get("authorization") {
        response
            .headers_mut()
            .insert("x-auth-observed", auth.clone());
    }
    response
}

async fn serve(router: Router) -> (String, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let handle = tokio::spawn(async move {
        axum::serve(
            listener,
            router.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    (format!("http://{address}"), handle)
}

async fn request(router: &Router, method: &str, path: &str, body: Body, remote: bool) -> Response {
    let mut request = Request::builder()
        .method(method)
        .uri(path)
        .body(body)
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(
        if remote {
            "192.0.2.1:49201"
        } else {
            "127.0.0.1:49201"
        }
        .parse::<SocketAddr>()
        .unwrap(),
    ));
    router.clone().oneshot(request).await.unwrap()
}

#[tokio::test]
async fn proxy_streams_large_body_preserves_responses_and_enforces_exact_allowlist() {
    let (upstream, server) = serve(Router::new().fallback(mock)).await;
    let router = router_with(Proxy {
        transport: LocalUpstream::new(),
        sd_host: upstream,
        sd_auth: Some("fixture:secret".into()),
    })
    .with_state(state());
    let bytes = vec![42_u8; 3 * 1024 * 1024];
    let response = request(
        &router,
        "POST",
        "/sdapi/v1/txt2img",
        Body::from(bytes.clone()),
        false,
    )
    .await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    assert_eq!(
        response.headers()["x-auth-observed"],
        "Basic Zml4dHVyZTpzZWNyZXQ="
    );
    assert_eq!(response.headers()["x-fixture"], "preserved");
    assert_eq!(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .as_ref(),
        bytes
    );
    assert_eq!(
        request(&router, "GET", "/sdapi/v1/options", Body::empty(), false)
            .await
            .status(),
        StatusCode::FOUND
    );
    assert_eq!(
        request(&router, "DELETE", "/sdapi/v1/options", Body::empty(), false)
            .await
            .status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
    assert_eq!(
        request(&router, "POST", "/sdapi/v1/options", Body::empty(), true)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    for path in ["/comfy/ws", "/prompt", "/queue", "/sdapi/v1/unknown"] {
        assert_eq!(
            request(&router, "GET", path, Body::empty(), false)
                .await
                .status(),
            StatusCode::NOT_FOUND
        );
    }
    server.abort();
}

#[tokio::test]
async fn bounded_json_transport_cancels_and_refuses_nonlocal_targets() {
    let diagnostic =
        serde_json::json!({"detail":"CUDA out of memory", "request":{"token":"private"}});
    assert_eq!(
        diagnostic_message(&diagnostic, "failed"),
        "failed：CUDA out of memory"
    );
    assert_eq!(
        diagnostic_message(&serde_json::json!("<html>proxy error</html>"), "failed"),
        "failed"
    );
    assert_eq!(
        diagnostic_message(&serde_json::json!("x".repeat(1000)), "failed")
            .chars()
            .count(),
        519
    );
    let (upstream, server) = serve(Router::new().fallback(|| async { "abcdefghijklmnop" })).await;
    let client = LocalUpstream::new();
    let token = CancellationToken::new();
    assert_eq!(
        client
            .json(&upstream, "/", None, Duration::from_secs(1), 8, &token)
            .await
            .unwrap_err()
            .code,
        "UPSTREAM_TOO_LARGE"
    );
    token.cancel();
    assert_eq!(
        client
            .json(&upstream, "/", None, Duration::from_secs(1), 64, &token)
            .await
            .unwrap_err()
            .code,
        "ABORTED"
    );
    assert!(local_url("http://192.168.1.5:7860").is_err());
    assert!(local_url("http://127.0.0.1:7860/private").is_err());
    assert!(local_url("https://127.0.0.1:7860").is_err());
    server.abort();
}

#[tokio::test]
async fn websocket_bridge_and_comfy_progress_use_only_simulated_upstreams() {
    let (upstream, model_server) = serve(Router::new().fallback(mock)).await;
    let router = router_with(Proxy {
        transport: LocalUpstream::new(),
        sd_host: upstream.clone(),
        sd_auth: None,
    })
    .with_state(state());
    let (proxy, proxy_server) = serve(router).await;
    let (mut socket, _) = tokio_tungstenite::connect_async(format!(
        "{}/sdapi/v1/progress",
        proxy.replace("http:", "ws:")
    ))
    .await
    .unwrap();
    socket
        .send(tokio_tungstenite::tungstenite::Message::Text(
            "hello".into(),
        ))
        .await
        .unwrap();
    let message = tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(message.into_text().unwrap(), "hello");
    socket.close(None).await.unwrap();
    let monitor = progress::ProgressMonitor::new(&upstream, "isolated test").unwrap();
    let mut updates = monitor.subscribe();
    monitor.watch("fixture");
    let event = tokio::time::timeout(Duration::from_secs(2), updates.recv())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(event.prompt_id, "fixture");
    assert_eq!(event.progress, Some(0.5));
    assert_eq!(event.current_node.as_deref(), Some("7"));
    monitor.unwatch("fixture");
    monitor.close().await;
    proxy_server.abort();
    model_server.abort();
}
