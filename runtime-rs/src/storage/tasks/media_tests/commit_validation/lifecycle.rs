use super::*;
use std::time::SystemTime;

fn expire(path: &Path) {
    File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(
            SystemTime::now() - Duration::from_millis(records::RETENTION as u64 + 60_000),
        ))
        .unwrap();
}
async fn patch(storage: &Storage, changes: Value) -> Value {
    let task = storage
        .request(json!({"kind":"task.get","taskId":ID}), PRINCIPAL)
        .await
        .unwrap();
    storage
        .request(
            json!({"kind":"task.patch","taskId":ID,
        "expectedRevision":task["revision"],"patch":changes}),
            PRINCIPAL,
        )
        .await
        .unwrap()
}
async fn garbage(storage: &Storage, id: &str) {
    bounded(storage.request(json!({"kind":"collectGarbage","operationId":id}), PRINCIPAL))
        .await
        .unwrap();
}

#[tokio::test]
async fn discard_keeps_inflight_staging_and_objects_alive_until_validation_exits() {
    for existing in [false, true] {
        let (_directory, storage) = fixture().await;
        let bytes = data(64);
        let (staging, object) = uploaded(&storage, 0, &bytes).await;
        if existing {
            fs::create_dir_all(object.parent().unwrap()).unwrap();
            fs::copy(&staging, &object).unwrap();
            expire(&object);
        }
        expire(&staging);
        let mut gate = Gate::new(if existing { &object } else { &staging }, "before-hash");
        let request = commit(&storage, 0);
        gate.ready().await;
        patch(&storage, json!({"resultState":"available"})).await;
        patch(&storage, json!({"deliveryState":"discarded"})).await;
        assert_eq!(count(&db(&storage), "SELECT count(*) FROM leases"), 0);
        garbage(&storage, "while-inflight").await;
        assert!(
            staging.exists(),
            "discarded staging remains protected by the running validator"
        );
        assert_eq!(object.exists(), existing);
        assert!(!request.is_finished());
        gate.release();
        assert_eq!(
            bounded(request).await.unwrap().unwrap_err().code,
            "TASK_RESULT_DISCARDED"
        );
        unpublished(&db(&storage));
        garbage(&storage, "after-inflight").await;
        assert!(!staging.exists() && !object.exists());
        assert_eq!(count(&db(&storage), "SELECT count(*) FROM leases"), 0);
        let task = storage
            .request(json!({"kind":"task.get","taskId":ID}), PRINCIPAL)
            .await
            .unwrap();
        assert_eq!(task["deliveryState"], "discarded");
        assert_eq!(task["resultState"], "unavailable");
        storage.close().await.unwrap();
    }
}

#[tokio::test]
async fn cancelled_waiters_keep_admission_and_close_drains_before_releasing_owner() {
    for mode in ["retry", "close", "drop"] {
        let (directory, storage) = fixture().await;
        let (staging, _) = uploaded(&storage, 0, &data(64)).await;
        let owner = storage.root.join(".workspace-owner.json");
        let mut gate = Gate::new(&staging, "before-hash");
        let request = commit(&storage, 0);
        gate.ready().await;
        request.abort();
        assert!(bounded(request).await.unwrap_err().is_cancelled());
        assert_eq!(storage.result_writes.available_permits(), 0);
        if mode == "drop" {
            let database = db(&storage);
            drop(storage);
            assert!(owner.exists());
            gate.release();
            bounded(async {
                while owner.exists() {
                    tokio::task::yield_now().await;
                }
            })
            .await;
            unpublished(&database);
            continue;
        }
        if mode == "close" {
            let (entered, ready) = oneshot::channel();
            let (resume_gc, resume) = sync_mpsc::sync_channel(1);
            let (finished, completed) = oneshot::channel();
            storage
                .sender
                .send(Work::PauseGarbage(worker::GarbagePause {
                    entered,
                    resume,
                    finished,
                }))
                .await
                .unwrap();
            let collector = storage.clone();
            let gc = tokio::spawn(async move {
                collector
                    .request(
                        json!({"kind":"collectGarbage","operationId":"close-overlap"}),
                        PRINCIPAL,
                    )
                    .await
            });
            bounded(ready).await.unwrap();
            let target = TaskMediaTarget::Result(0);
            let mut queued = Box::pin(storage.request(command(&target, "commit"), PRINCIPAL));
            pending(queued.as_mut()).await;
            let mut close = Box::pin(storage.close());
            pending(close.as_mut()).await;
            assert!(storage.result_writes.is_closed());
            assert_eq!(
                bounded(queued).await.unwrap_err().code,
                "STORAGE_UNAVAILABLE"
            );
            assert!(owner.exists());
            let contender = Storage::open(
                directory.path().join("workspace"),
                "binary-media".into(),
                false,
            )
            .await;
            assert!(matches!(contender, Err(error) if error.code == "WORKSPACE_LOCKED"));
            // GC finishes after Close while result hashing is still paused.
            // Neither its completion nor the cancelled HTTP waiter owns drain.
            resume_gc.send(()).unwrap();
            bounded(completed).await.unwrap();
            assert_eq!(bounded(gc).await.unwrap().unwrap_err().code, "CANCELLED");
            pending(close.as_mut()).await;
            assert!(owner.exists());
            gate.release();
            bounded(close).await.unwrap();
            assert!(!owner.exists());
            unpublished(&db(&storage));
            let reopened = Storage::open(
                directory.path().join("workspace"),
                "binary-media".into(),
                false,
            )
            .await
            .unwrap();
            assert_eq!(count(&db(&reopened), "SELECT count(*) FROM leases"), 1);
            bounded(commit(&reopened, 0)).await.unwrap().unwrap();
            reopened.close().await.unwrap();
        } else {
            gate.release();
            let permit = bounded(storage.result_writes.acquire()).await.unwrap();
            unpublished(&db(&storage));
            assert_eq!(count(&db(&storage), "SELECT count(*) FROM leases"), 1);
            drop(permit);
            bounded(commit(&storage, 0)).await.unwrap().unwrap();
            storage.close().await.unwrap();
        }
    }
}

#[tokio::test]
async fn validator_panic_and_start_failure_release_admission_and_keep_retry_lease() {
    for panic in [false, true] {
        let (_directory, storage) = fixture().await;
        let (staging, _) = uploaded(&storage, 0, &data(64)).await;
        let mut gate = panic.then(|| Gate::with_panic(&staging, "before-hash", true));
        if !panic {
            failures()
                .lock()
                .unwrap()
                .insert(storage.root.as_ref().clone());
        }
        let request = commit(&storage, 0);
        if let Some(gate) = &mut gate {
            gate.ready().await;
            gate.release();
        }
        assert!(bounded(request).await.unwrap().is_err());
        assert!(
            !fail_start(&storage.root),
            "start failure must be consumed exactly once"
        );
        unpublished(&db(&storage));
        assert_eq!(count(&db(&storage), "SELECT count(*) FROM leases"), 1);
        let permit = bounded(storage.result_writes.acquire()).await.unwrap();
        drop(permit);
        assert_eq!(storage.result_writes.available_permits(), 1);
        bounded(commit(&storage, 0)).await.unwrap().unwrap();
        assert_eq!(count(&db(&storage), "SELECT count(*) FROM leases"), 0);
        storage.close().await.unwrap();
    }
}

#[tokio::test]
async fn another_media_writer_cannot_steal_the_validated_result_alias() {
    let (_directory, storage) = fixture().await;
    let (staging, _) = uploaded(&storage, 0, &data(64)).await;
    let alias = "task-binary-task-0";
    let other = data(128);
    let other_hash = hex::encode(Sha256::digest(&other));
    let mut gate = Gate::new(&staging, "before-hash");
    let request = commit(&storage, 0);
    gate.ready().await;
    // Library media writes are deliberately independent of result admission.
    for command in [
        json!({"kind":"prepareMedia","operationId":"competing-alias",
            "media":{"alias":alias,"sha256":other_hash,"bytes":other.len(),"mime":"image/png"}}),
        json!({"kind":"uploadMediaChunk","operationId":"competing-alias","offset":0,
            "data":STANDARD.encode(&other)}),
        json!({"kind":"commitMedia","operationId":"competing-alias"}),
    ] {
        bounded(storage.request(command, PRINCIPAL)).await.unwrap();
    }
    assert!(!request.is_finished());
    gate.release();
    assert_eq!(
        bounded(request).await.unwrap().unwrap_err().code,
        "MEDIA_CONFLICT"
    );
    unpublished(&db(&storage));
    let source = storage.media(alias).await.unwrap();
    assert_eq!(source.sha256, other_hash);
    assert_eq!(fs::read(source.path).unwrap(), other);
    assert_eq!(count(&db(&storage), "SELECT count(*) FROM leases"), 1);
    storage.close().await.unwrap();
}

#[tokio::test]
async fn changed_authority_lease_and_output_metadata_are_rechecked_after_hash() {
    for scenario in [
        "owner-replaced",
        "owner-content",
        "epoch",
        "lease-missing",
        "lease-hash",
        "lease-kind",
        "media",
        "principal",
    ] {
        let (_directory, storage) = fixture().await;
        let (staging, _) = uploaded(&storage, 0, &data(64)).await;
        let database = db(&storage);
        let owner = storage.root.join(".workspace-owner.json");
        let owner_bytes = fs::read(&owner).unwrap();
        let mut gate = Gate::new(&staging, "verified");
        let request = commit(&storage, 0);
        gate.ready().await;
        match scenario {
            "owner-replaced" => {
                fs::rename(&owner, owner.with_extension("held")).unwrap();
                fs::write(&owner, &owner_bytes).unwrap();
            }
            "owner-content" => {
                let mut value: Value = serde_json::from_slice(&owner_bytes).unwrap();
                value["nonce"] = json!("changed-owner");
                fs::write(&owner, serde_json::to_vec(&value).unwrap()).unwrap();
            }
            "epoch" => {
                database
                    .execute(
                        "UPDATE meta SET value='changed-epoch' WHERE key='writerEpoch'",
                        [],
                    )
                    .unwrap();
            }
            "lease-missing" => {
                database.execute("DELETE FROM leases", []).unwrap();
            }
            "lease-hash" => {
                database
                    .execute("UPDATE leases SET hash=?", [canonical::digest("other")])
                    .unwrap();
            }
            "lease-kind" => {
                database
                    .execute("UPDATE leases SET kind='media'", [])
                    .unwrap();
            }
            "media" => {
                database
                    .execute(
                        "UPDATE task_outputs SET media_json=json_set(media_json,'$.bytes',65)",
                        [],
                    )
                    .unwrap();
            }
            "principal" => {
                database
                    .execute("UPDATE tasks SET principal_id='other'", [])
                    .unwrap();
            }
            _ => unreachable!(),
        }
        gate.release();
        assert!(bounded(request).await.unwrap().is_err(), "{scenario}");
        unpublished(&database);
        match scenario {
            "owner-replaced" => {
                fs::remove_file(&owner).unwrap();
                fs::rename(owner.with_extension("held"), &owner).unwrap();
            }
            "owner-content" => {
                fs::write(&owner, owner_bytes).unwrap();
            }
            "epoch" => {
                database
                    .execute(
                        "UPDATE meta SET value=? WHERE key='writerEpoch'",
                        [storage.runtime_epoch()],
                    )
                    .unwrap();
            }
            _ => {}
        }
        storage.close().await.unwrap();
    }
}

#[tokio::test]
async fn concurrent_task_metadata_is_merged_without_requiring_an_unchanged_revision() {
    let (_directory, storage) = fixture().await;
    patch(&storage, json!({"upstreamSettled":false})).await;
    patch(&storage, json!({"status":"running"})).await;
    let (staging, _) = uploaded(&storage, 0, &data(64)).await;
    let mut gate = Gate::new(&staging, "verified");
    let request = commit(&storage, 0);
    gate.ready().await;
    let patched = patch(
        &storage,
        json!({"metadata":{"duringValidation":"retained"},"deliveryState":"seen"}),
    )
    .await;
    let cancelled = storage
        .request(
            json!({"kind":"task.cancel","requestKey":"binary-request"}),
            PRINCIPAL,
        )
        .await
        .unwrap();
    assert_eq!(cancelled["status"], "cancelled");
    assert!(cancelled["cancelRequestedAt"].as_u64().unwrap() > 0);
    gate.release();
    let result = bounded(request).await.unwrap().unwrap();
    assert_eq!(result["metadata"]["duringValidation"], "retained");
    assert_eq!(result["deliveryState"], patched["deliveryState"]);
    assert_eq!(result["status"], cancelled["status"]);
    assert_eq!(result["cancelRequestedAt"], cancelled["cancelRequestedAt"]);
    assert_eq!(result["upstreamSettled"], true);
    assert_eq!(result["resultState"], "available");
    assert!(result["revision"].as_i64().unwrap() > cancelled["revision"].as_i64().unwrap());
    assert_eq!(result["resultRefs"].as_array().unwrap().len(), 1);
    storage.close().await.unwrap();
}
