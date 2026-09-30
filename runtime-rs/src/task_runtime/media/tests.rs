use super::*;

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
