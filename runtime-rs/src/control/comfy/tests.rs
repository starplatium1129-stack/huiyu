use super::*;

#[tokio::test]
async fn restored_intent_is_bound_to_the_saved_endpoint_and_installation() {
    for binding in [
        json!({"comfy":false}),
        json!({"comfy":true}),
        json!({"comfy":true,"comfyHost":"http://127.0.0.1:1"}),
        json!({"comfy":true,"comfyHost":"http://127.0.0.1:9999"}),
        json!({"comfy":true,"comfyRoot":"/different/installation"}),
    ] {
        let (_temp, service) = crate::control::tests::fixture(json!({
            "comfyHost":"http://127.0.0.1:1", "managedServices":binding,
        }));
        assert!(!service.state.lock().unwrap().managed[1].desired);
        assert_eq!(
            service
                .ensure_comfy(&CancellationToken::new())
                .await
                .unwrap_err()
                .code,
            "COMFY_UNAVAILABLE"
        );
        service.close().await;
    }
}

// This is a CPU-only process/HTTP fixture, not ComfyUI or a GPU inference test.
#[cfg(unix)]
fn install_fixture(service: &ControlService, delay: f64) {
    let root = service.comfy_root();
    let python = root.parent().unwrap().join("python_embeded/python.exe");
    std::fs::create_dir_all(python.parent().unwrap()).unwrap();
    std::fs::create_dir_all(&root).unwrap();
    std::os::unix::fs::symlink("/usr/bin/python3", python).unwrap();
    std::fs::write(
        root.join("main.py"),
        format!(
            r#"
import http.server, json, pathlib, sys, time
args = sys.argv
port = int(args[args.index('--port') + 1])
input_dir = args[args.index('--input-directory') + 1]
pathlib.Path('fixture-starts.log').open('a').write(input_dir + '\n')
time.sleep({delay})
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'{{"system":{{}},"devices":[]}}')
http.server.HTTPServer(('127.0.0.1', port), Handler).serve_forever()
"#
        ),
    )
    .unwrap();
}

#[cfg(unix)]
async fn fixture(delay: f64) -> (tempfile::TempDir, Arc<ControlService>) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let (temp, service) = crate::control::tests::fixture(json!({
        "comfyHost":host,"managedServices":{"comfy":true,"comfyHost":host,"comfyRoot":"$COMFY_ROOT"},"autoTunnel":false,
    }));
    install_fixture(&service, delay);
    (temp, service)
}

#[cfg(unix)]
#[tokio::test]
async fn concurrent_lazy_starts_share_one_owned_process_and_standard_input_directory() {
    let (_temp, service) = fixture(0.2).await;
    assert!(service.comfy_start_available());
    assert!(service.comfy_process.lock().await.is_none());
    let cancel = CancellationToken::new();
    let backend = crate::generation::Service::for_images(
        crate::generation::Config {
            sd_host: service.config.sd_host.clone(),
            sd_auth: None,
            comfy_host: service.config.comfy_host.clone(),
            ai_workspace_root: service.config.ai_workspace_root.clone(),
            runtime_root: service.config.runtime_root.clone(),
        },
        LocalUpstream::new(),
        CancellationToken::new(),
    )
    .unwrap();
    backend.bind_control(&service);
    let plan = |path| crate::generation::ComfyPlan {
        input: json!({}),
        workflow: json!({}),
        metadata: json!({}),
        resources: vec![path],
        family: "anima",
        namespace: "anima",
        route_base: "/api/anima",
        output_prefix: "fixture",
        media_kind: crate::generation::MediaKind::Image,
        output_node: "10",
        timeout: Duration::from_secs(1),
        retention: Duration::from_secs(1),
    };
    assert!(
        backend
            .prepare_comfy(
                plan(service.comfy_root().join("missing-model")),
                cancel.clone()
            )
            .await
            .is_err()
    );
    assert!(!service.comfy_root().join("fixture-starts.log").exists());
    let (first, second) = tokio::join!(
        backend.prepare_comfy(plan(service.comfy_root().join("main.py")), cancel.clone()),
        service.ensure_comfy(&cancel),
    );
    first.unwrap();
    second.unwrap();
    assert!(service.state.lock().unwrap().managed[1].owned);
    let starts = std::fs::read_to_string(service.comfy_root().join("fixture-starts.log")).unwrap();
    assert_eq!(
        starts.lines().collect::<Vec<_>>(),
        vec![
            service
                .config
                .ai_workspace_root
                .join("ComfyUI/input")
                .to_str()
                .unwrap()
        ]
    );
    let saved: Value = serde_json::from_slice(
        &std::fs::read(service.config.runtime_root.join("config.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(
        saved["managedServices"]["comfyHost"],
        service.config.comfy_host
    );
    assert_eq!(saved["autoTunnel"], false);
    service.close().await;
    assert!(!service.online(1, &service.settings()).await);
    let shutdown = CancellationToken::new();
    let reopened = ControlService::new(
        service.config.clone(),
        Arc::new(RemoteAccess::new(&service.config, shutdown.clone())),
        shutdown.clone(),
        Arc::new(crate::voice::VoiceService::new(&service.config, shutdown)),
    );
    assert!(reopened.comfy_start_available());
    assert!(!reopened.state.lock().unwrap().managed[1].owned);
    assert!(reopened.comfy_process.lock().await.is_none());
    let op = reopened.begin("comfy-stop", &["stop", "verify"]).unwrap();
    reopened.service_action(1, false, &op).await.unwrap();
    reopened.finish(&op, Ok(()));
    assert!(!reopened.comfy_start_available());
    let cancelled = CancellationToken::new();
    cancelled.cancel();
    assert_eq!(
        reopened.ensure_comfy(&cancelled).await.unwrap_err().code,
        "ABORT_ERR"
    );
    assert!(reopened.comfy_process.lock().await.is_none());
    reopened.close().await;
}

#[cfg(unix)]
#[tokio::test]
async fn immediate_cancel_and_shutdown_do_not_leave_a_starting_child() {
    let (_temp, service) = fixture(30.0).await;
    let response = service.launch("comfy-start".into()).unwrap();
    service
        .cancel_environment(response["operation"]["id"].as_str())
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if service.state.lock().unwrap().operation.as_ref().unwrap()["status"] != "running" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert!(service.comfy_process.lock().await.is_none());
    assert!(!service.comfy_root().join("fixture-starts.log").exists());
    service.launch("comfy-start".into()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), service.close())
        .await
        .unwrap();
    assert!(service.comfy_process.lock().await.is_none());
}

#[tokio::test]
async fn drawing_waits_for_cancelled_chat_startup_to_finish_its_owned_cleanup() {
    let (_temp, service) = crate::control::tests::fixture(json!({}));
    let operation = service.begin("llama-start", &["loading"]).unwrap();
    let cancel = service.shutdown.child_token();
    *service.llama_cancel.lock().unwrap() = Some(cancel.clone());
    let stopping = tokio::spawn({
        let service = service.clone();
        async move { service.stop_llama().await }
    });
    tokio::time::timeout(Duration::from_secs(1), cancel.cancelled())
        .await
        .unwrap();
    assert!(!stopping.is_finished());
    service.llama_cancel.lock().unwrap().take();
    service.finish(
        &operation,
        Err(ApiError::new(499, "CANCELLED", "fixture stopped")),
    );
    stopping.await.unwrap().unwrap();
    service.close().await;
}

#[cfg(unix)]
mod http;
