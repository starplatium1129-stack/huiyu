use super::*;
use huiyu_runtime::{storage::Storage, task_contract::TaskStatus, task_runtime::TaskRuntime};

#[tokio::test]
async fn completed_webui_response_with_invalid_image_settles_task_without_replay() {
    let temp = tempfile::tempdir().unwrap();
    let (state, mut started) = mock(true, false);
    state.invalid_image.store(true, Ordering::Relaxed);
    let server = server(state.clone()).await;
    let provider = service(&server, &temp);
    let runtime =
        Arc::new(TaskRuntime::new(provider, None, None, CancellationToken::new()).unwrap());
    let storage = Storage::open(temp.path().join("workspace"), "epoch".into(), true)
        .await
        .unwrap();
    let request = json!({"requestKey":"invalid-result", "kind":"generation", "input":input(1)});
    let accepted = runtime
        .submit(storage.clone(), "owner".into(), request.clone())
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
        .unwrap();
    assert_ne!(next["taskId"], accepted["taskId"]);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), started.recv())
            .await
            .unwrap()
            .unwrap(),
        "start:2"
    );
    runtime.close().await;
    storage.close().await.unwrap();
}
