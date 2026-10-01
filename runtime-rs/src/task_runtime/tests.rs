use super::*;
use crate::{generation::Config, upstream::LocalUpstream};
use axum::{Json, Router, extract::State, routing::any};
use std::sync::atomic::AtomicUsize;

#[tokio::test]
async fn reconciliation_and_resume_cannot_steal_an_accepted_dispatcher() {
    let fixture = tempfile::tempdir().unwrap();
    let requests = Arc::new(AtomicUsize::new(0));
    let app = Router::new()
        .fallback(any(|State(requests): State<Arc<AtomicUsize>>| async move {
            requests.fetch_add(1, Ordering::Relaxed);
            Json(json!({}))
        }))
        .with_state(requests.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let host = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let cancel = CancellationToken::new();
    let provider = Arc::new(
        GenerationService::new(
            Config {
                sd_host: host.clone(),
                sd_auth: None,
                comfy_host: host,
                ai_workspace_root: fixture.path().join("AI"),
                runtime_root: fixture.path().join("runtime"),
            },
            LocalUpstream::new(),
            cancel.clone(),
        )
        .unwrap(),
    );
    let runtime = Arc::new(TaskRuntime::new(provider, None, None, cancel).unwrap());
    let storage = Storage::open(
        fixture.path().join("workspace"),
        "dispatch-race".into(),
        true,
    )
    .await
    .unwrap();
    let normalized = crate::generation::validate(
        &json!({"prompt":"neutral fixture","negative":"","width":1024,"height":1024,"seed":1}),
        true,
    )
    .unwrap();
    let record = json!({"taskId":"accepted","workspaceId":storage.workspace_id(),"principalId":"owner","requestKey":"accepted","requestFingerprint":"fixture","kind":"generation","provider":"comfy","providerFingerprint":runtime.binding(),"upstreamId":null,"status":"queued","recoveryState":"normal","revision":0,"runtimeEpoch":storage.runtime_epoch(),"createdAt":1,"updatedAt":1,"submissionIntentAt":null,"submissionObservedAt":null,"cancelRequestedAt":null,"upstreamSettled":false,"executionDeadline":10800000,"input":normalized,"inputMediaRefs":[],"resultRefs":[],"resultState":"none","deliveryState":"unseen","metadata":{},"checkpoint":null});
    storage
        .request(json!({"kind":"task.accept","record":record}), "owner")
        .await
        .unwrap();
    for index in 0..16 {
        assert_eq!(
            runtime
                .reconcile(&storage, "owner", &format!("missing-{index}"))
                .await
                .unwrap_err()
                .code,
            "TASK_NOT_FOUND"
        );
    }
    assert_eq!(
        runtime
            .reconcile(&storage, "another-principal", "accepted")
            .await
            .unwrap_err()
            .code,
        "TASK_NOT_FOUND"
    );
    assert!(
        runtime.jobs.lock().unwrap().is_empty(),
        "Rejected reconciliations must not retain execution bindings"
    );
    assert_eq!(requests.load(Ordering::Relaxed), 0);
    // Model the accepted interval while the real dispatcher owns input copying,
    // before it has published any gateway/upstream identity.
    runtime.jobs.lock().unwrap().insert(
        identity(&storage, "accepted"),
        JobBinding {
            dispatching: true,
            ..JobBinding::new(String::new())
        },
    );
    let task = runtime
        .reconcile(&storage, "owner", "accepted")
        .await
        .unwrap();
    assert_eq!(task["recoveryState"], "normal");
    assert_eq!(task["status"], "queued");
    assert_eq!(
        runtime
            .resume(storage.clone(), "owner".into(), "accepted".into())
            .await
            .unwrap()["taskId"],
        "accepted"
    );
    assert!(runtime.owns(&storage, "accepted"));
    assert_eq!(requests.load(Ordering::Relaxed), 0);
    let submitted = patch(
        &storage,
        "owner",
        "accepted",
        TaskPatch {
            submission_intent_at: Some(Some(now())),
            status: Some(TaskStatus::Submitting),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(submitted.status, TaskStatus::Submitting);
    assert_eq!(
        patch(
            &storage,
            "owner",
            "accepted",
            TaskPatch {
                submission_intent_at: Some(Some(now())),
                ..Default::default()
            }
        )
        .await
        .unwrap_err()
        .code,
        "TASK_SUBMISSION_REPLAY"
    );
    let failed = patch(
        &storage,
        "owner",
        "accepted",
        TaskPatch {
            status: Some(TaskStatus::Failed),
            upstream_settled: Some(false),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(failed.status, TaskStatus::Failed);
    let cancelled = storage
        .request(
            json!({"kind":"task.cancel","requestKey":"accepted"}),
            "owner",
        )
        .await
        .unwrap();
    assert!(cancelled["cancelRequestedAt"].is_number());
    assert_eq!(cancelled["status"], "cancelling");
    assert_eq!(cancelled["upstreamSettled"], false);
    runtime.close().await;
    storage.close().await.unwrap();
    server.abort();
}

#[tokio::test]
async fn webui_release_requires_explicit_confirmation_and_preserves_the_original_task() {
    let fixture = tempfile::tempdir().unwrap();
    let shutdown = CancellationToken::new();
    let provider = Arc::new(
        GenerationService::new(
            Config {
                sd_host: "http://127.0.0.1:9".into(),
                sd_auth: None,
                comfy_host: "http://127.0.0.1:9".into(),
                ai_workspace_root: fixture.path().join("AI"),
                runtime_root: fixture.path().join("runtime"),
            },
            LocalUpstream::new(),
            shutdown.clone(),
        )
        .unwrap(),
    );
    let runtime = Arc::new(TaskRuntime::new(provider, None, None, shutdown).unwrap());
    let storage = Storage::open(
        fixture.path().join("workspace"),
        "webui-release".into(),
        true,
    )
    .await
    .unwrap();
    let record = json!({"taskId":"interrupted", "workspaceId":storage.workspace_id(), "principalId":"owner",
        "requestKey":"original-request", "requestFingerprint":"original-fingerprint", "kind":"generation",
        "provider":"webui", "providerFingerprint":"previous-provider", "upstreamId":null,
        "status":"queued", "recoveryState":"normal", "revision":0, "runtimeEpoch":"previous-epoch",
        "createdAt":1, "updatedAt":1, "submissionIntentAt":null, "submissionObservedAt":null,
        "cancelRequestedAt":null, "upstreamSettled":false, "executionDeadline":10800000,
        "input":{"prompt":"frozen original prompt"}, "inputMediaRefs":[], "resultRefs":[],
        "resultState":"none", "deliveryState":"unseen", "errorCode":"ORIGINAL_DIAGNOSTIC",
        "metadata":{"context":{"title":"original context"}}, "checkpoint":null});
    storage
        .request(json!({"kind":"task.accept", "record":record}), "owner")
        .await
        .unwrap();
    let initial = TaskRuntime::get(&storage, "owner", "interrupted")
        .await
        .unwrap();
    assert_eq!(
        runtime
            .resolve_webui(
                &storage,
                "other-user",
                "interrupted",
                initial.revision,
                true
            )
            .await
            .unwrap_err()
            .code,
        "TASK_NOT_FOUND"
    );
    assert!(runtime.jobs.lock().unwrap().is_empty());
    assert_eq!(
        runtime
            .resolve_webui(&storage, "owner", "interrupted", initial.revision, true)
            .await
            .unwrap_err()
            .code,
        "TASK_RESOLUTION_UNSAFE"
    );
    let running = patch(
        &storage,
        "owner",
        "interrupted",
        TaskPatch {
            submission_intent_at: Some(Some(now())),
            status: Some(TaskStatus::Running),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        runtime
            .resolve_webui(&storage, "owner", "interrupted", running.revision, true)
            .await
            .unwrap_err()
            .code,
        "TASK_RESOLUTION_UNSAFE"
    );
    let comfy = patch(
        &storage,
        "owner",
        "interrupted",
        TaskPatch {
            provider: Some("comfy".into()),
            recovery_state: Some(TaskRecoveryState::Unknown),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        runtime
            .resolve_webui(&storage, "owner", "interrupted", comfy.revision, true)
            .await
            .unwrap_err()
            .code,
        "TASK_RESOLUTION_UNSAFE"
    );
    let unknown = patch(
        &storage,
        "owner",
        "interrupted",
        TaskPatch {
            provider: Some("webui".into()),
            ..Default::default()
        },
    )
    .await
    .unwrap();
    assert_eq!(
        runtime
            .resolve_webui(&storage, "owner", "interrupted", unknown.revision, false)
            .await
            .unwrap_err()
            .code,
        "INVALID_COMMAND"
    );
    assert_eq!(
        runtime
            .resolve_webui(&storage, "owner", "interrupted", initial.revision, true)
            .await
            .unwrap_err()
            .code,
        "REVISION_CONFLICT"
    );
    for dispatching in [true, false] {
        {
            let mut jobs = runtime.jobs.lock().unwrap();
            let job = jobs.get_mut(&identity(&storage, "interrupted")).unwrap();
            job.dispatching = dispatching;
            job.watching = !dispatching;
        }
        assert_eq!(
            runtime
                .resolve_webui(&storage, "owner", "interrupted", unknown.revision, true)
                .await
                .unwrap_err()
                .code,
            "TASK_RESOLUTION_UNSAFE"
        );
    }
    runtime
        .jobs
        .lock()
        .unwrap()
        .get_mut(&identity(&storage, "interrupted"))
        .unwrap()
        .watching = false;
    let mut next = record.clone();
    next["taskId"] = json!("next");
    next["requestKey"] = json!("new-request");
    assert_eq!(
        storage
            .request(json!({"kind":"task.accept", "record":next}), "owner")
            .await
            .unwrap_err()
            .code,
        "TASK_PROVIDER_BUSY"
    );
    let released = runtime
        .resolve_webui(&storage, "owner", "interrupted", unknown.revision, true)
        .await
        .unwrap();
    assert_eq!(released["upstreamSettled"], true);
    assert_eq!(released["status"], "failed");
    assert_eq!(released["resultState"], "unavailable");
    assert_eq!(released["errorCode"], "WEBUI_STOP_CONFIRMED");
    assert_eq!(
        released["metadata"]["context"],
        record["metadata"]["context"]
    );
    assert_eq!(
        released["metadata"]["webuiRelease"]["previousErrorCode"],
        "ORIGINAL_DIAGNOSTIC"
    );
    assert_eq!(
        released["metadata"]["webuiRelease"]["evidence"],
        "user-confirmation"
    );
    for field in [
        "taskId",
        "requestKey",
        "requestFingerprint",
        "providerFingerprint",
        "input",
        "inputMediaRefs",
        "resultRefs",
    ] {
        assert_eq!(released[field], record[field], "preserve {field}");
    }
    assert_eq!(
        runtime
            .resolve_webui(&storage, "owner", "interrupted", unknown.revision, true)
            .await
            .unwrap(),
        released
    );
    assert_eq!(
        storage
            .request(json!({"kind":"task.accept", "record":next}), "owner")
            .await
            .unwrap()["created"],
        true
    );
    runtime.close().await;
    storage.close().await.unwrap();
}
