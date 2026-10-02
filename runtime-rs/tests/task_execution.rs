use axum::{
    Json, Router,
    extract::State,
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use huiyu_runtime::{
    generation::{Config, GenerationService},
    storage::Storage,
    task_contract::{ResultState, TaskStatus},
    task_runtime::TaskRuntime,
    upstream::LocalUpstream,
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Notify, Semaphore};
use tokio_util::sync::CancellationToken;

struct Mock {
    calls: AtomicUsize,
    gate: Semaphore,
    started: Notify,
}
async fn render(State(state): State<Arc<Mock>>) -> Json<Value> {
    state.calls.fetch_add(1, Ordering::Relaxed);
    state.started.notify_one();
    state.gate.acquire().await.unwrap().forget();
    Json(
        json!({"images":["iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="],"info":"{\"seed\":42}"}),
    )
}

#[tokio::test]
async fn accepted_jobs_outlive_callers_keep_identity_and_deliver_verified_results() {
    let directory = tempfile::tempdir().unwrap();
    let state = Arc::new(Mock {
        calls: AtomicUsize::new(0),
        gate: Semaphore::new(0),
        started: Notify::new(),
    });
    let app = Router::new()
        .route(
            "/sdapi/v1/options",
            get(|| async { Json(json!({"sd_model_checkpoint":"waiIllustriousSDXL_v170 [abc]"})) }),
        )
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
        .route("/sdapi/v1/txt2img", post(render))
        .with_state(state.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let shutdown = CancellationToken::new();
    let config = Config {
        sd_host: host.clone(),
        sd_auth: None,
        comfy_host: host,
        ai_workspace_root: directory.path().join("AI"),
        runtime_root: directory.path().join("runtime"),
    };
    std::fs::create_dir_all(config.ai_workspace_root.join("ComfyUI")).unwrap();
    let provider = Arc::new(
        GenerationService::new(config.clone(), LocalUpstream::new(), shutdown.clone()).unwrap(),
    );
    let runtime = Arc::new(TaskRuntime::new(provider, None, None, shutdown.clone()).unwrap());
    let storage = Storage::open(
        directory.path().join("workspace"),
        "execution-fixture".into(),
        true,
    )
    .await
    .unwrap();
    let request = json!({"requestKey":"stable-user-request","kind":"generation","input":{"prompt":"neutral test portrait","negative":"","width":1024,"height":1024,"seed":42}});
    let (accepted, concurrent) = tokio::join!(
        runtime.submit(storage.clone(), "alice".into(), request.clone()),
        runtime.submit(storage.clone(), "alice".into(), request.clone()),
    );
    let accepted = accepted.unwrap();
    assert_eq!(concurrent.unwrap()["taskId"], accepted["taskId"]);
    let id = accepted["taskId"].as_str().unwrap();
    tokio::time::timeout(Duration::from_secs(5), state.started.notified())
        .await
        .unwrap();
    // No client subscription is kept alive here. Duplicate submission returns
    // the accepted identity rather than starting a second GPU request.
    let duplicate = runtime
        .submit(storage.clone(), "alice".into(), request.clone())
        .await
        .unwrap();
    assert_eq!(duplicate["taskId"], accepted["taskId"]);
    let mut conflict = request;
    conflict["input"]["prompt"] = json!("different");
    assert_eq!(
        runtime
            .submit(storage.clone(), "alice".into(), conflict)
            .await
            .unwrap_err()
            .code,
        "TASK_KEY_CONFLICT"
    );
    assert_eq!(state.calls.load(Ordering::Relaxed), 1);
    state.gate.add_permits(1);
    let completed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let task = TaskRuntime::get(&storage, "alice", id).await.unwrap();
            if task.upstream_settled {
                break task;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(completed.status, TaskStatus::Succeeded);
    assert_eq!(completed.result_state, ResultState::Available);
    let media = storage
        .media(&completed.result_refs[0].alias)
        .await
        .unwrap();
    assert_eq!(std::fs::read(media.path).unwrap(),STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap());
    let saved = TaskRuntime::delivery(&storage, "alice", id, "saved")
        .await
        .unwrap();
    assert_eq!(saved["deliveryState"], "saved");
    runtime.close().await;
    storage.close().await.unwrap();
    let reopened = Storage::open(
        directory.path().join("workspace"),
        "execution-fixture".into(),
        false,
    )
    .await
    .unwrap();
    assert_eq!(
        TaskRuntime::get(&reopened, "alice", id)
            .await
            .unwrap()
            .result_state,
        ResultState::Available
    );
    assert!(TaskRuntime::get(&reopened, "bob", id).await.is_err());
    let mut queued = completed.clone();
    queued.task_id = "queued-before-restart".into();
    queued.request_key = "queued-before-restart".into();
    queued.request_fingerprint = "queued-before-restart".into();
    queued.status = TaskStatus::Queued;
    queued.upstream_settled = false;
    queued.submission_intent_at = None;
    queued.submission_observed_at = None;
    queued.result_state = ResultState::None;
    queued.result_refs.clear();
    queued.metadata.clear();
    queued.checkpoint = None;
    reopened
        .request(json!({"kind":"task.accept","record":queued}), "alice")
        .await
        .unwrap();
    let restarted = CancellationToken::new();
    let provider =
        Arc::new(GenerationService::new(config, LocalUpstream::new(), restarted.clone()).unwrap());
    let runtime = Arc::new(TaskRuntime::new(provider, None, None, restarted).unwrap());
    let (resume, concurrent) = tokio::join!(
        runtime.resume(
            reopened.clone(),
            "alice".into(),
            "queued-before-restart".into()
        ),
        runtime.resume(
            reopened.clone(),
            "alice".into(),
            "queued-before-restart".into()
        )
    );
    let resume = resume.unwrap();
    assert_eq!(resume["taskId"], concurrent.unwrap()["taskId"]);
    assert_eq!(resume["taskId"], "queued-before-restart");
    assert_eq!(resume["input"]["seed"], 42);
    tokio::time::timeout(Duration::from_secs(5), state.started.notified())
        .await
        .unwrap();
    assert_eq!(state.calls.load(Ordering::Relaxed), 2);
    assert_eq!(
        runtime
            .resume(
                reopened.clone(),
                "alice".into(),
                "queued-before-restart".into()
            )
            .await
            .unwrap_err()
            .code,
        "TASK_RESUME_UNSAFE"
    );
    state.gate.add_permits(1);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let task = TaskRuntime::get(&reopened, "alice", "queued-before-restart")
                .await
                .unwrap();
            if task.upstream_settled {
                assert_eq!(task.status, TaskStatus::Succeeded);
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    runtime.close().await;
    reopened.close().await.unwrap();
    server.abort();
}
