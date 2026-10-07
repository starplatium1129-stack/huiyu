use super::*;
use huiyu_runtime::{storage::Storage, task_contract::TaskStatus, task_runtime::TaskRuntime};

#[tokio::test]
async fn completed_webui_response_with_invalid_image_settles_task_without_replay() {
    let temp = tempfile::tempdir().unwrap();
    let (state, mut started) = mock(true, false);
    state.invalid_image.store(true, Ordering::Relaxed);
    let server = server(state.clone()).await;
    std::fs::create_dir_all(temp.path().join("ai/ComfyUI")).unwrap();
    let provider = service(&server, &temp);
    let runtime =
        Arc::new(TaskRuntime::new(provider.clone(), None, None, CancellationToken::new()).unwrap());
    let storage = Storage::open(temp.path().join("workspace"), "epoch".into(), true)
        .await
        .unwrap();
    let request = json!({"requestKey":"invalid-result", "kind":"generation", "input":input(1)});
    // Resume an accepted pre-retirement record; public admission must stay closed.
    let prepared = provider
        .prepare(input(1), true, CancellationToken::new())
        .await
        .unwrap();
    let identity = std::process::Command::new("node")
        .arg(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/task_recovery/legacy-provider.cjs"),
        )
        .arg(temp.path().join("ai"))
        .arg(&server.url)
        .output()
        .unwrap();
    assert!(
        identity.status.success(),
        "{}",
        String::from_utf8_lossy(&identity.stderr)
    );
    // All request keys here are ASCII; this matches the old locale-sorted wire fixture.
    let mut frozen = json!({"kind":"generation", "input":input(1)});
    frozen["input"].as_object_mut().unwrap().sort_keys();
    frozen.as_object_mut().unwrap().sort_keys();
    let fingerprint = hex::encode(Sha256::digest(serde_json::to_vec(&frozen).unwrap()));
    let id = "invalid-result";
    let record = json!({"taskId":id,"workspaceId":storage.workspace_id(),"principalId":"owner",
        "requestKey":id,"requestFingerprint":fingerprint,"requestFingerprintLocale":"en-US",
        "kind":"generation","provider":"webui","providerFingerprint":String::from_utf8(identity.stdout).unwrap(),
        "upstreamId":null,"status":"queued","recoveryState":"normal","revision":0,
        "runtimeEpoch":"legacy-epoch","createdAt":1,"updatedAt":1,"submissionIntentAt":null,
        "submissionObservedAt":null,"cancelRequestedAt":null,"upstreamSettled":false,"executionDeadline":9999999999999u64,
        "input":prepared.input,"inputMediaRefs":[],"resultState":"none","resultRefs":[],"deliveryState":"unseen",
        "errorCode":null,"metadata":{},"checkpoint":null});
    storage
        .request(json!({"kind":"task.accept","record":record}), "owner")
        .await
        .unwrap();
    let accepted = runtime
        .resume(storage.clone(), "owner".into(), id.into())
        .await
        .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), started.recv())
            .await
            .unwrap()
            .unwrap(),
        "start:1"
    );
    state.gate.add_permits(1);
    let id = accepted["taskId"].as_str().unwrap();
    let failed = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            runtime.reconcile(&storage, "owner", id).await.unwrap();
            let task = TaskRuntime::get(&storage, "owner", id).await.unwrap();
            if task.status == TaskStatus::Failed {
                break task;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(
        failed.upstream_settled,
        "a returned response is not an in-flight request"
    );
    assert_eq!(failed.error_code.as_deref(), Some("SD_INVALID_IMAGE"));
    assert!(failed.result_refs.is_empty());
    assert!(failed.cancel_requested_at.is_none());
    // Querying/retrying the original key cannot invoke txt2img again.
    runtime
        .submit(storage.clone(), "owner".into(), request)
        .await
        .unwrap();
    assert_eq!(state.txt_count.load(Ordering::Relaxed), 1);
    state.invalid_image.store(false, Ordering::Relaxed);
    let next = runtime
        .submit(
            storage.clone(),
            "owner".into(),
            json!({"requestKey":"next-result", "kind":"generation", "input":input(2)}),
        )
        .await
        .unwrap_err();
    assert_eq!(next.code, "SD_RETIRED");
    assert_eq!(state.txt_count.load(Ordering::Relaxed), 1);
    runtime.close().await;
    storage.close().await.unwrap();
}
