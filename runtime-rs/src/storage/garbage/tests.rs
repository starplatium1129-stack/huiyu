use super::*;
use std::{
    fs::File,
    time::{Duration, SystemTime},
};

fn fixture() -> (tempfile::TempDir, Context) {
    let directory = tempfile::tempdir().unwrap();
    let context = schema::open(
        directory.path().join("workspace"),
        "gc-staging".into(),
        "gc-epoch".into(),
        true,
    )
    .unwrap();
    (directory, context)
}

fn collect(c: &mut Context, id: &str) -> Result<Value> {
    match prepare(
        c,
        "test",
        &json!({"kind":"collectGarbage","operationId":id}),
    )? {
        Prepared::Complete(receipt) => Ok(receipt),
        Prepared::Discover(job) => {
            let candidates = job.run();
            finish(c, job.completion, candidates)
        }
    }
}

fn completed(c: &Context, id: &str) -> String {
    let key = c
        .insert_operation(
            "test",
            id,
            "prepareMedia",
            &json!({"kind":"prepareMedia","operationId":id}),
        )
        .unwrap();
    c.commit_operation(
        &key,
        &json!({"kind":"commitMedia","operationId":id,"revision":0}),
    )
    .unwrap();
    key
}

fn staged(c: &Context, key: &str, old: bool) -> PathBuf {
    let file = media::staging_path(&c.root, key, "fixture.png").unwrap();
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, b"staging-fixture").unwrap();
    if old {
        let modified =
            SystemTime::now() - Duration::from_millis(records::RETENTION as u64 + 60_000);
        File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
    }
    file
}

#[test]
fn empty_staging_never_reads_unrelated_task_media_history() {
    let (_directory, mut c) = fixture();
    fs::create_dir_all(c.root.join("media/staging")).unwrap();
    // This isolated legacy row would make the history json_extract fail if an
    // empty staging directory still inspected unrelated completed task media.
    c.db.execute(
        "INSERT INTO tasks VALUES('legacy','test','legacy','fixture',1,'{}')",
        [],
    )
    .unwrap();
    c.db.execute(
        "INSERT INTO task_inputs VALUES('legacy','image','invalid-json',1)",
        [],
    )
    .unwrap();
    let receipt = collect(&mut c, "empty").unwrap();
    assert_eq!(receipt["removed"], 0);
    assert_eq!(receipt["revision"], 1);
    assert_eq!(collect(&mut c, "empty").unwrap(), receipt);
    assert_eq!(c.revision().unwrap(), 1);
    c.shutdown().unwrap();
}

#[test]
fn nonempty_staging_processes_first_entry_and_preserves_leases_and_retention() {
    let (_directory, mut c) = fixture();
    let key = completed(&c, "completed-upload");
    let file = staged(&c, &key, true);
    // One entry ensures the probe's consumed first item is actually cleaned.
    assert_eq!(collect(&mut c, "first-entry").unwrap()["revision"], 1);
    assert!(!file.exists());
    assert!(!file.parent().unwrap().exists());

    let file = staged(&c, &key, true);
    c.db.execute(
        "INSERT INTO leases(id,kind,operation_key,created_at) VALUES(?,'staging',?,0)",
        rusqlite::params![key, key],
    )
    .unwrap();
    collect(&mut c, "leased").unwrap();
    assert!(file.exists());
    assert_eq!(
        c.db.query_row("SELECT count(*) FROM leases", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        1
    );

    c.db.execute("DELETE FROM leases WHERE id=?", [&key])
        .unwrap();
    let file = staged(&c, &key, false);
    let receipt = collect(&mut c, "retained").unwrap();
    assert!(file.exists());
    assert_eq!(receipt["removed"], 0);
    assert_eq!(collect(&mut c, "retained").unwrap(), receipt);
    c.shutdown().unwrap();
}

#[test]
fn nonempty_staging_failure_rolls_back_metadata_and_preserves_retry_receipt() {
    let (_directory, mut c) = fixture();
    let hash = digest("missing-object");
    c.db.execute("INSERT INTO media_objects VALUES(?,1,'image/png')", [&hash])
        .unwrap();
    c.db.execute("INSERT INTO media_aliases VALUES('missing.png',?)", [&hash])
        .unwrap();
    let key = completed(&c, "invalid-staging-entry");
    let folder = schema::safe(&c.root, format!("media/staging/{key}")).unwrap();
    fs::create_dir_all(folder.parent().unwrap()).unwrap();
    // The first item has a completed identity but is a file instead of a folder.
    fs::write(&folder, b"invalid staging shape").unwrap();
    assert_eq!(
        collect(&mut c, "retry-cleanup").unwrap_err().code,
        "STORAGE_UNAVAILABLE"
    );
    assert_eq!(c.revision().unwrap(), 0);
    let operation = c.operation("test", "retry-cleanup").unwrap().unwrap();
    assert_eq!(operation.state, "prepared");
    assert!(operation.receipt.is_none());
    assert_eq!(
        c.db.query_row(
            "SELECT count(*) FROM media_objects WHERE hash=?",
            [&hash],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        c.db.query_row(
            "SELECT count(*) FROM media_aliases WHERE hash=?",
            [&hash],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );

    fs::remove_file(&folder).unwrap();
    fs::create_dir(&folder).unwrap();
    let receipt = collect(&mut c, "retry-cleanup").unwrap();
    assert_eq!(receipt["removed"], 1);
    assert_eq!(receipt["revision"], 1);
    assert_eq!(collect(&mut c, "retry-cleanup").unwrap(), receipt);
    c.shutdown().unwrap();
}
