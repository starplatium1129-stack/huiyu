use super::*;
use axum::body::Body;
use futures_util::{StreamExt, stream};
use std::time::Duration;
use tokio::sync::Semaphore;

#[tokio::test]
async fn recovery_timeout_reclaims_partial_video_and_retries_without_resubmission() {
    let directory = tempfile::tempdir().unwrap();
    let gate = Arc::new(Semaphore::new(0));
    let posts = Arc::new(AtomicUsize::new(0));
    let downloads = Arc::new(AtomicUsize::new(0));
    let bytes = b"\x00\x00\x00\x18ftypisomfixture-video-body".to_vec();
    let view_gate = gate.clone();
    let view_count = downloads.clone();
    let view_bytes = bytes.clone();
    let prompt_count = posts.clone();
    let app = Router::new()
        .route("/history/{id}", get(|| async {
            Json(json!({"upstream-video":{"status":{"status_str":"success"},"outputs":{"11":{"videos":[{"filename":"aics_video_fixture.mp4","type":"output","subfolder":""}]}}}}))
        }))
        .route("/view", get(move || {
            let gate = view_gate.clone();
            let bytes = view_bytes.clone();
            view_count.fetch_add(1, Ordering::SeqCst);
            async move {
                let head = bytes[..12].to_vec();
                let tail = bytes[12..].to_vec();
                let chunks = stream::once(async { Ok::<_, std::io::Error>(head) })
                    .chain(stream::once(async move {
                        gate.acquire().await.unwrap().forget();
                        Ok(tail)
                    }));
                ([("content-type", "video/mp4")], Body::from_stream(chunks))
            }
        }))
        .route("/prompt", post(move || {
            prompt_count.fetch_add(1, Ordering::SeqCst);
            async { StatusCode::BAD_REQUEST }
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
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
    let storage = Storage::open(store.clone(), "video-recovery".into(), true)
        .await
        .unwrap();
    let record = json!({"taskId":"video","workspaceId":storage.workspace_id(),"principalId":"alice",
        "requestKey":"stable-video","requestFingerprint":"fixture","kind":"video","provider":"comfy",
        "providerFingerprint":fingerprint,"upstreamId":"upstream-video","status":"running",
        "recoveryState":"normal","revision":0,"runtimeEpoch":"old","createdAt":1,"updatedAt":1,
        "submissionIntentAt":2,"submissionObservedAt":3,"cancelRequestedAt":null,"upstreamSettled":false,
        "executionDeadline":9999999999999u64,"input":{},"inputMediaRefs":[],"resultState":"none",
        "resultRefs":[],"deliveryState":"unseen","metadata":{}});
    storage
        .request(json!({"kind":"task.accept","record":record}), "alice")
        .await
        .unwrap();
    storage.close().await.unwrap();
    let storage = Storage::open(store, "video-recovery".into(), false)
        .await
        .unwrap();
    let shutdown = CancellationToken::new();
    let provider = Arc::new(
        GenerationService::new(config.clone(), LocalUpstream::new(), shutdown.clone()).unwrap(),
    );
    let runtime = Arc::new(TaskRuntime::new(provider, None, None, shutdown).unwrap());
    let recovering = runtime.clone();
    let recovering_store = storage.clone();
    let recovery = tokio::spawn(async move {
        recovering
            .ensure_recovered(&recovering_store, "alice")
            .await
    });
    let outputs = config.runtime_root.join("outputs/video");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if std::fs::read_dir(&outputs).is_ok_and(|entries| {
                entries.flatten().any(|entry| {
                    entry
                        .path()
                        .extension()
                        .is_some_and(|extension| extension == "part")
                })
            }) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    // The outer recovery budget (60s) expires before the video transfer's 120s
    // budget. Dropping that future must release its partially written file.
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(61)).await;
    tokio::time::resume();
    assert_eq!(
        recovery.await.unwrap().unwrap_err().code,
        "TASK_RECOVERY_TIMEOUT"
    );
    assert_eq!(
        std::fs::read_dir(&outputs).unwrap().count(),
        0,
        "dropped recovery leaked a partial video"
    );
    let interrupted = TaskRuntime::get(&storage, "alice", "video").await.unwrap();
    assert!(!interrupted.upstream_settled);
    assert!(interrupted.cancel_requested_at.is_none());
    assert_eq!(interrupted.recovery_state, RecoveryState::Unknown);
    gate.add_permits(2);
    runtime.ensure_recovered(&storage, "alice").await.unwrap();
    let recovered = TaskRuntime::get(&storage, "alice", "video").await.unwrap();
    assert_eq!(recovered.status, TaskStatus::Succeeded);
    assert_eq!(recovered.result_state, ResultState::Available);
    assert!(recovered.upstream_settled);
    let media = storage
        .media(&recovered.result_refs[0].alias)
        .await
        .unwrap();
    assert_eq!(std::fs::read(media.path).unwrap(), bytes);
    assert_eq!(std::fs::read_dir(outputs).unwrap().count(), 0);
    assert_eq!(downloads.load(Ordering::SeqCst), 2);
    assert_eq!(posts.load(Ordering::SeqCst), 0);
    runtime.close().await;
    storage.close().await.unwrap();
    server.abort();
}
