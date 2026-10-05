use super::*;
use axum::{
    Router,
    extract::{ConnectInfo, Request, State},
    middleware::Next,
    routing::get,
};
use serde_json::json;
use std::{
    net::SocketAddr,
    sync::atomic::{AtomicUsize, Ordering},
    time::SystemTime,
};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const TOKEN: &str = "isolated-test-token";
#[derive(Clone)]
struct Context {
    content: Arc<RemoteContent>,
    access: Arc<RemoteAccess>,
    private_hits: Arc<AtomicUsize>,
}
async fn gate(
    State(state): State<Context>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    request: Request,
    next: Next,
) -> Response {
    if !request
        .headers()
        .get("host")
        .and_then(|h| h.to_str().ok())
        .is_some_and(|host| state.access.host_allowed(host))
    {
        return axum::http::StatusCode::MISDIRECTED_REQUEST.into_response();
    }
    if let Some(response) = state
        .access
        .guard(
            TOKEN,
            request.method(),
            request.uri(),
            request.headers(),
            peer.ip(),
        )
        .await
    {
        return response;
    }
    next.run(request).await
}
async fn local_source(State(state): State<Context>) -> Response {
    (
        [("content-type", "application/json")],
        tokio::fs::read(state.content.app.join("data/scenes.json"))
            .await
            .unwrap(),
    )
        .into_response()
}
async fn private_source(State(state): State<Context>) -> &'static str {
    state.private_hits.fetch_add(1, Ordering::SeqCst);
    "PRIVATE_WORKSPACE"
}
async fn shell(State(state): State<Context>, request: Request) -> Response {
    if let Some(response) = precompressed(
        &state.content.app,
        &state.content.assets,
        request.method(),
        request.uri(),
        request.headers(),
    )
    .await
    {
        return response;
    }
    "trusted shell source".into_response()
}
fn release(url: &str, bytes: &[u8]) -> Value {
    json!({"url":url,"rating":"All","sha256":hex::encode(Sha256::digest(bytes)),"bytes":bytes.len(),"reviewedAt":"2026-09-21T00:00:00Z"})
}
async fn fixture() -> (
    tempfile::TempDir,
    Context,
    SocketAddr,
    reqwest::Client,
    CancellationToken,
) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path();
    for name in [
        "app/data",
        "app/dist/_app",
        "assets/live2d-candidates",
        "showcase/thumbs",
        "runtime/state",
    ] {
        tokio::fs::create_dir_all(root.join(name)).await.unwrap();
    }
    let data = serde_json::to_vec(&json!([
        {"id":"safe","title":"Public directory","rating":"All","prompt":"PRIVATE_RECIPE","negative":"PRIVATE_NEGATIVE","image":"/private.png"},
        {"id":"adult","rating":"R18","mature":true}, {"id":"unknown"}, {"id":"contradiction","rating":"All","nsfw":true}
    ])).unwrap();
    tokio::fs::write(root.join("app/data/scenes.json"), &data)
        .await
        .unwrap();
    tokio::fs::write(
        root.join("app/data/scenes.json.br"),
        b"PRIVATE_COMPRESSED_RECIPE",
    )
    .await
    .unwrap();
    tokio::fs::write(root.join("app/data/character-reference-view.json"), &data)
        .await
        .unwrap();
    tokio::fs::write(root.join("showcase/manifest.json"), b"{\"entries\":[]}")
        .await
        .unwrap();
    for name in [
        "showcase/thumbs/safe.png",
        "assets/unpublished.png",
        "assets/live2d-candidates/private.png",
    ] {
        tokio::fs::write(root.join(name), b"neutral picture fixture")
            .await
            .unwrap();
    }
    for (name, bytes) in [
        ("test.js", "trusted shell source"),
        ("test.js.br", "br fixture"),
        ("test.js.gz", "gzip fixture"),
    ] {
        tokio::fs::write(root.join("app/dist/_app").join(name), bytes)
            .await
            .unwrap();
    }
    let stop = CancellationToken::new();
    let content = RemoteContent {
        app: root.join("app"),
        assets: root.join("assets"),
        runtime: root.join("runtime"),
        showcase: vec![root.join("showcase")],
        readers: Arc::new(Semaphore::new(4)),
        shutdown: stop.clone(),
    };
    let content = Arc::new(content);
    let state = Context {
        access: Arc::new(RemoteAccess::with_content(content.clone())),
        content,
        private_hits: Arc::new(AtomicUsize::new(0)),
    };
    let app = Router::new()
        .route("/data/scenes.json", get(local_source))
        .route("/api/workspace/status", get(private_source))
        .route("/sdapi/v1/progress", get(private_source))
        .route(
            "/api/chat",
            get(private_source).post(|| async { "public chat fixture" }),
        )
        .route("/_app/test.js", get(shell))
        .route("/", get(|| async { "shell" }))
        .fallback(|| async { axum::http::StatusCode::NOT_FOUND })
        .layer(axum::middleware::from_fn_with_state(state.clone(), gate))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let finished = stop.clone();
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(finished.cancelled_owned())
        .await
        .unwrap();
    });
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(5))
        .no_proxy()
        .build()
        .unwrap();
    (directory, state, address, client, stop)
}
fn remote(client: &reqwest::Client, address: SocketAddr, path: &str) -> reqwest::RequestBuilder {
    client
        .get(format!("http://{address}{path}"))
        .header("x-forwarded-for", "198.51.100.8")
        .header("x-token", TOKEN)
}
async fn raw_status(address: SocketAddr, path: &str) -> u16 {
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    socket.write_all(format!("GET {path} HTTP/1.1\r\nHost: {address}\r\nX-Token: {TOKEN}\r\nX-Forwarded-For: 198.51.100.8\r\nConnection: close\r\n\r\n").as_bytes()).await.unwrap();
    let mut bytes = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), socket.read_to_end(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    std::str::from_utf8(&bytes)
        .unwrap()
        .split_whitespace()
        .nth(1)
        .unwrap()
        .parse()
        .unwrap()
}

#[tokio::test]
async fn reviewed_projection_binds_exact_bytes_before_head_range_compression_and_revocation() {
    let (directory, state, address, client, stop) = fixture().await;
    let root = directory.path();
    let index = root.join("runtime/state/remote-content-release.json");
    assert_eq!(
        remote(&client, address, "/data/scenes.json")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let data = tokio::fs::read(root.join("app/data/scenes.json"))
        .await
        .unwrap();
    let mut entries = vec![
        release("/data/scenes.json", &data),
        release(
            "/scene-showcase/thumbs/safe.png",
            b"neutral picture fixture",
        ),
        release("/data/character-reference-view.json", &data),
        release(
            "/assets/live2d-candidates/private.png",
            b"neutral picture fixture",
        ),
    ];
    tokio::fs::write(
        &index,
        serde_json::to_vec(&json!({"version":1,"resources":entries})).unwrap(),
    )
    .await
    .unwrap();
    for encoding in ["identity", "br", "gzip"] {
        let response = remote(&client, address, "/data/scenes.json")
            .header("accept-encoding", encoding)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert_eq!(response.headers()["cache-control"], "private, no-store");
        assert_eq!(
            response.json::<Value>().await.unwrap(),
            json!([{"id":"safe","rating":"All","title":"Public directory"}])
        );
        let response = client
            .head(format!("http://{address}/data/scenes.json"))
            .header("x-forwarded-for", "198.51.100.8")
            .header("x-token", TOKEN)
            .header("accept-encoding", encoding)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert!(response.bytes().await.unwrap().is_empty());
    }
    assert!(
        client
            .get(format!("http://{address}/data/scenes.json"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap()
            .contains("PRIVATE_RECIPE")
    );
    for path in [
        "/data/scenes.json.br",
        "/data/scenes.json.gz",
        "/DATA/scenes.json",
        "/data%2fscenes.json",
        "/assets%5cunpublished.png",
        "/character-references/private.png",
        "/data/character-reference-view.json",
        "/assets/unpublished.png",
        "/assets/live2d-candidates/private.png",
    ] {
        assert_eq!(
            remote(&client, address, path)
                .header("range", "bytes=0-2")
                .header("if-none-match", "old-local-etag")
                .send()
                .await
                .unwrap()
                .status(),
            403,
            "{path}"
        );
    }
    for path in [
        "/data/./scenes.json",
        "/data/x/../scenes.json",
        "//data/scenes.json",
        "/data/%2e/scenes.json",
        "/data%5cscenes.json",
    ] {
        assert_eq!(raw_status(address, path).await, 403, "{path}");
    }
    let image = remote(&client, address, "/scene-showcase/thumbs/safe.png")
        .header("range", "bytes=0-2")
        .send()
        .await
        .unwrap();
    assert_eq!(image.status(), 200);
    assert_eq!(
        image.bytes().await.unwrap().as_ref(),
        b"neutral picture fixture"
    );
    entries.push(entries[0].clone());
    tokio::fs::write(
        &index,
        serde_json::to_vec(&json!({"version":1,"resources":entries})).unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(
        remote(&client, address, "/data/scenes.json")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    entries.pop();
    tokio::fs::write(
        &index,
        serde_json::to_vec(&json!({"version":1,"resources":entries})).unwrap(),
    )
    .await
    .unwrap();
    tokio::fs::write(root.join("app/data/scenes.json"), b"changed")
        .await
        .unwrap();
    assert_eq!(
        remote(&client, address, "/data/scenes.json")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    tokio::fs::remove_file(index).await.unwrap();
    assert_eq!(
        remote(&client, address, "/scene-showcase/thumbs/safe.png")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(state.private_hits.load(Ordering::SeqCst), 0);
    stop.cancel();
}

#[tokio::test]
async fn remote_token_cookies_cannot_reach_private_routes_or_bypass_precompressed_policy() {
    let (directory, state, address, client, stop) = fixture().await;
    for method in [Method::GET, Method::HEAD] {
        for query in ["", "?skip_current_image=false", "?skip_current_image=true"] {
            let mut request = remote(&client, address, &format!("/sdapi/v1/progress{query}"))
                .build()
                .unwrap();
            *request.method_mut() = method.clone();
            let response = client.execute(request).await.unwrap();
            assert_eq!(response.status(), 403);
        }
    }
    assert_eq!(state.private_hits.load(Ordering::SeqCst), 0);
    let missing = client
        .get(format!("http://{address}/api/workspace/status"))
        .header("x-forwarded-for", "198.51.100.8")
        .send()
        .await
        .unwrap();
    assert_eq!(missing.status(), 401);
    assert_eq!(
        remote(&client, address, "/api/workspace/status")
            .header("x-aics-workspace-session", "local-private-session")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    assert_eq!(
        remote(&client, address, "/api/chat")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let redirect = remote(&client, address, &format!("/?token={TOKEN}&view=public"))
        .header("x-forwarded-proto", "https")
        .send()
        .await
        .unwrap();
    assert_eq!(redirect.status(), 302);
    assert_eq!(redirect.headers()["location"], "/?view=public");
    let cookie = redirect.headers()["set-cookie"].to_str().unwrap();
    assert!(
        cookie.contains("HttpOnly")
            && cookie.contains("SameSite=Lax")
            && cookie.ends_with("; Secure")
    );
    let cookie = cookie.split(';').next().unwrap();
    assert_eq!(
        client
            .get(format!("http://{address}/"))
            .header("x-forwarded-for", "198.51.100.8")
            .header("cookie", cookie)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    assert_eq!(
        remote(&client, address, "/_app/test.js")
            .header("host", "attacker.example")
            .send()
            .await
            .unwrap()
            .status(),
        421
    );
    let source = remote(&client, address, "/_app/test.js")
        .header("accept-encoding", "br;q=0.2, gzip;q=1")
        .send()
        .await
        .unwrap();
    assert_eq!(source.headers()["content-encoding"], "gzip");
    assert_eq!(source.bytes().await.unwrap().as_ref(), b"gzip fixture");
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(directory.path().join("app/dist/_app/test.js"))
        .unwrap();
    file.set_modified(SystemTime::now() + Duration::from_secs(3))
        .unwrap();
    drop(file);
    let stale = remote(&client, address, "/_app/test.js")
        .header("accept-encoding", "br,gzip")
        .send()
        .await
        .unwrap();
    assert!(!stale.headers().contains_key("content-encoding"));
    assert_eq!(stale.text().await.unwrap(), "trusted shell source");
    let outside = directory.path().join("outside.png");
    tokio::fs::write(&outside, b"private").await.unwrap();
    assert!(
        rooted(&state.content.assets, "../outside.png")
            .await
            .is_err()
    );
    assert_eq!(state.private_hits.load(Ordering::SeqCst), 0);
    state
        .access
        .set_tunnel_url("https://fixture.trycloudflare.com")
        .unwrap();
    for _ in 0..10 {
        let response = client
            .post(format!("http://{address}/api/chat"))
            .header("host", "fixture.trycloudflare.com")
            .header("x-forwarded-for", "198.51.100.8")
            .header("x-token", TOKEN)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
    }
    let limited = client
        .post(format!("http://{address}/api/chat"))
        .header("x-forwarded-for", "198.51.100.9")
        .header("x-token", TOKEN)
        .send()
        .await
        .unwrap();
    assert_eq!(limited.status(), 429);
    assert_eq!(limited.headers()["retry-after"], "3");
    assert_eq!(
        client
            .post(format!("http://{address}/api/chat"))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
    state.access.set_tunnel_url("").unwrap();
    assert!(!state.access.host_allowed("fixture.trycloudflare.com"));
    stop.cancel();
}
