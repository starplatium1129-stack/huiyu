use axum::{
    Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::future::BoxFuture;
use huiyu_runtime::{
    error::{ApiError, Result},
    execution::{ExecutionHooks, Output},
    generation::{Config, Service},
    upstream::LocalUpstream,
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Semaphore, mpsc};
use tokio_util::sync::CancellationToken;

fn png() -> Vec<u8> {
    STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap()
}
fn input(seed: u64) -> Value {
    json!({"prompt":"test prompt","negative":"test negative","width":1024,"height":1024,"seed":seed})
}
struct MockState {
    web: AtomicBool,
    comfy: bool,
    calls: Mutex<Vec<String>>,
    txt_count: AtomicUsize,
    prompt_count: AtomicUsize,
    gate: Semaphore,
    interrupt_gate: Semaphore,
    started: mpsc::UnboundedSender<String>,
    cancelled: AtomicBool,
    queue_reads: AtomicUsize,
    payloads: Mutex<Vec<Value>>,
    auth: Mutex<Vec<String>>,
    history_fails: AtomicBool,
}
struct Server {
    url: String,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Server {
    fn drop(&mut self) {
        self.task.abort();
    }
}
async fn server(state: Arc<MockState>) -> Server {
    let router = Router::new()
        .route("/sdapi/v1/options", get(options))
        .route(
            "/sdapi/v1/sd-models",
            get(|| async { Json(json!([{"title":"waiIllustriousSDXL_v170.safetensors"}])) }),
        )
        .route(
            "/sdapi/v1/samplers",
            get(|| async { Json(json!([{"name":"DPM++ 2M"}])) }),
        )
        .route("/sdapi/v1/schedulers", get(|| async { Json(json!([])) }))
        .route(
            "/sdapi/v1/upscalers",
            get(|| async { Json(json!([{"name":"Latent"}])) }),
        )
        .route("/sdapi/v1/txt2img", post(txt2img))
        .route("/sdapi/v1/interrupt", post(interrupt))
        .route("/system_stats", get(system_stats))
        .route("/free", post(free))
        .route("/prompt", post(prompt))
        .route("/history/{id}", get(history))
        .route(
            "/view",
            get(|| async { ([(axum::http::header::CONTENT_TYPE, "image/png")], png()) }),
        )
        .route("/api/jobs/{id}/cancel", post(cancel))
        .route("/queue", get(queue))
        .route("/interrupt", post(global_interrupt))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    Server {
        url: format!("http://{address}"),
        task,
    }
}
async fn options(State(state): State<Arc<MockState>>) -> Response {
    if state.web.load(Ordering::Relaxed) {
        Json(json!({"sd_model_checkpoint":"waiIllustriousSDXL_v170 [abc]"})).into_response()
    } else {
        StatusCode::SERVICE_UNAVAILABLE.into_response()
    }
}
async fn system_stats(State(state): State<Arc<MockState>>) -> Response {
    if state.comfy {
        Json(json!({})).into_response()
    } else {
        StatusCode::SERVICE_UNAVAILABLE.into_response()
    }
}
async fn txt2img(
    State(state): State<Arc<MockState>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Json<Value> {
    let count = state.txt_count.fetch_add(1, Ordering::Relaxed) + 1;
    state.payloads.lock().unwrap().push(body);
    state.auth.lock().unwrap().push(
        headers
            .get("authorization")
            .unwrap()
            .to_str()
            .unwrap()
            .into(),
    );
    state.calls.lock().unwrap().push(format!("start:{count}"));
    state.started.send(format!("start:{count}")).unwrap();
    if count == 1 {
        state.gate.acquire().await.unwrap().forget();
    }
    state.calls.lock().unwrap().push(format!("finish:{count}"));
    Json(json!({"images":[STANDARD.encode(png())],"info":"{\"seed\":123}"}))
}
async fn interrupt(State(state): State<Arc<MockState>>) -> Json<Value> {
    state.calls.lock().unwrap().push("interrupt:start".into());
    state.started.send("interrupt:start".into()).unwrap();
    state.interrupt_gate.acquire().await.unwrap().forget();
    state.calls.lock().unwrap().push("interrupt:done".into());
    Json(json!({}))
}
async fn free(State(state): State<Arc<MockState>>) -> Json<Value> {
    state.calls.lock().unwrap().push("free".into());
    Json(json!({}))
}
async fn prompt(State(state): State<Arc<MockState>>, Json(body): Json<Value>) -> Json<Value> {
    let index = state.prompt_count.fetch_add(1, Ordering::Relaxed) + 1;
    state.payloads.lock().unwrap().push(body);
    state.calls.lock().unwrap().push(format!("prompt:{index}"));
    Json(json!({"prompt_id":format!("p{index}")}))
}
async fn history(State(state): State<Arc<MockState>>, Path(id): Path<String>) -> Response {
    if state.history_fails.load(Ordering::Relaxed) {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    if id == "p1" {
        Json(
            json!({id:{"status":{"status_str":"success"},"outputs":{"10":{"images":[{"filename":"wai_app_0001_.png","subfolder":"","type":"output"}]}}}}),
        ).into_response()
    } else {
        let _ = state;
        Json(json!({})).into_response()
    }
}
async fn cancel(State(state): State<Arc<MockState>>, Path(id): Path<String>) -> Json<Value> {
    assert_eq!(id, "p2");
    state.cancelled.store(true, Ordering::Relaxed);
    state.calls.lock().unwrap().push("targeted:p2".into());
    Json(json!({}))
}
async fn queue(State(state): State<Arc<MockState>>) -> Json<Value> {
    state.queue_reads.fetch_add(1, Ordering::Relaxed);
    Json(if state.cancelled.load(Ordering::Relaxed) {
        json!({"queue_running":[],"queue_pending":[]})
    } else {
        json!({"queue_running":[[1,"p2"]],"queue_pending":[]})
    })
}
async fn global_interrupt(State(state): State<Arc<MockState>>) -> StatusCode {
    state
        .calls
        .lock()
        .unwrap()
        .push("unsafe-global-interrupt".into());
    StatusCode::INTERNAL_SERVER_ERROR
}
fn mock(web: bool, comfy: bool) -> (Arc<MockState>, mpsc::UnboundedReceiver<String>) {
    let (tx, rx) = mpsc::unbounded_channel();
    (
        Arc::new(MockState {
            web: AtomicBool::new(web),
            comfy,
            calls: Mutex::new(Vec::new()),
            txt_count: AtomicUsize::new(0),
            prompt_count: AtomicUsize::new(0),
            gate: Semaphore::new(0),
            interrupt_gate: Semaphore::new(0),
            started: tx,
            cancelled: AtomicBool::new(false),
            queue_reads: AtomicUsize::new(0),
            payloads: Mutex::new(Vec::new()),
            auth: Mutex::new(Vec::new()),
            history_fails: AtomicBool::new(false),
        }),
        rx,
    )
}
fn service(server: &Server, temp: &tempfile::TempDir) -> Arc<Service> {
    Arc::new(
        Service::new(
            Config {
                sd_host: server.url.clone(),
                sd_auth: Some("user:password".into()),
                comfy_host: server.url.clone(),
                ai_workspace_root: temp.path().join("ai"),
                runtime_root: temp.path().join("runtime"),
            },
            LocalUpstream::new(),
            CancellationToken::new(),
        )
        .unwrap(),
    )
}
async fn settled(service: &Service, id: &str, status: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let value = service.query(id, "owner").await.unwrap();
            if value.status == status && value.settled {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn webui_serializes_global_interrupt_and_rejects_stale_provider_before_admission() {
    let temp = tempfile::tempdir().unwrap();
    let (state, mut started) = mock(true, false);
    let server = server(state.clone()).await;
    let service = service(&server, &temp);
    let first = service
        .prepare(input(1), true, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(first.provider, "webui");
    let first = service
        .clone()
        .submit(first, "owner".into(), None)
        .await
        .unwrap();
    assert_eq!(started.recv().await.unwrap(), "start:1");
    let second = service
        .prepare(input(2), true, CancellationToken::new())
        .await
        .unwrap();
    let collecting = Arc::new(Hooks(
        Arc::new(Mutex::new(Vec::new())),
        AtomicBool::new(true),
    ));
    let second = service
        .clone()
        .submit(second, "owner".into(), Some(collecting.clone()))
        .await
        .unwrap();
    let first_id = first["id"].as_str().unwrap().to_string();
    let second_id = second["id"].as_str().unwrap().to_string();
    let caller = service.clone();
    let target = first_id.clone();
    let cancelling = tokio::spawn(async move { caller.cancel(&target, "owner").await });
    assert_eq!(started.recv().await.unwrap(), "interrupt:start");
    state.gate.add_permits(1);
    assert!(
        tokio::time::timeout(Duration::from_millis(100), started.recv())
            .await
            .is_err()
    );
    state.interrupt_gate.add_permits(1);
    cancelling.await.unwrap().unwrap();
    assert_eq!(started.recv().await.unwrap(), "start:2");
    settled(&service, &first_id, "cancelled").await;
    pending_collection(&service, &second_id).await;
    assert!(matches!(
        service.result(&second_id, "owner").await.unwrap(),
        Output::Bytes { .. }
    ));
    collecting.1.store(false, Ordering::Relaxed);
    settled(&service, &second_id, "succeeded").await;
    let calls = state.calls.lock().unwrap().clone();
    assert!(
        calls.iter().position(|s| s == "start:2")
            > calls.iter().position(|s| s == "interrupt:done")
    );
    assert_eq!(state.payloads.lock().unwrap()[1]["prompt"], "test prompt");
    assert_eq!(
        state.auth.lock().unwrap()[0],
        format!("Basic {}", STANDARD.encode("user:password"))
    );
    assert!(matches!(
        service.result(&second_id, "owner").await.unwrap(),
        Output::Bytes { .. }
    ));
    assert_eq!(
        service
            .result(&second_id, "other-owner")
            .await
            .unwrap_err()
            .status,
        StatusCode::NOT_FOUND
    );
    service.get_status().await.unwrap();
    state.web.store(false, Ordering::Relaxed);
    assert!(
        service
            .prepare(input(3), true, CancellationToken::new())
            .await
            .is_err()
    );
    assert_eq!(state.txt_count.load(Ordering::Relaxed), 2);
    service.close().await;
}

async fn pending_collection(service: &Service, id: &str) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if service.get_job(id, "owner").await.unwrap()["code"] == "RESULT_COLLECTION_PENDING" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    let observed = service.query(id, "owner").await.unwrap();
    assert_eq!(observed.status, "running");
    assert!(!observed.settled);
    assert!(!observed.unknown);
    assert_eq!(observed.outputs.len(), 1);
}
struct Hooks(Arc<Mutex<Vec<String>>>, AtomicBool);
impl ExecutionHooks for Hooks {
    fn checkpoint(&self, value: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            assert!(value["gatewayJobId"].is_string());
            self.0.lock().unwrap().push("checkpoint".into());
            Ok(())
        })
    }
    fn submitting(&self, provider: String, _: String) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            assert!(["comfy", "webui"].contains(&provider.as_str()));
            self.0.lock().unwrap().push("submitting".into());
            Ok(())
        })
    }
    fn observed(&self, id: String, _: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            assert_eq!(id, "p1");
            self.0.lock().unwrap().push("observed".into());
            Ok(())
        })
    }
    fn collect(&self, outputs: Vec<Output>) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            assert!(!outputs[0].is_empty());
            if self.1.load(Ordering::Relaxed) {
                self.0.lock().unwrap().push("collect:failed".into());
                return Err(ApiError::new(
                    503,
                    "FIXTURE_STORAGE_BUSY",
                    "Temporary durable collection failure",
                ));
            }
            self.0.lock().unwrap().push("collect".into());
            Ok(())
        })
    }
}
#[tokio::test]
async fn comfy_preserves_workflow_ledger_order_output_ownership_and_targeted_cancel() {
    let temp = tempfile::tempdir().unwrap();
    let checkpoint = temp.path().join("ai/ComfyUI/models/checkpoints");
    tokio::fs::create_dir_all(&checkpoint).await.unwrap();
    tokio::fs::write(
        checkpoint.join("waiIllustriousSDXL_v170.safetensors"),
        b"fixture",
    )
    .await
    .unwrap();
    let (state, _) = mock(false, true);
    let server = server(state.clone()).await;
    let service = service(&server, &temp);
    let prepared = service
        .prepare(input(42), true, CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(prepared.provider, "comfy");
    let hooks = Arc::new(Hooks(
        Arc::new(Mutex::new(Vec::new())),
        AtomicBool::new(true),
    ));
    let first = service
        .clone()
        .submit(prepared, "owner".into(), Some(hooks.clone()))
        .await
        .unwrap();
    let id = first["id"].as_str().unwrap();
    pending_collection(&service, id).await;
    hooks.1.store(false, Ordering::Relaxed);
    settled(&service, id, "succeeded").await;
    assert!(hooks.0.lock().unwrap().starts_with(&[
        "checkpoint".into(),
        "submitting".into(),
        "observed".into(),
        "collect:failed".into()
    ]));
    assert_eq!(hooks.0.lock().unwrap().last().unwrap(), "collect");
    assert_eq!(
        state.prompt_count.load(Ordering::Relaxed),
        1,
        "Collection retries never submit another generation"
    );
    let Output::File { path, .. } = service.result(id, "owner").await.unwrap() else {
        panic!("Comfy original must be stored as a file")
    };
    assert!(path.starts_with(temp.path().join("runtime/outputs/wai")));
    assert_eq!(tokio::fs::read(path).await.unwrap(), png());
    let payloads = state.payloads.lock().unwrap().clone();
    assert_eq!(payloads[0]["prompt"]["7"]["inputs"]["seed"], 42);
    assert_eq!(payloads[0]["prompt"]["4"]["inputs"]["text"], "test prompt");
    let prepared = service
        .prepare(input(43), true, CancellationToken::new())
        .await
        .unwrap();
    let second = service
        .clone()
        .submit(prepared, "owner".into(), None)
        .await
        .unwrap();
    let second_id = second["id"].as_str().unwrap();
    state.history_fails.store(true, Ordering::Relaxed);
    tokio::time::pause();
    tokio::time::timeout(Duration::from_secs(400), async {
        loop {
            let observation = service.query(second_id, "owner").await.unwrap();
            if observation.status == "failed" && observation.unknown {
                assert!(!observation.settled);
                break;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    })
    .await
    .unwrap();
    tokio::time::resume();
    state.history_fails.store(false, Ordering::Relaxed);
    service.cancel(second_id, "owner").await.unwrap();
    settled(&service, second_id, "cancelled").await;
    assert!(state.queue_reads.load(Ordering::Relaxed) >= 2);
    assert!(
        state
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|s| s == "targeted:p2")
    );
    assert!(
        !state
            .calls
            .lock()
            .unwrap()
            .iter()
            .any(|s| s == "unsafe-global-interrupt")
    );
    service.close().await;
}
