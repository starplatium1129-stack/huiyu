use super::*;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    future::Future,
    path::Path,
    pin::Pin,
    sync::{Mutex, OnceLock, mpsc as sync_mpsc},
    task::Poll,
    time::Duration,
};

mod inputs;
mod lifecycle;

const WATCHDOG: Duration = Duration::from_secs(10);
type GateKey = (PathBuf, String);
struct Paused {
    entered: oneshot::Sender<String>,
    resume: sync_mpsc::Receiver<()>,
    panic: bool,
}
fn gates() -> &'static Mutex<HashMap<GateKey, Paused>> {
    static GATES: OnceLock<Mutex<HashMap<GateKey, Paused>>> = OnceLock::new();
    GATES.get_or_init(Mutex::default)
}
fn failures() -> &'static Mutex<HashSet<PathBuf>> {
    static FAILURES: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();
    FAILURES.get_or_init(Mutex::default)
}
pub(in crate::storage) fn fail_start(root: &Path) -> bool {
    failures().lock().unwrap().remove(root)
}
pub(in crate::storage) fn pause(path: &Path, stage: &str) {
    let paused = gates().lock().unwrap().remove(&(path.into(), stage.into()));
    if let Some(paused) = paused {
        let thread = std::thread::current()
            .name()
            .unwrap_or("unnamed")
            .to_owned();
        let _ = paused.entered.send(thread);
        paused
            .resume
            .recv_timeout(WATCHDOG)
            .expect("commit gate watchdog");
        assert!(!paused.panic, "injected commit validator panic");
    }
}
struct Gate {
    key: GateKey,
    entered: oneshot::Receiver<String>,
    resume: Option<sync_mpsc::Sender<()>>,
}
impl Gate {
    fn new(path: &Path, stage: &str) -> Self {
        Self::with_panic(path, stage, false)
    }
    fn with_panic(path: &Path, stage: &str, panic: bool) -> Self {
        let key = (path.into(), stage.into());
        let (entered, ready) = oneshot::channel();
        let (resume, receiver) = sync_mpsc::channel();
        assert!(
            gates()
                .lock()
                .unwrap()
                .insert(
                    key.clone(),
                    Paused {
                        entered,
                        resume: receiver,
                        panic,
                    }
                )
                .is_none()
        );
        Self {
            key,
            entered: ready,
            resume: Some(resume),
        }
    }
    async fn ready(&mut self) -> String {
        bounded(&mut self.entered).await.unwrap()
    }
    fn release(&mut self) {
        if let Some(resume) = self.resume.take() {
            let _ = resume.send(());
        }
    }
}
impl Drop for Gate {
    fn drop(&mut self) {
        self.release();
        gates().lock().unwrap().remove(&self.key);
    }
}
async fn bounded<F: Future>(future: F) -> F::Output {
    tokio::time::timeout(WATCHDOG, future)
        .await
        .expect("commit test watchdog")
}
async fn pending<F: Future>(mut future: Pin<&mut F>) {
    std::future::poll_fn(move |cx| {
        assert!(future.as_mut().poll(cx).is_pending());
        Poll::Ready(())
    })
    .await;
}
fn paths(storage: &Storage, index: u64, bytes: &[u8]) -> (PathBuf, PathBuf) {
    let key = canonical::digest(format!("task:{ID}:{index}"));
    let staging = media::staging_path(&storage.root, &key, &format!("task-{ID}-{index}")).unwrap();
    let object = media::object_path(&storage.root, &hex::encode(Sha256::digest(bytes))).unwrap();
    (staging, object)
}
async fn uploaded(storage: &Storage, index: u64, bytes: &[u8]) -> (PathBuf, PathBuf) {
    let target = TaskMediaTarget::Result(index);
    prepare(storage, &target, bytes).await;
    for (index, block) in bytes.chunks(media::CHUNK).enumerate() {
        storage
            .task_media_chunk(
                chunk(
                    &target,
                    (index * media::CHUNK) as u64,
                    Bytes::copy_from_slice(block),
                ),
                PRINCIPAL,
            )
            .await
            .unwrap();
    }
    paths(storage, index, bytes)
}
fn commit(storage: &Storage, index: u64) -> tokio::task::JoinHandle<Result<Value>> {
    let storage = storage.clone();
    tokio::spawn(async move {
        storage
            .request(
                command(&TaskMediaTarget::Result(index), "commit"),
                PRINCIPAL,
            )
            .await
    })
}
fn db(storage: &Storage) -> Connection {
    Connection::open(storage.root.join("huiyu.sqlite3")).unwrap()
}
fn count(db: &Connection, sql: &str) -> i64 {
    db.query_row(sql, [], |row| row.get(0)).unwrap()
}
fn unpublished(db: &Connection) {
    assert_eq!(
        count(db, "SELECT count(*) FROM task_outputs WHERE committed=1"),
        0
    );
    assert_eq!(
        count(
            db,
            "SELECT count(*) FROM media_refs WHERE owner_kind='task-result'"
        ),
        0
    );
    let task: String = db
        .query_row("SELECT record_json FROM tasks", [], |r| r.get(0))
        .unwrap();
    assert!(
        serde_json::from_str::<Value>(&task).unwrap()["resultRefs"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}
async fn queries(storage: &Storage, alias: &str) -> Value {
    let started = Instant::now();
    let mut replies = Vec::new();
    for query in [
        json!({"kind":"listArtworks","limit":1}),
        json!({"kind":"task.list","limit":1}),
    ] {
        let (reply, receiver) = oneshot::channel();
        storage
            .sender
            .send(Work::Request(
                query,
                PRINCIPAL.into(),
                Arc::new(AtomicBool::new(false)),
                reply,
            ))
            .await
            .unwrap();
        replies.push(receiver);
    }
    let (reply, alias_result) = oneshot::channel();
    storage
        .sender
        .send(Work::Media(
            alias.into(),
            Arc::new(AtomicBool::new(false)),
            reply,
        ))
        .await
        .unwrap();
    for reply in replies {
        bounded(reply).await.unwrap().unwrap();
    }
    bounded(alias_result).await.unwrap().unwrap();
    json!({"completedQueries":3,"elapsedMs":started.elapsed().as_secs_f64()*1000.0})
}
async fn seed(storage: &Storage) -> String {
    let target = TaskMediaTarget::Input("seed".into());
    let bytes = data(32);
    let alias = prepare(storage, &target, &bytes).await;
    storage
        .task_media_chunk(chunk(&target, 0, bytes.into()), PRINCIPAL)
        .await
        .unwrap();
    storage
        .request(command(&target, "commit"), PRINCIPAL)
        .await
        .unwrap();
    storage.media(&alias).await.unwrap();
    alias
}

#[tokio::test]
async fn both_validation_branches_release_sqlite_and_serialize_result_retries() {
    for existing in [false, true] {
        let (directory, storage) = fixture().await;
        let alias = seed(&storage).await;
        let bytes = data(64);
        let (staging, object) = uploaded(&storage, 0, &bytes).await;
        if existing {
            fs::create_dir_all(object.parent().unwrap()).unwrap();
            fs::copy(&staging, &object).unwrap();
        }
        let path = if existing { &object } else { &staging };
        let mut gate = Gate::new(path, "before-hash");
        let first = commit(&storage, 0);
        let thread = gate.ready().await;
        assert_ne!(thread, "workspace-sqlite");
        let target = TaskMediaTarget::Result(0);
        let mut retry = Box::pin(storage.request(command(&target, "commit"), PRINCIPAL));
        let mut prepare_command = command(&target, "prepare");
        let stored: String = db(&storage)
            .query_row(
                "SELECT media_json FROM task_outputs WHERE task_id=? AND output_index=0",
                [ID],
                |row| row.get(0),
            )
            .unwrap();
        prepare_command["media"] = serde_json::from_str(&stored).unwrap();
        let mut prepare_retry = Box::pin(storage.request(prepare_command, PRINCIPAL));
        let mut chunk_retry = Box::pin(
            storage.task_media_chunk(chunk(&target, 0, Bytes::copy_from_slice(&bytes)), PRINCIPAL),
        );
        pending(retry.as_mut()).await;
        pending(prepare_retry.as_mut()).await;
        pending(chunk_retry.as_mut()).await;
        // Installing after the first worker entered detects any second hash on
        // this source, including a duplicate that starts only after release.
        let mut duplicate_hash = Gate::new(path, "before-hash");
        let query_evidence = queries(&storage, &alias).await;
        assert!(!first.is_finished());
        assert_eq!(storage.result_writes.available_permits(), 0);
        println!(
            "{}",
            json!({"branch":if existing {"existing-object"} else {"staging"},
            "validatorThread":thread,"whilePaused":query_evidence})
        );
        gate.release();
        let value = bounded(first).await.unwrap().unwrap();
        assert_eq!(bounded(retry).await.unwrap()["revision"], value["revision"]);
        assert_eq!(bounded(prepare_retry).await.unwrap()["offset"], bytes.len());
        assert_eq!(bounded(chunk_retry).await.unwrap(), bytes.len() as u64);
        assert!(matches!(
            duplicate_hash.entered.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));
        assert_eq!(fs::read(&object).unwrap(), bytes);
        assert_eq!(count(&db(&storage), "SELECT count(*) FROM leases"), 0);
        storage.close().await.unwrap();
        let reopened = Storage::open(
            directory.path().join("workspace"),
            "binary-media".into(),
            false,
        )
        .await
        .unwrap();
        let stored = reopened
            .request(json!({"kind":"task.get","taskId":ID}), PRINCIPAL)
            .await
            .unwrap();
        assert_eq!(stored["resultRefs"].as_array().unwrap().len(), 1);
        assert_eq!(stored["revision"], value["revision"]);
        reopened.close().await.unwrap();
    }
}

#[tokio::test]
async fn verified_file_mutations_and_destination_races_never_publish_bad_references() {
    use std::io::{Seek, SeekFrom, Write};
    for scenario in [
        "staging-write",
        "object-write",
        "staging-replace",
        "object-replace",
        "target-race",
    ] {
        let (_directory, storage) = fixture().await;
        let bytes = data(64);
        let (staging, object) = uploaded(&storage, 0, &bytes).await;
        let existing = scenario.starts_with("object");
        if existing {
            fs::create_dir_all(object.parent().unwrap()).unwrap();
            fs::copy(&staging, &object).unwrap();
        }
        let file = if existing { &object } else { &staging };
        let mut gate = Gate::new(file, "verified");
        let request = commit(&storage, 0);
        gate.ready().await;
        let modified = fs::metadata(file).unwrap().modified().unwrap();
        if scenario.ends_with("write") {
            let mut output = File::options().write(true).open(file).unwrap();
            output.seek(SeekFrom::Start(32)).unwrap();
            output.write_all(&[17]).unwrap();
            output.sync_all().unwrap();
            output
                .set_times(fs::FileTimes::new().set_modified(modified))
                .unwrap();
        } else if scenario.ends_with("replace") {
            fs::rename(file, file.with_extension("held")).unwrap();
            fs::write(file, &bytes).unwrap();
            File::options()
                .write(true)
                .open(file)
                .unwrap()
                .set_times(fs::FileTimes::new().set_modified(modified))
                .unwrap();
        } else {
            fs::create_dir_all(object.parent().unwrap()).unwrap();
            let mut bad = bytes.clone();
            bad[32] ^= 1;
            fs::write(&object, bad).unwrap();
        }
        gate.release();
        assert!(bounded(request).await.unwrap().is_err(), "{scenario}");
        unpublished(&db(&storage));
        assert_eq!(count(&db(&storage), "SELECT count(*) FROM leases"), 1);
        storage.close().await.unwrap();
    }
}

// Synthetic disk/hash/actor measurements, not production generation or UI latency.
#[tokio::test]
#[ignore = "manual 16MiB commit throughput evidence; no timing pass threshold"]
async fn benchmark_result_validation_throughput() {
    let (_directory, storage) = fixture().await;
    let alias = seed(&storage).await;
    let bytes = data(16 * media::CHUNK);
    for index in 0..2 {
        let (staging, object) = uploaded(&storage, index, &bytes).await;
        let path = if index == 0 { &staging } else { &object };
        let mut gate = Gate::new(path, "before-hash");
        let request = commit(&storage, index);
        let thread = gate.ready().await;
        let evidence = queries(&storage, &alias).await;
        let started = Instant::now();
        gate.release();
        bounded(request).await.unwrap().unwrap();
        let seconds = started.elapsed().as_secs_f64();
        println!(
            "{}",
            json!({"benchmark":"task-result-validation","branch":if index==0 {"new-object"} else {"existing-object"},
            "bytes":bytes.len(),"seconds":seconds,"MiBPerSecond":16.0/seconds,
            "validatorThread":thread,"pausedQueryEvidence":evidence,"includesPublication":true})
        );
    }
    storage.close().await.unwrap();
}
