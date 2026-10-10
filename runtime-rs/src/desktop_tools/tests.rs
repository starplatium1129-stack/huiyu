use super::*;
use crate::host::HostAuthority;
use axum::{body::Body, http::Request};
use base64::{Engine, engine::general_purpose::STANDARD};
use http_body_util::BodyExt;
use std::{path::Path, time::Duration};
use tower::ServiceExt;

#[test]
fn abandoned_file_write_reclaims_temporary_at_io_boundaries() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .max_blocking_threads(1)
        .enable_all()
        .build()
        .unwrap();
    // Walk the real I/O suspension points without depending on their number or
    // adding a production hook. The occupied pool keeps the next I/O queued.
    for abort_at in 0..32 {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let target = root.join("existing.txt");
        std::fs::write(&target, b"previous content").unwrap();
        let completed = runtime.block_on(async {
            let cancel = CancellationToken::new();
            let mut writing = Box::pin(files::atomic(
                &root,
                "existing.txt",
                &target,
                b"new content",
                &cancel,
            ));
            for step in 0..=abort_at {
                let (started, ready) = tokio::sync::oneshot::channel();
                let (release, resume) = std::sync::mpsc::channel();
                let blocker = tokio::task::spawn_blocking(move || {
                    let _ = started.send(());
                    let _ = resume.recv_timeout(Duration::from_secs(5));
                });
                ready.await.unwrap();
                let polled = futures_util::poll!(writing.as_mut());
                if polled.is_pending() && step == abort_at {
                    drop(writing);
                    release.send(()).unwrap();
                    blocker.await.unwrap();
                    // FIFO on the sole worker drains the detached file operation.
                    tokio::task::spawn_blocking(|| {}).await.unwrap();
                    return false;
                }
                release.send(()).unwrap();
                blocker.await.unwrap();
                tokio::task::spawn_blocking(|| {}).await.unwrap();
                if let std::task::Poll::Ready(result) = polled {
                    result.unwrap();
                    return true;
                }
            }
            unreachable!()
        });
        let entries: Vec<_> = std::fs::read_dir(&root)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(
            entries,
            vec![std::ffi::OsString::from("existing.txt")],
            "temporary leaked after cancelling I/O boundary {abort_at}"
        );
        assert_eq!(
            std::fs::read(&target).unwrap(),
            if completed {
                b"new content".as_slice()
            } else {
                b"previous content".as_slice()
            }
        );
        if completed {
            return;
        }
    }
    panic!("the bounded file write never completed");
}

fn fixture() -> (tempfile::TempDir, Arc<DesktopToolsService>, Router) {
    fixture_with_trust(false)
}
fn fixture_with_trust(trusted: bool) -> (tempfile::TempDir, Arc<DesktopToolsService>, Router) {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("AI workspace with spaces");
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
    service.trusted = trusted;
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
    assert_eq!(listed["ok"], true, "{listed}");
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

struct TreeCleanup(PathBuf);
impl Drop for TreeCleanup {
    fn drop(&mut self) {
        let pids = std::fs::read(&self.0)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Vec<u64>>(&bytes).ok())
            .unwrap_or_default();
        for pid in pids {
            if crate::processes::liveness(pid) != "alive" {
                continue;
            }
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                let _ = std::process::Command::new("taskkill.exe")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .creation_flags(0x08000000)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status();
            }
            #[cfg(unix)]
            unsafe {
                libc::kill(pid as i32, libc::SIGKILL);
            }
        }
    }
}
fn tree_fixture(root: &Path) -> TreeCleanup {
    std::fs::write(root.join("tree.cjs"), r#"
const fs = require('node:fs');
const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
child.once('spawn', () => { fs.writeFileSync('ready.tmp', JSON.stringify([process.pid, child.pid])); fs.renameSync('ready.tmp', 'ready.json'); });
setInterval(() => {}, 1000);
"#).unwrap();
    TreeCleanup(root.join("ready.json"))
}
async fn tree_pids(root: &Path) -> Vec<u64> {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            if let Ok(bytes) = std::fs::read(root.join("ready.json"))
                && let Ok(pids) = serde_json::from_slice::<Vec<u64>>(&bytes)
                && pids.len() == 2
                && pids
                    .iter()
                    .all(|pid| crate::processes::liveness(*pid) == "alive")
            {
                return pids;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("isolated parent and child must both start")
}
async fn tree_stopped(pids: &[u64]) -> bool {
    tokio::time::timeout(Duration::from_secs(8), async {
        while pids
            .iter()
            .any(|pid| crate::processes::liveness(*pid) != "dead")
        {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .is_ok()
}

#[tokio::test]
async fn trusted_npm_cancellation_reaps_its_tree_without_cancelling_other_commands() {
    let (_directory, service, _) = fixture_with_trust(true);
    let _cleanup = tree_fixture(&service.root);
    std::fs::write(
        service.root.join("package.json"),
        r#"{"scripts":{"wait":"node tree.cjs"}}"#,
    )
    .unwrap();
    let cancel = CancellationToken::new();
    let args = json!({"command":"npm","args":["run","wait"]});
    let running = commands::run(&service.root, &args, true, &service.processes, &cancel);
    tokio::pin!(running);
    let pids = tokio::select! {
        pids = tree_pids(&service.root) => pids,
        result = &mut running => panic!("npm exited before starting its tree: {result:?}"),
    };
    let other_cancel = CancellationToken::new();
    let other_args =
        json!({"command":"node","args":["-e","setTimeout(() => console.log('independent'), 300)"]});
    let other = commands::run(
        &service.root,
        &other_args,
        true,
        &service.processes,
        &other_cancel,
    );
    cancel.cancel();
    let (cancelled, other) = tokio::join!(running, other);
    assert_eq!(cancelled.unwrap_err().code.as_deref(), Some("ABORT_ERR"));
    assert_eq!(other.unwrap(), json!({"ok":true,"output":"independent"}));
    let stopped = tree_stopped(&pids).await;
    service.close().await;
    assert!(
        stopped,
        "cancellation must reap the npm wrapper's parent and child"
    );
}

#[tokio::test]
async fn trusted_commands_enforce_cancellation_timeout_combined_output_limit_and_exit_status() {
    let (_directory, service, _) = fixture_with_trust(true);
    let _cleanup = tree_fixture(&service.root);
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    let error = commands::execute(
        &service.processes,
        Path::new("must-not-spawn"),
        &[],
        Some(&service.root),
        Duration::from_secs(1),
        1024,
        &cancelled,
    )
    .await
    .unwrap_err();
    assert_eq!(error.code.as_deref(), Some("ABORT_ERR"));

    let cancel = CancellationToken::new();
    let args = vec!["tree.cjs".to_owned()];
    let running = commands::execute(
        &service.processes,
        Path::new("node"),
        &args,
        Some(&service.root),
        Duration::from_secs(2),
        64 * 1024,
        &cancel,
    );
    tokio::pin!(running);
    let pids = tokio::select! {
        pids = tree_pids(&service.root) => pids,
        result = &mut running => panic!("command exited before its timeout fixture started: {result:?}"),
    };
    assert_eq!(
        running.await.unwrap_err().code.as_deref(),
        Some("COMMAND_TIMEOUT")
    );
    let stopped = tree_stopped(&pids).await;
    let overflow = commands::run(&service.root,
        &json!({"command":"node","args":["-e","process.stdout.write('x'.repeat(40000));process.stderr.write('y'.repeat(40000))"]}),
        true, &service.processes, &cancel).await.unwrap_err();
    assert_eq!(overflow.code.as_deref(), Some("COMMAND_OUTPUT_LIMIT"));
    let failed = commands::run(&service.root,
        &json!({"command":"node","args":["-e","console.log(process.argv[1]);process.exit(2)","argument with spaces"]}),
        true, &service.processes, &cancel).await.unwrap_err();
    assert_eq!(failed.code.as_deref(), Some("COMMAND_FAILED"));
    assert!(failed.message.contains("argument with spaces"));
    service.close().await;
    assert!(stopped, "timeout must reap both the parent and its child");
}

#[tokio::test]
async fn trusted_command_http_disconnect_reclaims_the_process_tree() {
    use tokio::io::AsyncWriteExt;
    let (_directory, service, app) = fixture_with_trust(true);
    let _cleanup = tree_fixture(&service.root);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    let payload =
        json!({"name":"run_command","args":{"command":"node","args":["tree.cjs"]}}).to_string();
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    socket.write_all(format!("POST /api/desktop-tools HTTP/1.1\r\nHost: {address}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{payload}", payload.len()).as_bytes()).await.unwrap();
    let pids = tree_pids(&service.root).await;
    drop(socket);
    let stopped = tree_stopped(&pids).await;
    service.close().await;
    server.abort();
    assert!(
        stopped,
        "closing the actual HTTP connection must reclaim its command tree before service shutdown"
    );
}
