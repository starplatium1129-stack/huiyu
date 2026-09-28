use super::*;
use axum::{Json, Router, routing::get};

fn fixture(saved: Value) -> (tempfile::TempDir, Arc<ControlService>) {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().to_path_buf();
    std::fs::create_dir_all(root.join("runtime")).unwrap();
    std::fs::write(
        root.join("runtime/config.json"),
        serde_json::to_vec(&saved).unwrap(),
    )
    .unwrap();
    let config = Arc::new(Config {
        app_root: root.clone(),
        runtime_root: root.join("runtime"),
        ai_workspace_root: root.join("AI"),
        sd_host: "http://127.0.0.1:1".into(),
        sd_auth: None,
        comfy_host: "http://127.0.0.1:1".into(),
        bind: "127.0.0.1:3210".parse().unwrap(),
        token: "fixture-secret-token".into(),
        desktop_secret: None,
        source_profile_id: None,
        workspace_pointer: None,
        workspace_candidate: None,
        config_root: None,
        gateway_origin: "http://127.0.0.1:3210".into(),
        workspace_root: None,
        workspace_id: None,
        create_workspace: false,
    });
    let cancel = CancellationToken::new();
    let remote = Arc::new(RemoteAccess::new(&config, cancel.clone()));
    let voice = Arc::new(crate::voice::VoiceService::new(&config, cancel.clone()));
    let service = ControlService::new(config, remote, cancel, voice);
    (temp, service)
}
#[tokio::test]
async fn config_commit_preserves_unknown_fields_and_requires_restart() {
    let (_temp, s) = fixture(json!({"privateOther":{"credential":"secret"}}));
    let saved = s
        .patch(http::validated_patch(json!({"sdHost":"http://127.0.0.1:9999"})).unwrap())
        .await
        .unwrap();
    assert_eq!(saved["sdHost"], "http://127.0.0.1:1");
    assert_eq!(saved["savedConfig"]["sdHost"], "http://127.0.0.1:9999");
    assert_eq!(saved["restartRequired"], true);
    assert!(saved["savedConfig"].get("privateOther").is_none());
    let (a, b) = tokio::join!(
        s.patch(json!({"autoStartVoice":true})),
        s.patch(json!({"autoTunnel":false}))
    );
    a.unwrap();
    b.unwrap();
    let disk: Value =
        serde_json::from_slice(&std::fs::read(s.config.runtime_root.join("config.json")).unwrap())
            .unwrap();
    assert_eq!(disk["privateOther"]["credential"], "secret");
    assert_eq!(disk["autoStartVoice"], true);
    assert_eq!(disk["autoTunnel"], false);
    let cleared = s
        .patch(json!({"sdHost":"http://127.0.0.1:1"}))
        .await
        .unwrap();
    assert_eq!(cleared["restartRequired"], false);
    s.close().await;
}
#[tokio::test]
async fn corrupt_existing_config_is_not_overwritten() {
    let (_temp, s) = fixture(json!({}));
    std::fs::write(s.config.runtime_root.join("config.json"), b"broken-json").unwrap();
    assert!(s.patch(json!({"autoTunnel":false})).await.is_err());
    assert_eq!(
        std::fs::read(s.config.runtime_root.join("config.json")).unwrap(),
        b"broken-json"
    );
    s.close().await;
}
#[test]
fn configuration_rejects_remote_credentials_and_unknown_fields() {
    for host in [
        "https://example.com",
        "http://127.0.0.1:1234/path",
        "http://user:password@127.0.0.1:1234",
        "http://127.0.0.1:1234/?token=x",
    ] {
        assert!(http::validated_patch(json!({"sdHost":host})).is_err());
    }
    assert!(http::validated_patch(json!({"cloudflaredPath":"payload.exe"})).is_err());
    assert!(http::validated_patch(json!({"autoStartVoice":"yes"})).is_err());
}
#[tokio::test]
async fn operation_is_exclusive_and_old_completion_cannot_finish_new_work() {
    let (_temp, s) = fixture(json!({}));
    let first = s.begin("first", &["one", "two"]).unwrap();
    assert_eq!(s.begin("second", &[]).unwrap_err().status.as_u16(), 409);
    s.finish(&first, Ok(()));
    let second = s.begin("second", &[]).unwrap();
    s.finish(&first, Err(ApiError::invalid("late")));
    assert_eq!(
        s.state.lock().unwrap().operation.as_ref().unwrap()["id"],
        second["id"]
    );
    assert_eq!(
        s.state.lock().unwrap().operation.as_ref().unwrap()["status"],
        "running"
    );
    s.finish(&second, Ok(()));
    s.close().await;
}
#[tokio::test]
async fn saved_managed_preferences_never_authorize_automatic_launch() {
    let (_temp, s) = fixture(
        json!({"autoStartVoice":true,"autoTunnel":true,"managedServices":{"webui":true,"comfy":true}}),
    );
    s.watchdog().await;
    assert!(
        s.state
            .lock()
            .unwrap()
            .managed
            .iter()
            .all(|m| !m.desired && !m.owned)
    );
    assert!(s.tunnel.lock().await.is_none());
    assert!(s.remote.tunnel_url().is_empty());
    s.close().await;
}
#[tokio::test]
async fn healthy_external_service_is_not_adopted_by_watchdog() {
    let (_temp, s) = fixture(json!({}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new().route("/system_stats", get(|| async { Json(json!({})) })),
        )
        .await
        .unwrap();
    });
    s.settings.write().unwrap()["comfyHost"] = json!(format!("http://{addr}"));
    let op = s.begin("comfy-start", &["start", "verify"]).unwrap();
    s.service_action(1, true, &op).await.unwrap();
    assert!(!s.state.lock().unwrap().managed[1].owned);
    assert!(!s.state.lock().unwrap().managed[1].desired);
    s.finish(&op, Ok(()));
    s.close().await;
    server.abort();
}
#[tokio::test]
async fn log_cursor_remains_monotonic_and_secrets_are_redacted() {
    let (_temp, s) = fixture(json!({}));
    for i in 0..250 {
        s.log(&format!(
            "{i} fixture-secret-token https://example.trycloudflare.com/?token=abc"
        ));
    }
    {
        let state = s.state.lock().unwrap();
        assert_eq!(state.log_seq, 250);
        assert_eq!(state.logs.len(), 200);
        assert!(
            state
                .logs
                .iter()
                .all(|line| !line.contains("fixture-secret-token")
                    && !line.contains("trycloudflare")
                    && !line.contains("abc"))
        );
    }
    s.close().await;
}
#[tokio::test]
async fn shutdown_cancels_owned_script_and_prevents_new_operations() {
    let (_temp, s) = fixture(json!({}));
    let mut command = if cfg!(windows) {
        let mut c = tokio::process::Command::new("powershell.exe");
        c.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ]);
        c
    } else {
        let mut c = tokio::process::Command::new("sleep");
        c.arg("30");
        c
    };
    command
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let task = {
        let s = s.clone();
        tokio::spawn(async move { s.run_command(command, 60).await })
    };
    tokio::time::sleep(Duration::from_millis(100)).await;
    s.shutdown.cancel();
    assert!(
        tokio::time::timeout(Duration::from_secs(8), task)
            .await
            .unwrap()
            .unwrap()
            .is_err()
    );
    assert!(s.begin("new", &[]).is_err());
    s.close().await;
}
#[test]
fn tunnel_publication_accepts_only_quick_tunnel_host() {
    assert_eq!(
        tunnel::tunnel_url("https://my-test.trycloudflare.com |"),
        Some("https://my-test.trycloudflare.com".into())
    );
    assert!(tunnel::tunnel_url("https://trycloudflare.com.evil.example").is_none());
    assert!(tunnel::tunnel_url("https://foo.trycloudflare.com.evil.example").is_none());
}

#[tokio::test]
async fn routes_reject_tunnel_local_spoof_and_preserve_sd_status_shape() {
    use axum::{
        body::{Body, to_bytes},
        extract::ConnectInfo,
        http::Request,
    };
    use tower::ServiceExt;
    let (_temp, s) = fixture(json!({}));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let upstream = tokio::spawn(async move {
        axum::serve(
            listener,
            Router::new()
                .route(
                    "/sdapi/v1/sd-models",
                    get(|| async { Json(json!([{"title":"fixture-checkpoint"}])) }),
                )
                .route(
                    "/sdapi/v1/options",
                    get(|| async { Json(json!({"sd_model_checkpoint":"fixture-checkpoint"})) }),
                )
                .route(
                    "/sdapi/v1/samplers",
                    get(|| async { Json(json!([{"name":"Euler"}])) }),
                )
                .route(
                    "/sdapi/v1/schedulers",
                    get(|| async { Json(json!([{"label":"Normal"}])) }),
                )
                .route(
                    "/sdapi/v1/upscalers",
                    get(|| async { Json(json!([{"name":"Lanczos"}])) }),
                ),
        )
        .await
        .unwrap();
    });
    s.settings.write().unwrap()["sdHost"] = json!(format!("http://{addr}"));
    let state = crate::AppState::new(
        s.config.clone(),
        Arc::new(crate::host::HostAuthority::new(None, None, None)),
        s.shutdown.clone(),
    );
    let app = router(s.clone()).with_state(state);
    let request = Request::builder()
        .uri("/api/share-link")
        .header("host", "localhost:3210")
        .header("x-forwarded-for", "203.0.113.1")
        .extension(ConnectInfo(
            "127.0.0.1:3333".parse::<std::net::SocketAddr>().unwrap(),
        ))
        .body(Body::empty())
        .unwrap();
    assert_eq!(app.clone().oneshot(request).await.unwrap().status(), 403);
    let request = Request::builder()
        .uri("/api/sd-status")
        .body(Body::empty())
        .unwrap();
    let response = app.oneshot(request).await.unwrap();
    assert_eq!(response.status(), 200);
    let value: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
    assert_eq!(value["online"], true);
    assert!(value.get("ok").is_none());
    assert_eq!(value["models"], json!(["fixture-checkpoint"]));
    assert_eq!(value["samplers"], json!(["Euler"]));
    assert_eq!(value["schedulers"], json!(["Normal"]));
    assert_eq!(value["checkpoint"], "fixture-checkpoint");
    s.close().await;
    upstream.abort();
}
