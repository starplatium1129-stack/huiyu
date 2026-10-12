//! Desktop's session-authenticated durable route, using the same CPU-only process.
use super::*;
use crate::{
    host::{HostAuthority, Session},
    storage::Storage,
    task_runtime::TaskRuntime,
};

const ORIGIN: &str = "http://127.0.0.1:3210";

async fn app(
    control: Arc<ControlService>,
    storage: &Storage,
) -> (Router, Arc<TaskRuntime>, Session, Session) {
    let shutdown = CancellationToken::new();
    let config = crate::generation::Config {
        sd_host: control.config.sd_host.clone(),
        sd_auth: None,
        comfy_host: control.config.comfy_host.clone(),
        ai_workspace_root: control.config.ai_workspace_root.clone(),
        runtime_root: control.config.runtime_root.clone(),
    };
    let provider = Arc::new(
        crate::generation::Service::new(config.clone(), LocalUpstream::new(), shutdown.clone())
            .unwrap(),
    );
    let images = Arc::new(
        crate::images::Service::new(config, LocalUpstream::new(), shutdown.clone()).unwrap(),
    );
    let tasks = Arc::new(
        TaskRuntime::new(
            provider.clone(),
            Some(images.clone()),
            None,
            shutdown.clone(),
        )
        .unwrap(),
    );
    let host = Arc::new(HostAuthority::new(Some(storage.clone()), None, None));
    let session = |principal| {
        host.issue(
            storage.workspace_id(),
            storage.runtime_epoch(),
            principal,
            ORIGIN,
            false,
        )
        .unwrap()
    };
    let alice = session("alice");
    let bob = session("bob");
    let mut state = crate::AppState::new(control.config.clone(), host, shutdown);
    state.control = Some(control);
    state.generation = Some(provider);
    state.images = Some(images);
    state.tasks = Some(tasks.clone());
    (crate::router(state), tasks, alice, bob)
}

async fn call(
    app: &Router,
    session: &Session,
    method: &str,
    path: &str,
    body: Value,
) -> axum::response::Response {
    let mut req = Request::builder()
        .method(method)
        .uri(path)
        .header("host", "127.0.0.1:3210")
        .header("origin", ORIGIN)
        .header("content-type", "application/json")
        .header("x-aics-workspace-session", &session.token)
        .body(Body::from(body.to_string()))
        .unwrap();
    req.extensions_mut().insert(ConnectInfo(
        "127.0.0.1:49301".parse::<std::net::SocketAddr>().unwrap(),
    ));
    app.clone().oneshot(req).await.unwrap()
}
async fn json(response: axum::response::Response) -> Value {
    assert_eq!(response.status().as_u16(), 200);
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}
async fn finished(app: &Router, session: &Session, id: &str) -> Value {
    tokio::time::timeout(Duration::from_secs(8), async {
        loop {
            let value = json(
                call(
                    app,
                    session,
                    "GET",
                    &format!("/api/tasks/v1/{id}"),
                    Value::Null,
                )
                .await,
            )
            .await;
            assert_ne!(value["result"]["status"], "failed", "{value}");
            if value["result"]["status"] == "succeeded"
                && value["result"]["upstreamSettled"] == true
            {
                return value["result"].clone();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap()
}
async fn output(app: &Router, session: &Session, id: &str, expected: &[u8]) {
    let response = call(
        app,
        session,
        "GET",
        &format!("/api/tasks/v1/{id}/results/0"),
        Value::Null,
    )
    .await;
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(response.headers()["content-type"], "image/png");
    assert_eq!(
        response
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .as_ref(),
        expected
    );
}

#[tokio::test]
async fn durable_http_auth_dedup_and_reopen_preserve_results_without_unrequested_wakeup() {
    let (temp, control) = fixture(0.0).await;
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&[80, 90, 100], 1, 1, image::ExtendedColorType::Rgb8)
        .unwrap();
    upstream(&control, &png);
    // The companion legacy-route test owns the intentional error/retry branch.
    std::fs::write(control.comfy_root().join("fixture-rejected-once"), b"").unwrap();
    for (kind, name) in [
        ("diffusion_models", "miaomiaoHarem_anima16.safetensors"),
        ("text_encoders", "qwen_3_06b_base.safetensors"),
        ("vae", "qwen_image_vae.safetensors"),
        ("loras", "ayachi_nene_v21_anima.safetensors"),
    ] {
        let directory = control
            .config
            .ai_workspace_root
            .join("ComfyUI/models")
            .join(kind);
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(directory.join(name), b"CPU fixture, not a real model").unwrap();
    }
    let workspace = temp.path().join("durable-workspace");
    let storage = Storage::open(workspace.clone(), "managed-durable-fixture".into(), true)
        .await
        .unwrap();
    let (router, tasks, alice, bob) = app(control.clone(), &storage).await;
    let body = json!({"requestKey":"managed-first-durable","kind":"anima","input":{
        "modelId":"anima-miaomiao-v1.6","prompt":"CPU durable contract scene","width":1024,"height":1024,
        "character":"nene","loraId":"L_NENE_V21_ANIMA","loraStrength":0.8,"hiresFix":true,"hiresUpscaler":"Auto","seed":42}});
    let (status, _) = request(&router, "POST", "/api/tasks/v1", body.clone()).await;
    assert_eq!(status, 401);
    assert!(!control.comfy_root().join("fixture-starts.log").exists());
    let (first, second) = tokio::join!(
        call(&router, &alice, "POST", "/api/tasks/v1", body.clone()),
        call(&router, &alice, "POST", "/api/tasks/v1", body.clone())
    );
    let first = json(first).await;
    let second = json(second).await;
    let id = first["result"]["taskId"].as_str().unwrap();
    assert_eq!(second["result"]["taskId"], id);
    let result = finished(&router, &alice, id).await;
    assert_eq!(
        std::fs::read_to_string(control.comfy_root().join("fixture-prompts.log"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    assert_eq!(result["resultState"], "available");
    output(&router, &alice, id, &png).await;
    assert_eq!(
        call(
            &router,
            &bob,
            "GET",
            &format!("/api/tasks/v1/{id}/results/0"),
            Value::Null
        )
        .await
        .status()
        .as_u16(),
        404
    );
    tasks.close().await;
    control.close().await;
    storage.close().await.unwrap();
    let storage = Storage::open(workspace, "managed-durable-fixture".into(), false)
        .await
        .unwrap();
    let shutdown = CancellationToken::new();
    let reopened = ControlService::new(
        control.config.clone(),
        Arc::new(RemoteAccess::new(&control.config, shutdown.clone())),
        shutdown.clone(),
        Arc::new(crate::voice::VoiceService::new(&control.config, shutdown)),
    );
    let (router, tasks, alice, _) = app(reopened.clone(), &storage).await;
    output(&router, &alice, id, &png).await;
    assert!(reopened.comfy_process.lock().await.is_none());
    let duplicate = json(call(&router, &alice, "POST", "/api/tasks/v1", body.clone()).await).await;
    assert_eq!(duplicate["result"]["taskId"], id);
    assert!(reopened.comfy_process.lock().await.is_none());
    let mut next = body;
    next["requestKey"] = json!("managed-after-reopen");
    let accepted = json(call(&router, &alice, "POST", "/api/tasks/v1", next).await).await;
    let next_id = accepted["result"]["taskId"].as_str().unwrap();
    finished(&router, &alice, next_id).await;
    output(&router, &alice, next_id, &png).await;
    assert_eq!(
        std::fs::read_to_string(control.comfy_root().join("fixture-starts.log"))
            .unwrap()
            .lines()
            .count(),
        2
    );
    assert_eq!(
        std::fs::read_to_string(control.comfy_root().join("fixture-prompts.log"))
            .unwrap()
            .lines()
            .count(),
        2
    );
    tasks.close().await;
    reopened.close().await;
    storage.close().await.unwrap();
}
