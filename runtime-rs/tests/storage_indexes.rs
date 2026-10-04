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
    assert_media_indexes(root);
    let db = Connection::open(root.join("huiyu.sqlite3")).unwrap();
    for sql in [
        "SELECT id_json,body,revision,deleted_at,id_key FROM artworks WHERE id_key>'' AND deleted_at IS NULL ORDER BY id_key LIMIT 201",
        "SELECT id_json,json_object('timestamp',body -> '$.timestamp'),revision FROM artworks WHERE deleted_at IS NULL ORDER BY id_key",
    ] {
        let plan: String = db
            .query_row(&format!("EXPLAIN QUERY PLAN {sql}"), [], |r| r.get(3))
            .unwrap();
        assert!(plan.contains("artworks_live_id"), "{plan}");
    }
    let plan: String = db
        .query_row(&format!("EXPLAIN QUERY PLAN {LOOKUP}"), ["17"], |r| {
            r.get(3)
        })
        .unwrap();
    assert!(
        plan.contains("SEARCH") && plan.contains("project_artworks_artwork"),
        "{plan}"
    );
    let admission: String = db
        .query_row(
            "EXPLAIN QUERY PLAN SELECT task_id FROM tasks WHERE upstream_settled=0 LIMIT 1",
            [],
            |r| r.get(3),
        )
        .unwrap();
    assert!(
        admission.contains("COVERING INDEX tasks_unsettled"),
        "{admission}"
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

fn assert_media_indexes(root: &Path) -> Vec<String> {
    let db = Connection::open(root.join("huiyu.sqlite3")).unwrap();
    db.pragma_update(None, "foreign_keys", true).unwrap();
    for sql in [
        "DELETE FROM media_aliases WHERE hash=?",
        "DELETE FROM media_objects WHERE hash=?",
    ] {
        let plan: Vec<String> = db
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .unwrap()
            .query_map(["missing"], |r| r.get(3))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert!(
            !plan.iter().any(|row| row.contains("SCAN media_")),
            "{plan:?}"
        );
        assert!(
            plan.iter().any(|row| row.contains("media_aliases_hash")),
            "{plan:?}"
        );
        if sql.contains("media_objects") {
            assert!(
                plan.iter().any(|row| row.contains("media_refs_hash")),
                "{plan:?}"
            );
        }
    }
    ["media_aliases_hash", "media_refs_hash"]
        .into_iter()
        .map(|name| {
            db.query_row("SELECT sql FROM sqlite_master WHERE name=?", [name], |r| {
                r.get(0)
            })
            .unwrap()
        })
        .collect()
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
        .execute_batch("DROP INDEX artworks_live_id; DROP INDEX project_artworks_artwork; DROP INDEX media_aliases_hash; DROP INDEX media_refs_hash; DROP INDEX tasks_unsettled")
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

// Real bundled SQLite mechanism measurement; no filesystem GC or timing gate.
#[tokio::test]
#[ignore = "manual isolated SQL timing experiment"]
async fn benchmark_media_gc_reverse_indexes() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("workspace");
    let storage = Storage::open(root.clone(), "media-gc-bench".into(), true)
        .await
        .unwrap();
    storage.close().await.unwrap();
    let indexes = assert_media_indexes(&root);
    let mut db = Connection::open_in_memory().unwrap();
    db.execute_batch(include_str!("../src/storage/schema.sql"))
        .unwrap();
    db.pragma_update(None, "foreign_keys", true).unwrap();
    let tx = db.transaction().unwrap();
    {
        let mut objects = tx
            .prepare("INSERT INTO media_objects VALUES(?,1,'image/png')")
            .unwrap();
        let mut aliases = tx.prepare("INSERT INTO media_aliases VALUES(?,?)").unwrap();
        let mut refs = tx
            .prepare("INSERT INTO media_refs VALUES('artwork',?,?)")
            .unwrap();
        for i in 0..50_000 {
            let hash = format!("{i:064x}");
            objects.execute([&hash]).unwrap();
            aliases
                .execute(rusqlite::params![format!("alias-{i}"), hash])
                .unwrap();
            if i < 25_000 {
                refs.execute(rusqlite::params![i.to_string(), hash])
                    .unwrap();
            }
        }
    }
    tx.commit().unwrap();
    let keys: Vec<_> = (49_800..50_000).map(|i| format!("{i:064x}")).collect();
    for phase in ["before", "after"] {
        if phase == "after" {
            for sql in &indexes {
                db.execute_batch(sql).unwrap();
            }
        }
        let plans: Vec<Value> = [
            "DELETE FROM media_aliases WHERE hash=?",
            "DELETE FROM media_objects WHERE hash=?",
        ]
        .into_iter()
        .map(|sql| {
            let rows: Vec<String> = db
                .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
                .unwrap()
                .query_map([&keys[0]], |r| r.get(3))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap();
            json!({"sql":sql,"plan":rows})
        })
        .collect();
        let mut samples = Vec::new();
        for _ in 0..3 {
            let tx = db.transaction().unwrap();
            let started = Instant::now();
            {
                let mut aliases = tx
                    .prepare("DELETE FROM media_aliases WHERE hash=?")
                    .unwrap();
                let mut objects = tx
                    .prepare("DELETE FROM media_objects WHERE hash=?")
                    .unwrap();
                for hash in &keys {
                    assert_eq!(aliases.execute([hash]).unwrap(), 1);
                    assert_eq!(objects.execute([hash]).unwrap(), 1);
                }
            }
            samples.push(started.elapsed().as_secs_f64() * 1000.0);
            tx.rollback().unwrap();
        }
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM media_objects", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            50_000
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM media_refs", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            25_000
        );
        println!(
            "{}",
            json!({"phase":phase,"sqliteVersion":rusqlite::version(),"objects":50000,"aliases":50000,"refs":25000,"deletions":200,"samplesMs":samples,"plans":plans})
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
    // Deleted rows must leave the live index while the all-records cursor still
    // sees them. Both body projections keep the same cursor/revision contract.
    for projection in [Value::Null, json!("preference")] {
        let first_page = request(
            &storage,
            json!({"kind":"listArtworks","projection":projection,"limit":1}),
        )
        .await;
        assert_eq!(first_page["items"][0]["id"], 2);
        assert_eq!(first_page["nextCursor"], "2");
        let next_page = request(&storage, json!({"kind":"listArtworks","projection":projection,"limit":1,"cursor":first_page["nextCursor"]})).await;
        assert_eq!(next_page["items"][0]["id"], 3);
        assert!(next_page["nextCursor"].is_null());
        assert_eq!(next_page["revision"], first_page["revision"]);
    }
    let all = request(
        &storage,
        json!({"kind":"listArtworks","includeDeleted":true,"limit":1}),
    )
    .await;
    assert_eq!(all["items"][0]["id"], 1);
    assert!(!all["items"][0]["deletedAt"].is_null());
    assert_eq!(all["nextCursor"], "1");
    request(&storage, json!({"kind":"restoreArtwork","operationId":"undo","id":1,"expectedRevision":deleted["revision"]})).await;
    assert_eq!(members(&storage).await, json!([[3, 1, 2], [2, 1]]));
    let restored_page = request(&storage, json!({"kind":"listArtworks","limit":1})).await;
    assert_eq!(restored_page["items"][0]["id"], 1);
    assert!(restored_page["items"][0]["deletedAt"].is_null());
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
