use super::*;
use crate::host::HostAuthority;
use axum::{body::Body, http::Request};
use base64::{Engine, engine::general_purpose::STANDARD};
use http_body_util::BodyExt;
use tower::ServiceExt;

fn fixture() -> (tempfile::TempDir, Arc<DesktopToolsService>, Router) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("AI");
    std::fs::create_dir_all(&root).unwrap();
    let config = Arc::new(Config {
        app_root: directory.path().into(),
        runtime_root: directory.path().join("runtime"),
        ai_workspace_root: root,
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
    });
    let shutdown = CancellationToken::new();
    let mut service = DesktopToolsService::new(&config, shutdown.clone());
    service.trusted = false;
    let service = Arc::new(service);
    let state = AppState::new(
        config,
        Arc::new(HostAuthority::new(None, None, None)),
        shutdown,
    );
    (
        directory,
        service.clone(),
        router(service).with_state(state),
    )
}
async fn call(app: &Router, payload: Value, remote: bool) -> (StatusCode, Value) {
    let mut request = Request::builder()
        .method("POST")
        .uri("/api/desktop-tools")
        .header("content-type", "application/json")
        .body(Body::from(payload.to_string()))
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(
        if remote {
            "192.0.2.1:12345"
        } else {
            "127.0.0.1:12345"
        }
        .parse::<SocketAddr>()
        .unwrap(),
    ));
    let response = app.clone().oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (status, serde_json::from_slice(&bytes).unwrap())
}

#[tokio::test]
async fn file_tools_use_actual_workspace_and_reject_escape_or_oversized_data() {
    let (directory, service, app) = fixture();
    let (_, written) = call(
        &app,
        json!({"name":"write_file","args":{"path":"notes/hello.txt","content":"你好，Rust"}}),
        false,
    )
    .await;
    assert_eq!(written["ok"], true);
    assert_eq!(
        std::fs::read_to_string(service.root.join("notes/hello.txt")).unwrap(),
        "你好，Rust"
    );
    let (_, read) = call(
        &app,
        json!({"name":"read_file","args":{"path":"notes/hello.txt"}}),
        false,
    )
    .await;
    assert_eq!(read["output"], "你好，Rust");
    let (_, listed) = call(&app, json!({"name":"list_files","args":{"path":""}}), false).await;
    assert!(listed["output"].as_str().unwrap().contains("notes/"));
    let (_, escape) = call(
        &app,
        json!({"name":"read_file","args":{"path":"../outside.txt"}}),
        false,
    )
    .await;
    assert_eq!(escape["ok"], false);
    let (_, big) = call(
        &app,
        json!({"name":"write_file","args":{"path":"large.txt","content":"x".repeat(512*1024+1)}}),
        false,
    )
    .await;
    assert_eq!(big["ok"], false);
    assert!(!service.root.join("large.txt").exists());
    assert_eq!(
        call(&app, json!({"name":"get_workspace_info"}), true)
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    let outside = directory.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "isolated outside fixture").unwrap();
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // Junction creation needs no symlink privilege. This helper only creates
        // one link inside the disposable fixture; it never invokes run_command.
        let status = std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:AICS_TEST_LINK -Target $env:AICS_TEST_TARGET | Out-Null"])
            .env("AICS_TEST_LINK", service.root.join("escape-link"))
            .env("AICS_TEST_TARGET", &outside)
            .creation_flags(0x08000000)
            .status().unwrap();
        assert!(
            status.success(),
            "Could not create isolated junction fixture"
        );
    }
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, service.root.join("escape-link")).unwrap();
    #[cfg(any(windows, unix))]
    {
        let (_, linked) = call(
            &app,
            json!({"name":"read_file","args":{"path":"escape-link/secret.txt"}}),
            false,
        )
        .await;
        assert_eq!(linked["ok"], false);
        let (_, write) = call(
            &app,
            json!({"name":"write_file","args":{"path":"escape-link/new.txt","content":"blocked"}}),
            false,
        )
        .await;
        assert_eq!(write["ok"], false);
        assert!(!outside.join("new.txt").exists());
    }
    service.close().await;
}

#[tokio::test]
async fn image_and_draw_tools_return_bytes_or_drafts_without_claiming_generation() {
    let (_directory, service, app) = fixture();
    let image = b"\x89PNG\r\n\x1a\nfixture";
    std::fs::write(service.root.join("sample.png"), image).unwrap();
    let (_, read) = call(
        &app,
        json!({"name":"read_image","args":{"path":"sample.png"}}),
        false,
    )
    .await;
    assert_eq!(
        read["imageDataUrl"],
        format!("data:image/png;base64,{}", STANDARD.encode(image))
    );
    let (_,denied)=call(&app,json!({"name":"generate_character_image","args":{"character":"natsume","description":"fixture","outfit":"nsfw_nude","adultEnabled":true}}),false).await;
    assert_eq!(denied["code"], "adult_not_enabled");
    assert!(!service.root.join("generated-images").exists());
    let (_,draft)=call(&app,json!({"name":"generate_character_image","args":{"character":"natsume","description":"在咖啡馆","outfit":"default"}}),false).await;
    assert_eq!(draft["status"], "draft");
    assert!(draft.get("imageDataUrl").is_none());
    let payload: Value = serde_json::from_slice(
        &std::fs::read(
            service
                .root
                .join(draft["draftRelativePath"].as_str().unwrap()),
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(
        payload["promptTokens"],
        json!([
            "shiki_natsume",
            "1girl",
            "solo",
            "mole under right eye",
            "default",
            "在咖啡馆"
        ])
    );
    assert_eq!(
        payload["loras"],
        json!([{"id":"L_NAT_V21_ANIMA","strength":0.85}])
    );
    assert_eq!(payload["mature"], false);
    assert_eq!(payload["status"], "draft");
    service.close().await;
}

#[tokio::test]
async fn commands_remain_disabled_and_shutdown_blocks_work_without_starting_processes() {
    let (_directory, service, app) = fixture();
    let (_,denied)=call(&app,json!({"name":"run_command","args":{"command":"node","args":["--version"],"trustedCommands":true}}),false).await;
    assert_eq!(denied["code"], "TRUSTED_EXECUTION_REQUIRED");
    assert!(
        commands::resolve(&service.root, "../escape.exe", Vec::new())
            .await
            .is_err()
    );
    assert!(
        commands::resolve(&service.root, "cmd.exe", Vec::new())
            .await
            .is_err()
    );
    #[cfg(windows)]
    assert!(
        commands::resolve(&service.root, "scripts/unavailable.cmd", Vec::new())
            .await
            .is_err()
    );
    let (_, info) = call(&app, json!({"name":"get_workspace_info"}), false).await;
    let info: Value = serde_json::from_str(info["output"].as_str().unwrap()).unwrap();
    assert_eq!(info["commandMode"], "disabled");
    service.close().await;
    let (_, cancelled) = call(
        &app,
        json!({"name":"write_file","args":{"path":"cancelled.txt","content":"never write"}}),
        false,
    )
    .await;
    assert_eq!(cancelled["code"], "ABORT_ERR");
    assert!(!service.root.join("cancelled.txt").exists());
    let mut fake = tokio::process::Command::new("never-spawn-closed-pool");
    assert_eq!(
        service.processes.spawn(&mut fake).err().unwrap().code,
        "ABORT_ERR"
    );
}
