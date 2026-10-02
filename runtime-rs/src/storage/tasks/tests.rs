use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};

const PRINCIPAL: &str = "desktop:task-test";

fn incoming(workspace: &str, id: &str, key: &str) -> Value {
    json!({"taskId": id, "workspaceId": workspace, "principalId": PRINCIPAL, "requestKey": key,
        "requestFingerprint": canonical::digest(key), "kind": "generation", "provider": "fixture", "providerFingerprint": "fixture",
        "upstreamId": null, "status": "queued", "recoveryState": "normal", "revision": 0, "runtimeEpoch": "",
        "createdAt": now(), "updatedAt": now(), "submissionIntentAt": null, "submissionObservedAt": null, "cancelRequestedAt": null,
        "upstreamSettled": false, "executionDeadline": now() + 60_000, "input": {}, "inputMediaRefs": [], "resultState": "none",
        "resultRefs": [], "deliveryState": "unseen", "errorCode": null, "metadata": {}, "checkpoint": null, "parentBatchId": null, "stepIndex": null})
}
async fn patch(storage: &Storage, task: &Value, patch: Value) -> Result<Value> {
    storage.request(json!({"kind": "task.patch", "taskId": task["taskId"], "expectedRevision": task["revision"], "patch": patch}), PRINCIPAL).await
}

#[tokio::test]
async fn task_cas_cancellation_and_terminal_state_survive_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("tasks");
    let storage = Storage::open(root.clone(), "task-fixture".into(), true)
        .await
        .unwrap();
    let initial = incoming("task-fixture", "task-1", "request-1");
    assert_eq!(
        storage
            .task(
                TaskCommand::List {
                    query: Default::default()
                },
                ""
            )
            .await
            .unwrap_err()
            .code,
        "UNAUTHORIZED"
    );
    let accepted = storage
        .task(
            TaskCommand::Accept {
                record: Box::new(serde_json::from_value(initial.clone()).unwrap()),
            },
            PRINCIPAL,
        )
        .await
        .unwrap();
    let task = accepted["task"].clone();
    // Invalid wire values must fail before changing a durable task. Missing
    // nullable fields leave state alone; explicit null remains a clearing write.
    for invalid in [
        json!({"status":"runnning"}),
        json!({"status":null}),
        json!({"upstreamSettled":"false"}),
        json!({"deliveryState":null}),
        json!({"metadata":null}),
        json!({"taskId":"replacement"}),
    ] {
        assert!(patch(&storage, &task, invalid).await.is_err());
    }
    let with_error = patch(&storage, &task, json!({"errorCode":"TEMPORARY"}))
        .await
        .unwrap();
    let untouched = patch(&storage, &with_error, json!({"metadata":{"checked":true}}))
        .await
        .unwrap();
    assert_eq!(untouched["errorCode"], "TEMPORARY");
    let task = patch(&storage, &untouched, json!({"errorCode":null}))
        .await
        .unwrap();
    assert!(task["errorCode"].is_null());
    let repeated = storage
        .request(json!({"kind": "task.accept", "record": initial}), PRINCIPAL)
        .await
        .unwrap();
    assert_eq!(repeated["created"], false);
    assert_eq!(repeated["task"], task);
    let changed = storage.request(json!({"kind": "task.accept", "record": incoming("task-fixture", "task-2", "request-2")}), PRINCIPAL).await.unwrap_err();
    assert_eq!(changed.code, "TASK_PROVIDER_BUSY");
    let submitted = patch(
        &storage,
        &task,
        json!({"status": "running", "upstreamId": "job-1", "submissionIntentAt": now()}),
    )
    .await
    .unwrap();
    assert_eq!(
        patch(&storage, &task, json!({"status": "failed"}))
            .await
            .unwrap_err()
            .code,
        "REVISION_CONFLICT"
    );
    assert_eq!(
        patch(&storage, &submitted, json!({"upstreamId": "job-2"}))
            .await
            .unwrap_err()
            .code,
        "TASK_UPSTREAM_CONFLICT"
    );
    let cancelled = storage
        .request(
            json!({"kind": "task.cancel", "requestKey": "request-1"}),
            PRINCIPAL,
        )
        .await
        .unwrap();
    assert_eq!(cancelled["status"], "cancelling");
    let still_cancelling = patch(&storage, &cancelled, json!({"status": "running"}))
        .await
        .unwrap();
    assert_eq!(still_cancelling["status"], "cancelling");
    let terminal = patch(
        &storage,
        &still_cancelling,
        json!({"status": "cancelled", "upstreamSettled": true}),
    )
    .await
    .unwrap();
    // A reconciliation can retain its old observation while cancellation wins
    // the CAS race. Its retry uses the current revision but still carries false.
    let terminal = patch(
        &storage,
        &terminal,
        json!({"status": "running", "upstreamSettled": false}),
    )
    .await
    .unwrap();
    assert_eq!(terminal["status"], "cancelled");
    assert_eq!(terminal["upstreamSettled"], true);
    assert!(
        storage
            .request(
                json!({"kind": "task.cancel", "requestKey": "early-cancel"}),
                PRINCIPAL
            )
            .await
            .unwrap()
            .is_null()
    );
    let old_epoch = storage.runtime_epoch().to_owned();
    storage.close().await.unwrap();
    let reopened = Storage::open(root, "task-fixture".into(), false)
        .await
        .unwrap();
    let current = reopened
        .request(json!({"kind": "task.get", "taskId": "task-1"}), PRINCIPAL)
        .await
        .unwrap();
    assert_ne!(current["runtimeEpoch"], old_epoch);
    assert_eq!(current["status"], "cancelled");
    assert_eq!(current["upstreamSettled"], true);
    // A late unsettled observation must not leave the global admission gate
    // blocked after reopen; another stable request key remains admissible.
    let early = reopened.request(json!({"kind": "task.accept", "record": incoming("task-fixture", "early", "early-cancel")}), PRINCIPAL).await.unwrap();
    assert_eq!(early["task"]["status"], "cancelled");
    assert_eq!(early["task"]["upstreamSettled"], true);
    assert_eq!(
        patch(
            &reopened,
            &early["task"],
            json!({"submissionIntentAt":now(),"status":"submitting"})
        )
        .await
        .unwrap_err()
        .code,
        "CANCELLED"
    );
    assert!(
        reopened
            .request(json!({"kind":"task.get","taskId":"early"}), PRINCIPAL)
            .await
            .unwrap()["submissionIntentAt"]
            .is_null()
    );
    assert!(
        reopened
            .request(
                json!({"kind": "task.get", "taskId": "task-1"}),
                "another-principal"
            )
            .await
            .unwrap()
            .is_null()
    );
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn protected_input_and_interrupted_output_keep_leases_until_commit() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("tasks");
    let storage = Storage::open(root.clone(), "task-fixture".into(), true)
        .await
        .unwrap();
    storage.request(json!({"kind": "task.accept", "record": incoming("task-fixture", "media-task", "media-request")}), PRINCIPAL).await.unwrap();
    let bytes = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=").unwrap();
    let input = json!({"alias": format!("task-input-{}", canonical::digest("input:media-task:source")), "sha256": canonical::digest(&bytes), "bytes": bytes.len(), "mime": "image/png"});
    storage.request(json!({"kind": "task.input.prepare", "taskId": "media-task", "name": "source", "media": input}), PRINCIPAL).await.unwrap();
    storage.request(json!({"kind": "task.input.chunk", "taskId": "media-task", "name": "source", "offset": 0, "data": STANDARD.encode(&bytes)}), PRINCIPAL).await.unwrap();
    assert!(
        storage
            .request(
                json!({"kind": "task.input.get", "taskId": "media-task", "name": "source"}),
                PRINCIPAL
            )
            .await
            .unwrap()
            .is_null()
    );
    storage
        .request(
            json!({"kind": "task.input.commit", "taskId": "media-task", "name": "source"}),
            PRINCIPAL,
        )
        .await
        .unwrap();
    let output = json!({"alias": "task-media-task-0", "sha256": canonical::digest(&bytes), "bytes": bytes.len(), "mime": "image/png", "index": 0});
    storage
        .request(
            json!({"kind": "task.result.prepare", "taskId": "media-task", "media": output}),
            PRINCIPAL,
        )
        .await
        .unwrap();
    storage.request(json!({"kind": "task.result.chunk", "taskId": "media-task", "index": 0, "offset": 0, "data": STANDARD.encode(&bytes)}), PRINCIPAL).await.unwrap();
    storage.close().await.unwrap();
    let database = rusqlite::Connection::open_with_flags(
        root.join("huiyu.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        database
            .query_row(
                "SELECT count(*) FROM leases WHERE kind='task-result'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
    assert_eq!(
        database
            .query_row(
                "SELECT count(*) FROM leases WHERE kind='task-input'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    drop(database);
    let storage = Storage::open(root.clone(), "task-fixture".into(), false)
        .await
        .unwrap();
    let committed = storage
        .request(
            json!({"kind": "task.result.commit", "taskId": "media-task", "index": 0}),
            PRINCIPAL,
        )
        .await
        .unwrap();
    assert_eq!(committed["resultState"], "available");
    assert_eq!(committed["resultRefs"], json!([output]));
    assert_eq!(committed["inputMediaRefs"], json!([input["alias"]]));
    assert_eq!(
        patch(&storage, &committed, json!({"deliveryState": "discarded"}))
            .await
            .unwrap_err()
            .code,
        "TASK_DISCARD_UNSAFE"
    );
    let settled = patch(
        &storage,
        &committed,
        json!({"status": "succeeded", "upstreamSettled": true}),
    )
    .await
    .unwrap();
    let discarded = patch(&storage, &settled, json!({"deliveryState": "discarded"}))
        .await
        .unwrap();
    assert_eq!(discarded["resultRefs"], json!([]));
    assert_eq!(discarded["resultState"], "unavailable");
    storage.close().await.unwrap();
    let database = rusqlite::Connection::open_with_flags(
        root.join("huiyu.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        database
            .query_row("SELECT count(*) FROM leases", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        database
            .query_row(
                "SELECT count(*) FROM media_refs WHERE owner_kind='task-result'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
    assert_eq!(
        database
            .query_row(
                "SELECT count(*) FROM media_refs WHERE owner_kind='task-input'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        1
    );
}

mod paging;

#[tokio::test]
async fn discarded_task_releases_pending_output_without_publishing_it() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("tasks");
    let storage = Storage::open(root.clone(), "task-fixture".into(), true)
        .await
        .unwrap();
    storage
        .request(
            json!({"kind":"task.accept","record":incoming("task-fixture","discard-task","discard-request")}),
            PRINCIPAL,
        )
        .await
        .unwrap();
    let original = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1cAAAAASUVORK5CYII=").unwrap();
    let mut pending = original.clone();
    pending.push(0);
    for (index, bytes) in [original, pending.clone()].into_iter().enumerate() {
        storage
            .request(
                json!({"kind":"task.result.prepare","taskId":"discard-task","media":{"alias":format!("task-discard-task-{index}"),"index":index,"sha256":canonical::digest(&bytes),"bytes":bytes.len(),"mime":"image/png"}}),
                PRINCIPAL,
            )
            .await
            .unwrap();
        storage
            .request(
                json!({"kind":"task.result.chunk","taskId":"discard-task","index":index,"offset":0,"data":STANDARD.encode(bytes)}),
                PRINCIPAL,
            )
            .await
            .unwrap();
    }
    let available = storage
        .request(
            json!({"kind":"task.result.commit","taskId":"discard-task","index":0}),
            PRINCIPAL,
        )
        .await
        .unwrap();
    let settled = patch(
        &storage,
        &available,
        json!({"status":"succeeded","upstreamSettled":true}),
    )
    .await
    .unwrap();
    let discarded = patch(&storage, &settled, json!({"deliveryState":"discarded"}))
        .await
        .unwrap();
    assert_eq!(discarded["resultState"], "unavailable");
    let late = storage
        .request(
            json!({"kind":"task.result.commit","taskId":"discard-task","index":1}),
            PRINCIPAL,
        )
        .await;
    assert_eq!(late.unwrap_err().code, "TASK_RESULT_DISCARDED");
    assert!(
        !media::object_path(&root, &canonical::digest(&pending))
            .unwrap()
            .exists()
    );
    let staged = media::staging_path(
        &root,
        &canonical::digest("task:discard-task:1"),
        "task-discard-task-1",
    )
    .unwrap();
    std::fs::OpenOptions::new()
        .write(true)
        .open(&staged)
        .unwrap()
        .set_modified(std::time::UNIX_EPOCH)
        .unwrap();
    storage
        .request(
            json!({"kind":"collectGarbage","operationId":"discarded-output-gc"}),
            PRINCIPAL,
        )
        .await
        .unwrap();
    assert!(!staged.exists(), "Discarded staging must be reclaimable");
    storage.close().await.unwrap();
    let database = rusqlite::Connection::open_with_flags(
        root.join("huiyu.sqlite3"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )
    .unwrap();
    assert_eq!(
        database
            .query_row(
                "SELECT count(*) FROM leases WHERE kind='task-result'",
                [],
                |r| r.get::<_, i64>(0)
            )
            .unwrap(),
        0
    );
}
