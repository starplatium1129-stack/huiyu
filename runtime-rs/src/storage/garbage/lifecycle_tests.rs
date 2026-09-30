use super::*;
use std::{
    fs::File,
    time::{Duration, SystemTime},
};

fn fixture() -> (tempfile::TempDir, Context) {
    let directory = tempfile::tempdir().unwrap();
    let context = schema::open(
        directory.path().join("workspace"),
        "gc-discovery".into(),
        "gc-epoch".into(),
        true,
    )
    .unwrap();
    (directory, context)
}
fn object(c: &Context, name: &str, old: bool) -> (String, PathBuf) {
    let hash = digest(name);
    let file = media::object_path(&c.root, &hash).unwrap();
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, name).unwrap();
    if old {
        File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(
                SystemTime::now() - Duration::from_millis(records::RETENTION as u64 + 60_000),
            ))
            .unwrap();
    }
    c.db.execute(
        "INSERT INTO media_objects VALUES(?,?,'image/png')",
        rusqlite::params![hash, name.len() as i64],
    )
    .unwrap();
    (hash, file)
}
fn discover_job(c: &mut Context, id: &str) -> Box<Discovery> {
    match prepare(
        c,
        "test",
        &json!({"kind":"collectGarbage","operationId":id}),
    )
    .unwrap()
    {
        Prepared::Discover(job) => job,
        _ => panic!("expected discovery"),
    }
}
#[test]
fn live_references_leases_and_retention_override_discovered_candidates() {
    let (_directory, mut c) = fixture();
    let (referenced, referenced_file) = object(&c, "referenced", true);
    let (leased, leased_file) = object(&c, "leased", true);
    let (_expired, expired_file) = object(&c, "expired", true);
    let (_recent, recent_file) = object(&c, "recent", false);
    let missing = digest("missing");
    c.db.execute(
        "INSERT INTO media_objects VALUES(?,1,'image/png')",
        [&missing],
    )
    .unwrap();
    let job = discover_job(&mut c, "recheck");
    let candidates = job.run().unwrap();
    assert!(
        expired_file.exists(),
        "background discovery must not unlink"
    );
    c.db.execute(
        "INSERT INTO media_refs VALUES('temporary','live',?)",
        [&referenced],
    )
    .unwrap();
    c.db.execute(
        "INSERT INTO leases VALUES('live','media',?,NULL,0)",
        [&leased],
    )
    .unwrap();
    c.db.execute(
        "INSERT INTO media_refs VALUES('temporary','missing-live',?)",
        [&missing],
    )
    .unwrap();
    let receipt = finish(&mut c, job.completion, Ok(candidates)).unwrap();
    assert_eq!(receipt["removed"], 1);
    assert!(referenced_file.exists() && leased_file.exists() && recent_file.exists());
    assert!(!expired_file.exists());
    assert_eq!(
        c.db.query_row(
            "SELECT count(*) FROM media_objects WHERE hash=?",
            [&missing],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert!(
        matches!(prepare(&mut c,"test",&json!({"kind":"collectGarbage","operationId":"recheck"})).unwrap(),Prepared::Complete(value) if value==receipt)
    );
    c.shutdown().unwrap();
}
#[test]
fn replaced_files_and_newly_created_missing_objects_are_retained() {
    let (_directory, mut c) = fixture();
    let (_hash, file) = object(&c, "replace", true);
    let missing = digest("missing");
    c.db.execute(
        "INSERT INTO media_objects VALUES(?,1,'image/png')",
        [&missing],
    )
    .unwrap();
    let job = discover_job(&mut c, "replace");
    let candidates = job.run().unwrap();
    let held = file.with_extension("held");
    fs::rename(&file, &held).unwrap();
    fs::write(&file, b"replace").unwrap();
    let old = fs::metadata(&held).unwrap().modified().unwrap();
    File::options()
        .write(true)
        .open(&file)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(old))
        .unwrap();
    let new_file = media::object_path(&c.root, &missing).unwrap();
    fs::create_dir_all(new_file.parent().unwrap()).unwrap();
    fs::write(&new_file, b"new").unwrap();
    assert_eq!(
        finish(&mut c, job.completion, Ok(candidates)).unwrap()["removed"],
        0
    );
    assert!(file.exists() && new_file.exists());
    c.shutdown().unwrap();
}
#[test]
fn owner_replacement_and_writer_epoch_changes_reject_publication() {
    let (_directory, mut c) = fixture();
    let (_hash, file) = object(&c, "retained", true);
    let job = discover_job(&mut c, "owner");
    let candidates = job.run().unwrap();
    let owner = c.root.join(".workspace-owner.json");
    let bytes = fs::read(&owner).unwrap();
    let held = c.root.join("owner-held.json");
    fs::rename(&owner, &held).unwrap();
    fs::write(&owner, &bytes).unwrap();
    assert_eq!(
        finish(&mut c, job.completion, Ok(candidates))
            .unwrap_err()
            .code,
        "WORKSPACE_IDENTITY"
    );
    assert!(file.exists());
    fs::remove_file(&owner).unwrap();
    fs::rename(held, owner).unwrap();
    let job = discover_job(&mut c, "epoch");
    let candidates = job.run().unwrap();
    c.db.execute(
        "UPDATE meta SET value='other-writer' WHERE key='writerEpoch'",
        [],
    )
    .unwrap();
    assert_eq!(
        finish(&mut c, job.completion, Ok(candidates))
            .unwrap_err()
            .code,
        "WRITER_EPOCH"
    );
    assert!(file.exists());
    c.db.execute(
        "UPDATE meta SET value=? WHERE key='writerEpoch'",
        [&c.epoch],
    )
    .unwrap();
    assert_eq!(c.revision().unwrap(), 0);
    c.shutdown().unwrap();
}

async fn paused(
    storage: &Storage,
    id: &str,
) -> (
    tokio::task::JoinHandle<Result<Value>>,
    std::sync::mpsc::SyncSender<()>,
    oneshot::Receiver<()>,
) {
    let (entered, ready) = oneshot::channel();
    let (resume, resume_rx) = std::sync::mpsc::sync_channel(1);
    let (finished, completed) = oneshot::channel();
    storage
        .sender
        .send(Work::PauseGarbage(worker::GarbagePause {
            entered,
            resume: resume_rx,
            finished,
        }))
        .await
        .unwrap();
    let caller = storage.clone();
    let id = id.to_owned();
    let request = tokio::spawn(async move {
        caller
            .request(json!({"kind":"collectGarbage","operationId":id}), "test")
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), ready)
        .await
        .unwrap()
        .unwrap();
    (request, resume, completed)
}
#[tokio::test]
async fn discovery_releases_the_writer_and_bounds_reentrancy_without_losing_receipts() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("workspace");
    let storage = Storage::open(root, "gc-actor".into(), true).await.unwrap();
    let previous = storage
        .request(
            json!({"kind":"collectGarbage","operationId":"previous"}),
            "test",
        )
        .await
        .unwrap();
    let (gc, resume, completed) = paused(&storage, "active").await;
    assert!(
        tokio::time::timeout(
            Duration::from_secs(1),
            storage.request(json!({"kind":"status"}), "test")
        )
        .await
        .unwrap()
        .is_ok()
    );
    assert_eq!(
        storage
            .request(
                json!({"kind":"collectGarbage","operationId":"previous"}),
                "test"
            )
            .await
            .unwrap(),
        previous
    );
    assert_eq!(
        storage
            .request(
                json!({"kind":"collectGarbage","operationId":"second"}),
                "test"
            )
            .await
            .unwrap_err()
            .code,
        "WORKSPACE_BUSY"
    );
    assert!(
        storage
            .request(
                json!({"kind":"getOperation","operationId":"second"}),
                "test"
            )
            .await
            .unwrap()
            .is_null()
    );
    resume.send(()).unwrap();
    completed.await.unwrap();
    gc.await.unwrap().unwrap();
    storage.close().await.unwrap();
}
#[tokio::test]
async fn caller_cancellation_and_close_wait_for_discovery_and_reject_its_late_result() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("workspace");
    let initial = Storage::open(root.clone(), "gc-close".into(), true)
        .await
        .unwrap();
    initial.close().await.unwrap();
    let mut c = schema::open(root.clone(), "gc-close".into(), "fixture".into(), false).unwrap();
    let (_hash, file) = object(&c, "expired", true);
    c.shutdown().unwrap();
    drop(c);
    let storage = Storage::open(root.clone(), "gc-close".into(), false)
        .await
        .unwrap();
    let (cancelled, resume, completed) = paused(&storage, "cancelled").await;
    cancelled.abort();
    let _ = cancelled.await;
    resume.send(()).unwrap();
    completed.await.unwrap();
    let state = storage
        .request(
            json!({"kind":"getOperation","operationId":"cancelled"}),
            "test",
        )
        .await
        .unwrap();
    assert_eq!(state["state"], "prepared");
    assert!(state.get("receipt").is_none());
    assert!(file.exists());
    let (gc, resume, completed) = paused(&storage, "closing").await;
    let close = storage.close();
    tokio::pin!(close);
    assert!(
        tokio::time::timeout(Duration::from_millis(10), &mut close)
            .await
            .is_err()
    );
    assert_eq!(
        storage
            .request(json!({"kind":"status"}), "test")
            .await
            .unwrap_err()
            .code,
        "STORAGE_UNAVAILABLE"
    );
    assert!(root.join(".workspace-owner.json").exists());
    resume.send(()).unwrap();
    completed.await.unwrap();
    assert_eq!(gc.await.unwrap().unwrap_err().code, "CANCELLED");
    tokio::time::timeout(Duration::from_secs(3), &mut close)
        .await
        .unwrap()
        .unwrap();
    assert!(file.exists());
    assert!(!root.join(".workspace-owner.json").exists());
    let reopened = Storage::open(root, "gc-close".into(), false).await.unwrap();
    assert_eq!(
        reopened
            .request(
                json!({"kind":"collectGarbage","operationId":"closing"}),
                "test"
            )
            .await
            .unwrap()["removed"],
        1
    );
    assert!(!file.exists());
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn close_keeps_ownership_until_both_discovery_and_backup_finish() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("workspace");
    let storage = Storage::open(root.clone(), "gc-and-copy".into(), true)
        .await
        .unwrap();
    let (gc, gc_resume, gc_finished) = paused(&storage, "collect").await;
    let (entered, ready) = oneshot::channel();
    let (resume, resume_rx) = std::sync::mpsc::sync_channel(1);
    let (finished, completed) = oneshot::channel();
    storage
        .sender
        .send(Work::PauseCopy(worker::CopyPause {
            entered,
            resume: resume_rx,
            finished,
        }))
        .await
        .unwrap();
    let caller = storage.clone();
    let copy = tokio::spawn(async move {
        caller
            .request(json!({"kind":"backup","operationId":"copy"}), "test")
            .await
    });
    tokio::time::timeout(Duration::from_secs(3), ready)
        .await
        .unwrap()
        .unwrap();
    let close = storage.close();
    tokio::pin!(close);
    assert!(
        tokio::time::timeout(Duration::from_millis(10), &mut close)
            .await
            .is_err()
    );
    gc_resume.send(()).unwrap();
    gc_finished.await.unwrap();
    assert_eq!(gc.await.unwrap().unwrap_err().code, "CANCELLED");
    assert!(
        tokio::time::timeout(Duration::from_millis(10), &mut close)
            .await
            .is_err()
    );
    assert!(root.join(".workspace-owner.json").is_file());
    resume.send(()).unwrap();
    completed.await.unwrap();
    let receipt = copy.await.unwrap().unwrap();
    assert!(
        root.join("backups")
            .join(receipt["backupId"].as_str().unwrap())
            .join("manifest.json")
            .is_file()
    );
    tokio::time::timeout(Duration::from_secs(3), &mut close)
        .await
        .unwrap()
        .unwrap();
    assert!(!root.join(".workspace-owner.json").exists());
}
