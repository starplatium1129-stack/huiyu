use super::*;

#[tokio::test]
async fn unchanged_patch_preserves_revision_and_still_enforces_submission_and_cas() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("workspace"), "fixture".into(), true)
        .await
        .unwrap();
    let accepted = storage
        .request(
            json!({"kind":"task.accept", "record": incoming("fixture", "a", "a")}),
            PRINCIPAL,
        )
        .await
        .unwrap();
    let task = accepted["task"].clone();
    let unchanged = patch(
        &storage,
        &task,
        json!({"status":"queued", "metadata":{}, "checkpoint":null}),
    )
    .await
    .unwrap();
    assert_eq!(unchanged, task);
    let submitted = patch(
        &storage,
        &task,
        json!({"submissionIntentAt": 123, "status":"running"}),
    )
    .await
    .unwrap();
    assert!(submitted["revision"].as_i64().unwrap() > task["revision"].as_i64().unwrap());
    assert_eq!(
        patch(&storage, &task, json!({})).await.unwrap_err().code,
        "REVISION_CONFLICT"
    );
    assert_eq!(
        patch(&storage, &submitted, json!({"submissionIntentAt":123}))
            .await
            .unwrap_err()
            .code,
        "TASK_SUBMISSION_REPLAY"
    );
    let cancelled = storage
        .request(json!({"kind":"task.cancel", "requestKey":"a"}), PRINCIPAL)
        .await
        .unwrap();
    assert_eq!(
        patch(&storage, &cancelled, json!({"status":"running"}))
            .await
            .unwrap(),
        cancelled
    );
    assert_eq!(
        patch(&storage, &cancelled, json!({"submissionIntentAt":123}))
            .await
            .unwrap_err()
            .code,
        "CANCELLED"
    );
    storage.close().await.unwrap();
}

#[tokio::test]
async fn pages_and_incremental_reads_do_not_lose_interleaved_updates() {
    let directory = tempfile::tempdir().unwrap();
    let storage = Storage::open(directory.path().join("workspace"), "fixture".into(), true)
        .await
        .unwrap();
    let mut tasks = Vec::new();
    for id in ["a", "b", "c", "d"] {
        let mut record = incoming("fixture", id, id);
        record["upstreamSettled"] = json!(true);
        record["status"] = json!("succeeded");
        record["resultState"] = json!(if id == "a" { "none" } else { "available" });
        let accepted = storage
            .request(json!({"kind":"task.accept", "record": record}), PRINCIPAL)
            .await
            .unwrap();
        tasks.push(accepted["task"].clone());
    }
    let first = storage
        .request(json!({"kind":"task.list", "limit":2}), PRINCIPAL)
        .await
        .unwrap();
    assert_eq!(first["items"][0]["taskId"], "d");
    assert_eq!(first["items"][1]["taskId"], "c");
    let updated = patch(&storage, &tasks[0], json!({"metadata":{"changed":true}}))
        .await
        .unwrap();
    let second = storage.request(json!({"kind":"task.list", "limit":2, "before":first["nextCursor"], "throughRevision":first["throughRevision"]}), PRINCIPAL).await.unwrap();
    assert_eq!(second["items"].as_array().unwrap().len(), 1);
    assert_eq!(second["items"][0]["taskId"], "b");
    assert!(second["nextCursor"].is_null());
    let changed = storage
        .request(
            json!({"kind":"task.list", "afterRevision":first["throughRevision"]}),
            PRINCIPAL,
        )
        .await
        .unwrap();
    assert_eq!(changed["items"], json!([updated]));
    let other = storage
        .request(json!({"kind":"task.list"}), "other-principal")
        .await
        .unwrap();
    assert_eq!(other["items"], json!([]));
    let recovery = storage
        .request(json!({"kind":"task.list", "recoverable":true}), PRINCIPAL)
        .await
        .unwrap();
    assert_eq!(recovery["items"], json!([updated]));
    // A one-shot recovery cursor must remain stable when another reconcile
    // changes the revision of a candidate that has not been scanned yet.
    let b = patch(&storage, &tasks[1], json!({"resultState":"none"}))
        .await
        .unwrap();
    let recovery_first = storage
        .request(
            json!({"kind":"task.list", "recoverable":true, "limit":1}),
            PRINCIPAL,
        )
        .await
        .unwrap();
    assert_eq!(recovery_first["items"][0]["taskId"], "b");
    let a = patch(&storage, &updated, json!({"metadata":{"again":true}}))
        .await
        .unwrap();
    let recovery_second = storage.request(json!({"kind":"task.list", "recoverable":true, "limit":1, "before":recovery_first["nextCursor"], "throughRevision":recovery_first["throughRevision"]}), PRINCIPAL).await.unwrap();
    assert_eq!(recovery_second["items"], json!([a]));
    assert!(recovery_second["nextCursor"].is_null());
    assert_eq!(b["taskId"], "b");
    assert!(
        storage
            .request(json!({"kind":"task.list", "limit":201}), PRINCIPAL)
            .await
            .is_err()
    );
    let db = rusqlite::Connection::open(directory.path().join("workspace/huiyu.sqlite3")).unwrap();
    for (sql, index) in [
        (
            "SELECT record_json FROM tasks WHERE principal_id='test' AND json_extract(record_json,'$.revision')>0 AND json_extract(record_json,'$.revision')<=100 AND json_extract(record_json,'$.revision')<100 ORDER BY json_extract(record_json,'$.revision') DESC LIMIT 101",
            "tasks_revision",
        ),
        (
            "SELECT record_json FROM tasks WHERE principal_id='test' AND rowid>0 AND rowid<=100 AND rowid<100 AND json_extract(record_json,'$.deliveryState') != 'discarded' AND (upstream_settled=0 OR (json_extract(record_json,'$.status')='succeeded' AND json_extract(record_json,'$.resultState')!='available')) ORDER BY rowid DESC LIMIT 101",
            "tasks_recovery_scan",
        ),
    ] {
        let mut query = db.prepare(&format!("EXPLAIN QUERY PLAN {sql}")).unwrap();
        let plan = query
            .query_map([], |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap()
            .join(" ");
        assert!(plan.contains(index), "{plan}");
        assert!(!plan.contains("TEMP B-TREE"), "{plan}");
    }
    drop(db);
    storage.close().await.unwrap();
}
