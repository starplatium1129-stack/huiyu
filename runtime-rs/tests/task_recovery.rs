use axum::{
    Json, Router,
    extract::{Path, State},
    http::StatusCode,
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use huiyu_runtime::{
    generation::{Config, GenerationService},
    storage::Storage,
    task_runtime::TaskRuntime,
    upstream::LocalUpstream,
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio_util::sync::CancellationToken;

struct Mock {
    ack: AtomicBool,
    posts: AtomicUsize,
    online: AtomicBool,
    finished: AtomicBool,
}
async fn history(
    Path(id): Path<String>,
    State(mock): State<Arc<Mock>>,
) -> (StatusCode, Json<Value>) {
    if !mock.online.load(Ordering::Relaxed) {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({})));
    }
    (
        StatusCode::OK,
        Json(
            if id == "completed-before-restart"
                || id == "recovered-running" && mock.finished.load(Ordering::Relaxed)
            {
                json!({id:{"status":{"status_str":"success"},"outputs":{"10":{"images":[{"filename":"wai_app_00001.png","type":"output","subfolder":""}]}}}})
            } else {
                json!({})
            },
        ),
    )
}
async fn queue(State(mock): State<Arc<Mock>>) -> Json<Value> {
    Json(
        json!({"queue_running":if mock.online.load(Ordering::Relaxed)&&!mock.finished.load(Ordering::Relaxed){json!([[0,"recovered-running"]])}else{json!([])},"queue_pending":[]}),
    )
}
async fn cancel(State(mock): State<Arc<Mock>>) -> StatusCode {
    if mock.ack.load(Ordering::Relaxed) {
        StatusCode::OK
    } else {
        StatusCode::NOT_FOUND
    }
}
fn old_identity(config: &Config) -> String {
    let source = r#"const fs=require('node:fs'),path=require('node:path');
const {taskFingerprint}=require('./server/tasks/runtime.js');
const root=path.join(process.argv[1],'ComfyUI'),stat=fs.statSync(root);
process.stdout.write(taskFingerprint({comfy:process.argv[2],webui:process.argv[2],identity:{root:fs.realpathSync(root),created:stat.birthtimeMs,inode:stat.ino}}));"#;
    let result = std::process::Command::new("node")
        .arg("-e")
        .arg(source)
        .arg(&config.ai_workspace_root)
        .arg(&config.comfy_host)
        .current_dir(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap(),
        )
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap()
}
async fn seed(storage: &Storage, id: &str, fingerprint: &str, upstream: &str, cancelling: bool) {
    let record = json!({"taskId":id,"workspaceId":storage.workspace_id(),"principalId":"alice","requestKey":id,"requestFingerprint":"legacy-key",
        "kind":"generation","provider":"comfy","providerFingerprint":fingerprint,"upstreamId":upstream,"status":"running","recoveryState":"normal",
        "revision":0,"runtimeEpoch":"old-node-epoch","createdAt":1,"updatedAt":1,"submissionIntentAt":2,"submissionObservedAt":3,
        "cancelRequestedAt":if cancelling{json!(4)}else{Value::Null},"upstreamSettled":false,"executionDeadline":9999999999999u64,
        "input":{},"inputMediaRefs":[],"resultState":"none","resultRefs":[],"deliveryState":"unseen","errorCode":null,"metadata":{},"checkpoint":null,"parentBatchId":null,"stepIndex":null});
    storage
        .request(json!({"kind":"task.accept","record":record}), "alice")
        .await
        .unwrap();
}
#[tokio::test]
async fn restart_recovers_node_identity_without_resubmission_and_requires_cancel_ack() {
    let directory = tempfile::tempdir().unwrap();
    let mock = Arc::new(Mock {
        ack: AtomicBool::new(false),
        posts: AtomicUsize::new(0),
        online: AtomicBool::new(true),
        finished: AtomicBool::new(false),
    });
    let app=Router::new().route("/history/{id}",get(history)).route("/queue",get(queue))
        .route("/api/jobs/{id}/cancel",post(cancel))
        .route("/view",get(||async {([("content-type","image/png")],STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap())}))
        .route("/prompt",post(|State(mock):State<Arc<Mock>>|async move {mock.posts.fetch_add(1,Ordering::Relaxed);StatusCode::BAD_REQUEST})).with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let config = Config {
        sd_host: host.clone(),
        sd_auth: None,
        comfy_host: host,
        ai_workspace_root: directory.path().join("AI"),
        runtime_root: directory.path().join("runtime"),
    };
    std::fs::create_dir_all(config.ai_workspace_root.join("ComfyUI")).unwrap();
    let fingerprint = old_identity(&config);
    let store = directory.path().join("workspace");
    let storage = Storage::open(store.clone(), "recovery-fixture".into(), true)
        .await
        .unwrap();
    seed(
        &storage,
        "complete",
        &fingerprint,
        "completed-before-restart",
        false,
    )
    .await;
    storage.close().await.unwrap();
    let storage = Storage::open(store, "recovery-fixture".into(), false)
        .await
        .unwrap();
    let shutdown = CancellationToken::new();
    let provider = Arc::new(
        GenerationService::new(config.clone(), LocalUpstream::new(), shutdown.clone()).unwrap(),
    );
    let runtime = Arc::new(TaskRuntime::new(provider, None, None, shutdown).unwrap());
    runtime.ensure_recovered(&storage, "alice").await.unwrap();
    let recovered = TaskRuntime::get(&storage, "alice", "complete")
        .await
        .unwrap();
    assert_eq!(recovered["status"], "succeeded", "{recovered}");
    assert_eq!(recovered["resultState"], "available");
    assert!(
        storage
            .media(recovered["resultRefs"][0]["alias"].as_str().unwrap())
            .await
            .is_ok()
    );
    seed(&storage, "cancel", &fingerprint, "missing-history", true).await;
    for _ in 0..2 {
        let unresolved = runtime
            .reconcile(&storage, "alice", "cancel")
            .await
            .unwrap();
        assert_eq!(unresolved["upstreamSettled"], false);
        assert_eq!(unresolved["errorCode"], "COMFY_HISTORY_MISSING");
    }
    mock.ack.store(true, Ordering::Relaxed);
    assert_eq!(
        runtime
            .reconcile(&storage, "alice", "cancel")
            .await
            .unwrap()["upstreamSettled"],
        false
    );
    assert_eq!(
        runtime
            .reconcile(&storage, "alice", "cancel")
            .await
            .unwrap()["status"],
        "cancelled"
    );
    assert_eq!(mock.posts.load(Ordering::Relaxed), 0);
    runtime.close().await;
    seed(&storage, "watch", &fingerprint, "recovered-running", false).await;
    mock.online.store(false, Ordering::Relaxed);
    let shutdown = CancellationToken::new();
    let provider =
        Arc::new(GenerationService::new(config, LocalUpstream::new(), shutdown.clone()).unwrap());
    let runtime = Arc::new(TaskRuntime::new(provider, None, None, shutdown).unwrap());
    runtime.ensure_recovered(&storage, "alice").await.unwrap();
    assert_eq!(
        TaskRuntime::get(&storage, "alice", "watch").await.unwrap()["recoveryState"],
        "unknown"
    );
    mock.online.store(true, Ordering::Relaxed);
    assert_eq!(
        runtime.reconcile(&storage, "alice", "watch").await.unwrap()["status"],
        "running"
    );
    assert!(runtime.owns(&storage, "watch"));
    mock.finished.store(true, Ordering::Relaxed);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let task = TaskRuntime::get(&storage, "alice", "watch").await.unwrap();
            if task["upstreamSettled"] == true {
                assert_eq!(task["resultState"], "available");
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    })
    .await
    .unwrap();
    assert_eq!(mock.posts.load(Ordering::Relaxed), 0);
    runtime.close().await;
    storage.close().await.unwrap();
    server.abort();
}
