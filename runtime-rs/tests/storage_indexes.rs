use base64::{Engine, engine::general_purpose::STANDARD};
use huiyu_runtime::storage::Storage;
use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{path::Path, time::Instant};

const LOOKUP: &str = "SELECT project_key,position FROM project_artworks WHERE artwork_key=?";

async fn request(storage: &Storage, command: Value) -> Value {
    storage
        .request(command, "desktop:index-test")
        .await
        .unwrap()
}

fn assert_index(root: &Path) -> String {
    let db = Connection::open(root.join("huiyu.sqlite3")).unwrap();
    let plan: String = db
        .query_row(&format!("EXPLAIN QUERY PLAN {LOOKUP}"), ["17"], |r| {
            r.get(3)
        })
        .unwrap();
    assert!(
        plan.contains("SEARCH") && plan.contains("project_artworks_artwork"),
        "{plan}"
    );
    let version: i64 = db
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert_eq!(version, 3);
    let migrations: i64 = db
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |r| {
            r.get(0)
        })
        .unwrap();
    assert_eq!(migrations, 3);
    db.query_row(
        "SELECT sql FROM sqlite_master WHERE name='project_artworks_artwork'",
        [],
        |r| r.get(0),
    )
    .unwrap()
}

#[tokio::test]
async fn new_and_existing_v3_workspaces_receive_reverse_index_without_revision_change() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("workspace");
    let storage = Storage::open(root.clone(), "index-test".into(), true)
        .await
        .unwrap();
    let status = request(&storage, json!({"kind":"status"})).await;
    storage.close().await.unwrap();
    assert_index(&root);
    let identity = std::fs::read(root.join("workspace.json")).unwrap();
    Connection::open(root.join("huiyu.sqlite3"))
        .unwrap()
        .execute_batch("DROP INDEX project_artworks_artwork")
        .unwrap();
    for _ in 0..2 {
        let storage = Storage::open(root.clone(), "index-test".into(), false)
            .await
            .unwrap();
        let reopened = request(&storage, json!({"kind":"status"})).await;
        assert_eq!(reopened["revision"], status["revision"]);
        assert_eq!(reopened["schemaVersion"], 3);
        storage.close().await.unwrap();
        assert_index(&root);
        assert_eq!(
            std::fs::read(root.join("workspace.json")).unwrap(),
            identity
        );
    }
}

async fn save(storage: &Storage, id: i64) -> Value {
    let bytes = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=").unwrap();
    let op = format!("save-{id}");
    let media = json!({"alias":format!("image-{id}"),"sha256":hex::encode(Sha256::digest(&bytes)),"bytes":bytes.len(),"mime":"image/png"});
    request(
        storage,
        json!({"kind":"prepareSave","operationId":op,"artwork":{"id":id},"media":media}),
    )
    .await;
    request(
        storage,
        json!({"kind":"uploadChunk","operationId":op,"offset":0,"data":STANDARD.encode(bytes)}),
    )
    .await;
    request(storage, json!({"kind":"commitSave","operationId":op})).await
}

async fn members(storage: &Storage) -> Value {
    let projects = request(storage, json!({"kind":"listProjects"})).await;
    json!(
        projects["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| p["body"]["history_ids"].clone())
            .collect::<Vec<_>>()
    )
}

#[tokio::test]
async fn indexed_deletion_preserves_membership_order_and_backup_restore() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("workspace");
    let storage = Storage::open(root.clone(), "index-test".into(), true)
        .await
        .unwrap();
    let first = save(&storage, 1).await;
    let second = save(&storage, 2).await;
    save(&storage, 3).await;
    for (id, ids) in [("p", json!([3, 1, 2])), ("q", json!([2, 1]))] {
        request(&storage, json!({"kind":"saveProject","operationId":id,"project":{"id":id},"artworkIds":ids,"expectedRevision":null})).await;
    }
    let deleted = request(&storage, json!({"kind":"softDeleteArtworks","operationId":"soft","items":[{"id":1,"expectedRevision":first["revision"]}]})).await;
    assert_eq!(deleted["softDeleteResults"][0]["deleted"], true);
    assert_eq!(members(&storage).await, json!([[3, 2], [2]]));
    request(&storage, json!({"kind":"restoreArtwork","operationId":"undo","id":1,"expectedRevision":deleted["revision"]})).await;
    assert_eq!(members(&storage).await, json!([[3, 1, 2], [2, 1]]));
    request(&storage, json!({"kind":"hardDeleteArtwork","operationId":"hard","id":2,"expectedRevision":second["revision"]})).await;
    assert_eq!(members(&storage).await, json!([[3, 1], [1]]));
    assert!(
        request(&storage, json!({"kind":"getArtwork","id":2}))
            .await
            .is_null()
    );
    let backup = request(&storage, json!({"kind":"backup","operationId":"backup"})).await;
    let candidate = request(
        &storage,
        json!({"kind":"restoreBackup","operationId":"restore","backupId":backup["backupId"]}),
    )
    .await;
    let restored_root = root
        .join("restore-candidates")
        .join(candidate["candidateId"].as_str().unwrap());
    storage.close().await.unwrap();
    assert_index(&restored_root);
    let restored = Storage::open(restored_root.clone(), "index-test".into(), false)
        .await
        .unwrap();
    assert_eq!(members(&restored).await, json!([[3, 1], [1]]));
    restored.close().await.unwrap();
    assert_index(&restored_root);
}

// Isolated query mechanism benchmark, not end-to-end deletion latency. Run alone:
// cargo test --test storage_indexes benchmark_reverse_lookup -- --ignored --nocapture
#[tokio::test]
#[ignore = "manual timing experiment; no wall-clock pass threshold"]
async fn benchmark_reverse_lookup() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("workspace");
    let storage = Storage::open(root.clone(), "index-bench".into(), true)
        .await
        .unwrap();
    storage.close().await.unwrap();
    let index_sql = assert_index(&root);
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("../src/storage/schema.sql"))
        .unwrap();
    // No foreign-key references are dereferenced by this lookup-only fixture.
    db.execute_batch("PRAGMA foreign_keys=OFF").unwrap();
    let tx = db.transaction().unwrap();
    {
        let mut insert = tx
            .prepare("INSERT INTO project_artworks VALUES(?,?,?)")
            .unwrap();
        for i in 0..100_000 {
            insert
                .execute(rusqlite::params![
                    format!("p{}", i / 100),
                    format!("a{i}"),
                    i % 100
                ])
                .unwrap();
        }
    }
    tx.commit().unwrap();
    let keys: Vec<String> = (0..200).map(|i| format!("a{}", i * 499)).collect();
    for label in ["before", "after"] {
        if label == "after" {
            db.execute_batch(&index_sql).unwrap();
        }
        let plan: String = db
            .query_row(&format!("EXPLAIN QUERY PLAN {LOOKUP}"), [&keys[0]], |r| {
                r.get(3)
            })
            .unwrap();
        let mut query = db.prepare(LOOKUP).unwrap();
        let lookup = |query: &mut rusqlite::Statement<'_>, key: &str| {
            query
                .query_row([key], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))
                .unwrap()
        };
        for key in keys.iter().take(20) {
            std::hint::black_box(lookup(&mut query, key));
        }
        let mut samples = Vec::new();
        for _ in 0..3 {
            let started = Instant::now();
            let result: Vec<_> = keys.iter().map(|key| lookup(&mut query, key)).collect();
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
            for (i, row) in result.iter().enumerate() {
                assert_eq!(
                    row,
                    &(format!("p{}", i * 499 / 100), (i * 499 % 100) as i64)
                );
            }
        }
        println!(
            "{}",
            json!({"phase":label,"rows":100000,"lookups":keys.len(),"samplesMs":samples,"queryPlan":plan})
        );
    }
}
