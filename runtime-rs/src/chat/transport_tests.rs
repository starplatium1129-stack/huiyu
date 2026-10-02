use super::*;
use std::{collections::HashMap, sync::Arc};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
    sync::Mutex,
};

const CHILD: &str = "AICS_CHAT_PROXY_FIXTURE";
const TEST: &str = "chat::transport::tests::configured_proxy_routes_and_releases_cancelled_tunnels";

async fn state(client: &reqwest::Client, base: &str, stage: &str) -> String {
    client
        .get(format!("{base}/state/{stage}"))
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap()
}

async fn proxy_child(base: &str) {
    assert_eq!(
        proxy(&Url::parse("http://upstream-fixture.invalid/").unwrap())
            .unwrap()
            .as_str(),
        format!("{base}/")
    );
    assert_eq!(
        proxy(&Url::parse("https://upstream-fixture.invalid/").unwrap())
            .unwrap()
            .as_str(),
        format!("{base}/")
    );
    assert!(proxy(&Url::parse("https://child.bypass.invalid/").unwrap()).is_none());
    for host in ["localhost", "127.0.0.1", "::1", "[::1]"] {
        assert!(no_proxy(host, ""));
    }
    for value in [
        "*",
        "upstream-fixture.invalid",
        ".upstream-fixture.invalid",
        "*.upstream-fixture.invalid",
        "upstream-fixture.invalid:443",
    ] {
        assert!(no_proxy("upstream-fixture.invalid", value));
    }
    assert!(!no_proxy("upstream-fixture.invalid", "unrelated.invalid"));
    let transport = Arc::new(Transport::new());
    let request = || Request {
        body: None,
        key: "",
        public_only: false,
        idle: Duration::from_secs(5),
        total: Duration::from_secs(5),
        accept: "application/json",
    };
    let response = transport
        .send(
            Url::parse("http://upstream-fixture.invalid/ok").unwrap(),
            request(),
        )
        .await
        .unwrap();
    assert_eq!(
        bounded(response, 1024).await.unwrap(),
        b"{\"via\":\"proxy\"}"
    );
    let local = transport
        .send(Url::parse(&format!("{base}/local")).unwrap(), request())
        .await
        .unwrap();
    assert_eq!(bounded(local, 1024).await.unwrap(), b"direct");
    // Each cancellation waits for an observed CONNECT or ClientHello, not a fixed sleep.
    let control = builder().build().unwrap();
    for stage in ["connect", "tls"] {
        let active = transport.clone();
        let pending = tokio::spawn(async move {
            active
                .send(
                    Url::parse(&format!("https://{stage}.invalid/")).unwrap(),
                    Request {
                        body: None,
                        key: "",
                        public_only: false,
                        idle: Duration::from_secs(30),
                        total: Duration::from_secs(30),
                        accept: "application/json",
                    },
                )
                .await
        });
        tokio::time::timeout(Duration::from_secs(3), async {
            while state(&control, base, stage).await != "ready" {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        pending.abort();
        assert!(pending.await.unwrap_err().is_cancelled());
        tokio::time::timeout(Duration::from_secs(3), async {
            while state(&control, base, stage).await != "closed" {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("cancelled CONNECT/TLS must close its proxy socket");
        let live = transport
            .send(Url::parse(&format!("{base}/local")).unwrap(), request())
            .await
            .unwrap();
        assert_eq!(
            bounded(live, 1024).await.unwrap(),
            b"direct",
            "cancelling one request must preserve the shared client"
        );
    }
}

#[tokio::test]
async fn configured_proxy_routes_and_releases_cancelled_tunnels() {
    if let Ok(base) = env::var(CHILD) {
        proxy_child(&base).await;
        return;
    }
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let stages = Arc::new(Mutex::new(HashMap::<String, &'static str>::new()));
    let connections = Arc::new(Mutex::new(Vec::new()));
    let owned = connections.clone();
    let server = tokio::spawn(async move {
        while let Ok((mut socket, _)) = listener.accept().await {
            let stages = stages.clone();
            owned.lock().await.push(tokio::spawn(async move {
                let mut headers = Vec::new();
                let mut bytes = [0; 4096];
                while !headers.windows(4).any(|part| part == b"\r\n\r\n") {
                    let count = socket.read(&mut bytes).await.unwrap();
                    if count == 0 {
                        return;
                    }
                    headers.extend_from_slice(&bytes[..count]);
                    assert!(headers.len() <= 8192);
                }
                let line = String::from_utf8_lossy(&headers)
                    .lines()
                    .next()
                    .unwrap()
                    .to_string();
                if line.starts_with("CONNECT ") {
                    let stage = if line.contains("tls.invalid:") {
                        "tls"
                    } else {
                        "connect"
                    };
                    if stage == "tls" {
                        socket
                            .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
                            .await
                            .unwrap();
                        assert!(
                            socket.read(&mut bytes).await.unwrap() > 0,
                            "TLS ClientHello must reach the tunnel"
                        );
                    }
                    stages.lock().await.insert(stage.into(), "ready");
                    while let Ok(count) = socket.read(&mut bytes).await {
                        if count == 0 {
                            break;
                        }
                    }
                    stages.lock().await.insert(stage.into(), "closed");
                    return;
                }
                let target = line.split_whitespace().nth(1).unwrap();
                let body = if target == "http://upstream-fixture.invalid/ok" {
                    "{\"via\":\"proxy\"}".to_string()
                } else if target == "/local" {
                    "direct".to_string()
                } else {
                    stages
                        .lock()
                        .await
                        .get(target.strip_prefix("/state/").unwrap())
                        .copied()
                        .unwrap_or("pending")
                        .to_string()
                };
                let reply = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                socket.write_all(reply.as_bytes()).await.unwrap();
            }));
        }
    });
    // Proxy environment belongs to a separate process; parallel tests never see it.
    let mut child = tokio::process::Command::new(std::env::current_exe().unwrap());
    child
        .args(["--exact", TEST, "--nocapture"])
        .env(CHILD, &base)
        .env("HTTP_PROXY", &base)
        .env("HTTPS_PROXY", &base)
        .env("NO_PROXY", ".bypass.invalid")
        .env_remove("ALL_PROXY")
        .env_remove("all_proxy")
        .kill_on_drop(true);
    // Windows environment names are case insensitive; Unix can exercise the
    // empty-uppercase fallback and uppercase proxy precedence independently.
    #[cfg(not(windows))]
    child
        .env("http_proxy", "http://127.0.0.1:1")
        .env("https_proxy", "http://127.0.0.1:1")
        .env("NO_PROXY", "")
        .env("no_proxy", ".bypass.invalid");
    #[cfg(windows)]
    child.creation_flags(0x08000000);
    let result = tokio::time::timeout(Duration::from_secs(15), child.output()).await;
    server.abort();
    for task in connections.lock().await.drain(..) {
        task.abort();
    }
    let output = result.unwrap().unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
}
