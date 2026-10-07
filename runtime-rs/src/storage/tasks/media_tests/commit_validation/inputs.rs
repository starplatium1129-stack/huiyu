use super::*;

#[tokio::test]
async fn input_hash_releases_actor_and_abandoned_commit_drains_before_close() {
    for abandon in [false, true] {
        let (directory, storage) = fixture().await;
        let target = TaskMediaTarget::Input("source".into());
        let bytes = data(media::CHUNK);
        let alias = prepare(&storage, &target, &bytes).await;
        storage
            .task_media_chunk(chunk(&target, 0, Bytes::from(bytes)), PRINCIPAL)
            .await
            .unwrap();
        let key = canonical::digest(format!("input:{ID}:source"));
        let staging = media::staging_path(&storage.root, &key, &alias).unwrap();
        let mut gate = Gate::new(&staging, "before-hash");
        let writer = storage.clone();
        let request_command = command(&target, "commit");
        let request = tokio::spawn(async move { writer.request(request_command, PRINCIPAL).await });
        assert_eq!(gate.ready().await, "workspace-result-verify");
        let started = Instant::now();
        let current = bounded(storage.request(json!({"kind":"task.get","taskId":ID}), PRINCIPAL))
            .await
            .unwrap();
        eprintln!(
            "input commit paused hash: task.get queue+service {:?}",
            started.elapsed()
        );
        assert!(!request.is_finished());
        let patched = bounded(storage.request(
            json!({"kind":"task.patch","taskId":ID,
            "expectedRevision":current["revision"],"patch":{"metadata":{"duringHash":true}}}),
            PRINCIPAL,
        ))
        .await
        .unwrap();
        bounded(storage.request(
            json!({"kind":"collectGarbage","operationId":"input-inflight"}),
            PRINCIPAL,
        ))
        .await
        .unwrap();
        assert!(staging.exists());
        let mut waiting =
            Box::pin(storage.task_media_chunk(chunk(&target, 0, Bytes::new()), PRINCIPAL));
        pending(waiting.as_mut()).await;
        assert_eq!(storage.result_writes.available_permits(), 0);
        if abandon {
            request.abort();
            assert!(bounded(request).await.unwrap_err().is_cancelled());
            let mut close = Box::pin(storage.close());
            pending(close.as_mut()).await;
            assert_eq!(
                bounded(waiting).await.unwrap_err().code,
                "STORAGE_UNAVAILABLE"
            );
            let contender = Storage::open(
                directory.path().join("workspace"),
                "binary-media".into(),
                false,
            )
            .await;
            assert!(matches!(contender, Err(error) if error.code == "WORKSPACE_LOCKED"));
            gate.release();
            bounded(close).await.unwrap();
            let database = db(&storage);
            assert_eq!(
                count(
                    &database,
                    "SELECT count(*) FROM task_inputs WHERE committed=1"
                ),
                0
            );
            assert_eq!(
                count(
                    &database,
                    "SELECT count(*) FROM media_refs WHERE owner_kind='task-input'"
                ),
                0
            );
            assert_eq!(count(&database, "SELECT count(*) FROM leases"), 1);
            let reopened = Storage::open(
                directory.path().join("workspace"),
                "binary-media".into(),
                false,
            )
            .await
            .unwrap();
            assert_eq!(
                bounded(reopened.request(command(&target, "commit"), PRINCIPAL))
                    .await
                    .unwrap()["alias"],
                alias
            );
            reopened.close().await.unwrap();
        } else {
            drop(waiting);
            gate.release();
            let committed = bounded(request).await.unwrap().unwrap();
            assert_eq!(committed["alias"], alias);
            let task = storage
                .request(json!({"kind":"task.get","taskId":ID}), PRINCIPAL)
                .await
                .unwrap();
            assert_eq!(task["metadata"], patched["metadata"]);
            assert_eq!(task["inputMediaRefs"], json!([alias]));
            assert_eq!(
                storage
                    .request(command(&target, "commit"), PRINCIPAL)
                    .await
                    .unwrap(),
                committed
            );
            assert_eq!(
                storage
                    .request(command(&target, "get"), PRINCIPAL)
                    .await
                    .unwrap(),
                committed
            );
            assert!(!staging.exists());
            storage.close().await.unwrap();
        }
    }
}
