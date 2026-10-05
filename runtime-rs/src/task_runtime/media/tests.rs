use super::*;
use crate::{execution::ExecutionHooks, generation::Config, upstream::LocalUpstream};
use axum::{
    Json, Router,
    extract::State,
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::future::BoxFuture;
use std::sync::atomic::AtomicUsize;

tokio::task_local! {
    static COLLECTION_QUERY: ();
}

struct RetryCollection {
    storage: Storage,
    failed: AtomicUsize,
    collected: AtomicUsize,
}
impl ExecutionHooks for RetryCollection {
    // The fixture seeds the accepted identity and registers the live job itself,
    // so only the explicit reconciliation can observe it (no monitor races).
    fn checkpoint(&self, _: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn submitting(&self, _: String, _: String) -> BoxFuture<'_, Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn observed(&self, _: String, _: Value) -> BoxFuture<'_, Result<()>> {
        Box::pin(async { Ok(()) })
    }
    fn collect(&self, outputs: Vec<Output>) -> BoxFuture<'_, Result<()>> {
        Box::pin(async move {
            // Background retries keep failing; only the query under test may
            // succeed. This avoids relying on the provider's retry timer.
            if COLLECTION_QUERY.try_with(|()| ()).is_err() {
                self.failed.fetch_add(1, Ordering::Relaxed);
                return Err(ApiError::new(
                    503,
                    "FIXTURE_COLLECTION_FAILED",
                    "Retry collection",
                ));
            }
            let Output::File { path, .. } = &outputs[0] else {
                panic!("Comfy output must be file-backed");
            };
            let path = path.clone();
            hooks::collect(&self.storage, "owner", "retry-result", outputs).await?;
            // A second open/hash pass now fails deterministically, even if the
            // storage prepare would otherwise short-circuit an existing result.
            tokio::fs::rename(&path, path.with_extension("collected")).await?;
            self.collected.fetch_add(1, Ordering::Relaxed);
            Ok(())
        })
    }
}

#[tokio::test]
async fn provider_query_retries_collection_without_reopening_committed_source() {
    let directory = tempfile::tempdir().unwrap();
    let png = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();
    let posts = Arc::new(AtomicUsize::new(0));
    let view_bytes = png.clone();
    let invalid = Arc::new(AtomicBool::new(false));
    let reject = invalid.clone();
    let app = Router::new()
        .route("/system_stats", get(|| async { Json(json!({})) }))
        .route("/free", post(|| async { Json(json!({})) }))
        .route("/prompt", post(|State(posts): State<Arc<AtomicUsize>>| async move {
            posts.fetch_add(1, Ordering::Relaxed);
            Json(json!({"prompt_id":"fixture-prompt"}))
        }))
        .route("/history/{id}", get(|| async {
            Json(json!({"fixture-prompt":{"status":{"status_str":"success"},"outputs":{"10":{"images":[{"filename":"wai_app_fixture.png","type":"output","subfolder":""}]}}}}))
        }))
        .route("/view", get(move || {
            let bytes = if reject.load(Ordering::Acquire) { b"not an image".to_vec() } else { view_bytes.clone() };
            async move { ([("content-type", "image/png")], bytes) }
        }))
        .with_state(posts.clone());
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
    let checkpoints = config.ai_workspace_root.join("ComfyUI/models/checkpoints");
    std::fs::create_dir_all(&checkpoints).unwrap();
    std::fs::write(
        checkpoints.join("waiIllustriousSDXL_v170.safetensors"),
        b"fixture",
    )
    .unwrap();
    let shutdown = CancellationToken::new();
    let provider =
        Arc::new(GenerationService::new(config, LocalUpstream::new(), shutdown.clone()).unwrap());
    let runtime = Arc::new(TaskRuntime::new(provider.clone(), None, None, shutdown).unwrap());
    let prepared = provider
        .prepare(
            json!({"prompt":"neutral fixture","negative":"","width":1024,"height":1024,"seed":42}),
            true,
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(prepared.provider, "comfy");
    let storage = Storage::open(
        directory.path().join("workspace"),
        "collection-retry".into(),
        true,
    )
    .await
    .unwrap();
    let id = "retry-result";
    let record = json!({"taskId":id,"workspaceId":storage.workspace_id(),"principalId":"owner",
        "requestKey":id,"requestFingerprint":"fixture","kind":"generation","provider":"comfy",
        "providerFingerprint":runtime.binding(),"upstreamId":"fixture-prompt","status":"running",
        "recoveryState":"normal","revision":0,"runtimeEpoch":storage.runtime_epoch(),"createdAt":1,"updatedAt":1,
        "submissionIntentAt":2,"submissionObservedAt":3,"cancelRequestedAt":null,"upstreamSettled":false,
        "executionDeadline":9999999999999u64,"input":prepared.input,"inputMediaRefs":[],"resultState":"none",
        "resultRefs":[],"deliveryState":"unseen","metadata":{},"checkpoint":null});
    storage
        .request(json!({"kind":"task.accept","record":record}), "owner")
        .await
        .unwrap();
    let hooks = Arc::new(RetryCollection {
        storage: storage.clone(),
        failed: AtomicUsize::new(0),
        collected: AtomicUsize::new(0),
    });
    let job = provider
        .clone()
        .submit(prepared, "owner".into(), Some(hooks.clone()))
        .await
        .unwrap();
    let job_id = job["id"].as_str().unwrap();
    runtime.register_job(&storage, id, job_id.into());
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            let job = provider.get_job(job_id, "owner").await.unwrap();
            assert_ne!(job["status"], "failed", "{job}");
            if job["code"] == "RESULT_COLLECTION_PENDING" {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(hooks.failed.load(Ordering::Relaxed) >= 1);
    assert_eq!(
        TaskRuntime::get(&storage, "owner", id)
            .await
            .unwrap()
            .result_state,
        ResultState::None
    );
    let Output::File { path, .. } = provider.result(job_id, "owner").await.unwrap() else {
        panic!("expected source file");
    };
    assert_eq!(tokio::fs::read(&path).await.unwrap(), png);
    // A restart can leave a confirmed success whose result still needs collection.
    patch(
        &storage,
        "owner",
        id,
        TaskPatch {
            status: Some(TaskStatus::Succeeded),
            upstream_settled: Some(true),
            metadata: Some(
                serde_json::from_value(json!({"resultCollectionError":"OLD_FAILURE"})).unwrap(),
            ),
            error_code: Some(Some("RESULT_COLLECTION_PENDING".into())),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    let task = COLLECTION_QUERY
        .scope((), runtime.reconcile(&storage, "owner", id))
        .await
        .unwrap();
    assert_eq!(task["status"], "succeeded");
    assert!(task["metadata"]["resultCollectionError"].is_null());
    assert_eq!(task["upstreamSettled"], true);
    assert_eq!(task["resultState"], "available");
    assert_eq!(task["resultRefs"].as_array().unwrap().len(), 1);
    assert_eq!(task["resultRefs"][0]["alias"], "task-retry-result-0");
    assert_eq!(
        task["resultRefs"][0]["sha256"],
        hex::encode(Sha256::digest(&png))
    );
    assert!(
        !path.exists(),
        "successful query revoked access to the source"
    );
    assert_eq!(
        tokio::fs::read(path.with_extension("collected"))
            .await
            .unwrap(),
        png
    );
    assert_eq!(hooks.collected.load(Ordering::Relaxed), 1);
    let stored = storage.media("task-retry-result-0").await.unwrap();
    assert_eq!(tokio::fs::read(stored.path).await.unwrap(), png);
    assert_eq!(
        runtime.reconcile(&storage, "owner", id).await.unwrap(),
        task
    );
    assert_eq!(
        posts.load(Ordering::Relaxed),
        1,
        "collection retry must not replay generation"
    );
    // Exercise automatic recovery after Unknown has actually stopped watching.
    // Observe SQLite only: an explicit reconcile would hide a missing wakeup.
    for reject_output in [false, true] {
        let output = directory.path().join("runtime/outputs/wai");
        let backup = output.with_extension("saved");
        std::fs::rename(&output, &backup).unwrap();
        std::fs::write(&output, b"blocked").unwrap();
        let accepted = runtime.submit(storage.clone(), "owner".into(), json!({
            "requestKey":format!("background-{reject_output}"),"kind":"generation",
            "input":{"prompt":"neutral fixture","negative":"","width":1024,"height":1024,"seed":42}
        })).await.unwrap();
        let task_id = accepted["taskId"].as_str().unwrap();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let task = TaskRuntime::get(&storage, "owner", task_id).await.unwrap();
                if task.recovery_state == TaskRecoveryState::Unknown
                    && !runtime.owns(&storage, task_id)
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        patch(
            &storage,
            "owner",
            task_id,
            TaskPatch {
                metadata: Some(
                    serde_json::from_value(json!({"resultCollectionError":"OLD_FAILURE"})).unwrap(),
                ),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        invalid.store(reject_output, Ordering::Release);
        std::fs::remove_file(&output).unwrap();
        let task = tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let task = TaskRuntime::get(&storage, "owner", task_id).await.unwrap();
                if task.upstream_settled {
                    break task;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(task.recovery_state, TaskRecoveryState::Normal);
        if reject_output {
            assert_eq!(task.status, TaskStatus::Failed);
            assert_eq!(task.error_code.as_deref(), Some("INVALID_RESULT"));
            assert!(task.result_refs.is_empty());
            let mut next = accepted.clone();
            next["taskId"] = json!("after-known-failure");
            next["requestKey"] = json!("after-known-failure");
            storage
                .request(json!({"kind":"task.accept","record":next}), "owner")
                .await
                .unwrap();
        } else {
            assert_eq!(task.status, TaskStatus::Succeeded);
            assert_eq!(task.result_state, ResultState::Available);
            assert!(task.error_code.is_none());
            assert!(task.metadata["resultCollectionError"].is_null());
        }
        // Reuse the original source directory for the next isolated attempt.
        if output.exists() {
            std::fs::remove_dir_all(&output).unwrap();
        }
        std::fs::rename(backup, output).unwrap();
    }
    assert_eq!(posts.load(Ordering::Relaxed), 3);
    runtime.close().await;
    storage.close().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn memory_and_file_outputs_persist_across_binary_chunk_boundaries() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("workspace");
    let storage = Storage::open(root, "runtime-binary-media".into(), true)
        .await
        .unwrap();
    let principal = "desktop:runtime-binary";
    let id = "runtime-binary-task";
    let record = json!({"taskId":id,"workspaceId":storage.workspace_id(),"principalId":principal,
        "requestKey":"binary-request","requestFingerprint":"fixture","kind":"generation",
        "provider":"fixture","providerFingerprint":"fixture","upstreamId":null,
        "status":"succeeded","recoveryState":"normal","revision":0,"runtimeEpoch":"",
        "createdAt":1,"updatedAt":1,"submissionIntentAt":null,"submissionObservedAt":null,
        "cancelRequestedAt":null,"upstreamSettled":true,"executionDeadline":60000,
        "input":{},"inputMediaRefs":[],"resultState":"none","resultRefs":[],
        "deliveryState":"unseen","errorCode":null,"metadata":{},"checkpoint":null,
        "parentBatchId":null,"stepIndex":null});
    storage
        .task(
            TaskCommand::Accept {
                record: Box::new(serde_json::from_value(record).unwrap()),
            },
            principal,
        )
        .await
        .unwrap();
    let mut content = vec![93; 1024 * 1024 + 37];
    content[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
    let shared = Arc::new(content);
    persist(
        &storage,
        principal,
        id,
        Target::Result(0),
        Output::Bytes {
            bytes: shared.clone(),
            mime: "image/png".into(),
        },
    )
    .await
    .unwrap();
    let source = directory.path().join("input.png");
    tokio::fs::write(&source, shared.as_slice()).await.unwrap();
    persist(
        &storage,
        principal,
        id,
        Target::Input("image".into()),
        Output::File {
            path: source.clone(),
            mime: "image/png".into(),
            bytes: shared.len() as u64,
        },
    )
    .await
    .unwrap();
    tokio::fs::remove_file(source).await.unwrap();
    let restored = directory.path().join("restored/input.png");
    for _ in 0..2 {
        assert!(
            restore(&storage, principal, id, "image", &restored)
                .await
                .unwrap()
        );
        assert_eq!(tokio::fs::read(&restored).await.unwrap(), shared.as_slice());
        assert_eq!(
            std::fs::read_dir(restored.parent().unwrap())
                .unwrap()
                .count(),
            1
        );
    }
    for target in [Target::Result(0), Target::Input("image".into())] {
        let stored = storage.media(&target.alias(id)).await.unwrap();
        assert_eq!(
            tokio::fs::read(stored.path).await.unwrap(),
            shared.as_slice()
        );
    }
    let task = storage
        .request(json!({"kind":"task.get","taskId":id}), principal)
        .await
        .unwrap();
    assert_eq!(task["resultState"], "available");
    assert_eq!(task["resultRefs"][0]["bytes"], shared.len());
    assert_eq!(task["inputMediaRefs"].as_array().unwrap().len(), 1);
    storage.close().await.unwrap();
}
