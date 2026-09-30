use super::*;
use huiyu_runtime::task_contract::TaskRecord;
use rusqlite::{Connection, params};
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tokio::{
    sync::{Notify, Semaphore},
    task::JoinHandle,
};

struct Probes {
    active: AtomicUsize,
    maximum: AtomicUsize,
    histories: Mutex<HashMap<String, usize>>,
    fail: AtomicBool,
    writes: AtomicUsize,
    gate: Semaphore,
    entered: Notify,
    completed: bool,
}
struct Active(Arc<Probes>);
impl Drop for Active {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::SeqCst);
    }
}
async fn history(
    Path(id): Path<String>,
    State(probes): State<Arc<Probes>>,
) -> (StatusCode, Json<Value>) {
    let active = probes.active.fetch_add(1, Ordering::SeqCst) + 1;
    probes.maximum.fetch_max(active, Ordering::SeqCst);
    let _active = Active(probes.clone());
    *probes
        .histories
        .lock()
        .unwrap()
        .entry(id.clone())
        .or_default() += 1;
    probes.entered.notify_one();
    probes.gate.acquire().await.unwrap().forget();
    if id == "task-0" && probes.fail.load(Ordering::SeqCst) {
        (StatusCode::SERVICE_UNAVAILABLE, Json(json!({})))
    } else {
        (
            StatusCode::OK,
            Json(
                json!({id:{"status":{"status_str":if probes.completed {"success"} else {"failed"}},"outputs":{}}}),
            ),
        )
    }
}
async fn forbidden_write(State(probes): State<Arc<Probes>>) -> StatusCode {
    probes.writes.fetch_add(1, Ordering::SeqCst);
    StatusCode::BAD_REQUEST
}
fn legacy_record(
    workspace: &str,
    id: &str,
    fingerprint: &str,
    revision: i64,
    completed: bool,
) -> TaskRecord {
    serde_json::from_value(json!({"taskId":id,"workspaceId":workspace,"principalId":"alice",
        "requestKey":id,"requestFingerprint":"legacy-key","kind":"generation","provider":"comfy",
        "providerFingerprint":fingerprint,"upstreamId":id,"status":if completed{"succeeded"}else{"running"},
        "recoveryState":"normal","revision":revision,"runtimeEpoch":"old-node-epoch",
        "createdAt":1,"updatedAt":1,"submissionIntentAt":2,"submissionObservedAt":3,
        "cancelRequestedAt":null,"upstreamSettled":completed,"executionDeadline":9999999999999u64,
        "input":{},"inputMediaRefs":[],"resultState":if completed{"unavailable"}else{"none"},
        "resultRefs":[],"deliveryState":"unseen","errorCode":null,"metadata":{},"checkpoint":null,
        "parentBatchId":null,"stepIndex":null})).unwrap()
}
fn seed_legacy_database(
    root: &std::path::Path,
    workspace: &str,
    fingerprint: &str,
    tasks: usize,
    completed: bool,
) {
    // This simulates existing Node ledger rows, while Storage has no owner.
    // New accept calls keep the production single unfinished provider guard.
    assert!(!root.join(".workspace-owner.json").exists());
    let mut db = Connection::open(root.join("huiyu.sqlite3")).unwrap();
    db.busy_timeout(Duration::from_secs(5)).unwrap();
    db.execute_batch("PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;")
        .unwrap();
    assert_eq!(
        db.query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
    assert_eq!(
        db.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        3
    );
    assert_eq!(
        db.query_row(
            "SELECT value FROM meta WHERE key='workspaceId'",
            [],
            |row| row.get::<_, String>(0)
        )
        .unwrap(),
        workspace
    );
    let tx = db.transaction().unwrap();
    for index in 0..tasks {
        let record = legacy_record(
            workspace,
            &format!("task-{index}"),
            fingerprint,
            index as i64 + 1,
            completed,
        );
        tx.execute("INSERT INTO tasks(task_id,principal_id,request_key,provider,upstream_settled,record_json) VALUES(?,?,?,?,?,?)",
            params![record.task_id, record.principal_id, record.request_key, record.provider, record.upstream_settled,
                serde_json::to_string(&record).unwrap()]).unwrap();
    }
    assert_eq!(
        tx.execute(
            "UPDATE meta SET value=? WHERE key='revision'",
            [tasks.to_string()]
        )
        .unwrap(),
        1
    );
    tx.commit().unwrap();
    assert_eq!(
        db.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "ok"
    );
    assert_eq!(
        db.query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap(),
        0
    );
}
struct Fixture {
    _directory: tempfile::TempDir,
    storage: Storage,
    runtime: Arc<TaskRuntime>,
    probes: Arc<Probes>,
    fingerprint: String,
    shutdown: CancellationToken,
    server: JoinHandle<()>,
}
impl Fixture {
    async fn new(tasks: usize, completed: bool) -> Self {
        let directory = tempfile::tempdir().unwrap();
        let probes = Arc::new(Probes {
            active: AtomicUsize::new(0),
            maximum: AtomicUsize::new(0),
            histories: Mutex::new(HashMap::new()),
            fail: AtomicBool::new(false),
            writes: AtomicUsize::new(0),
            gate: Semaphore::new(0),
            entered: Notify::new(),
            completed,
        });
        let app = Router::new()
            .route("/history/{id}", get(history))
            .route(
                "/queue",
                get(|| async { Json(json!({"queue_running":[],"queue_pending":[]})) })
                    .post(forbidden_write),
            )
            .route("/prompt", post(forbidden_write))
            .route("/interrupt", post(forbidden_write))
            .route("/api/jobs/{id}/cancel", post(forbidden_write))
            .with_state(probes.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let host = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let config = Config {
            sd_host: host.clone(),
            sd_auth: None,
            comfy_host: host,
            ai_workspace_root: directory.path().join("AI"),
            runtime_root: directory.path().join("runtime"),
        };
        std::fs::create_dir_all(config.ai_workspace_root.join("ComfyUI")).unwrap();
        let fingerprint = old_identity(&config);
        let workspace_root = directory.path().join("workspace");
        let storage = Storage::open(
            workspace_root.clone(),
            "bounded-recovery-fixture".into(),
            true,
        )
        .await
        .unwrap();
        let workspace = storage.workspace_id().to_owned();
        storage.close().await.unwrap();
        seed_legacy_database(&workspace_root, &workspace, &fingerprint, tasks, completed);
        let storage = Storage::open(workspace_root, workspace, false)
            .await
            .unwrap();
        let shutdown = CancellationToken::new();
        let provider = Arc::new(
            GenerationService::new(config, LocalUpstream::new(), shutdown.clone()).unwrap(),
        );
        let runtime = Arc::new(TaskRuntime::new(provider, None, None, shutdown.clone()).unwrap());
        Self {
            _directory: directory,
            storage,
            runtime,
            probes,
            fingerprint,
            shutdown,
            server,
        }
    }
    fn recover(&self) -> JoinHandle<huiyu_runtime::error::Result<()>> {
        let runtime = self.runtime.clone();
        let storage = self.storage.clone();
        tokio::spawn(async move { runtime.ensure_recovered(&storage, "alice").await })
    }
    fn histories(&self) -> usize {
        self.probes.histories.lock().unwrap().values().sum()
    }
    async fn wait_histories(&self, count: usize) {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let notified = self.probes.entered.notified();
                if self.histories() >= count {
                    return;
                }
                notified.await;
            }
        })
        .await
        .expect("neutral upstream received recovery probes");
    }
    async fn close(self) {
        self.runtime.close().await;
        self.storage.close().await.unwrap();
        self.server.abort();
    }
}

#[tokio::test]
async fn independent_probes_are_bounded_and_concurrent_callers_share_paged_initialization() {
    let fixture = Fixture::new(103, true).await;
    let first = fixture.recover();
    fixture.wait_histories(2).await;
    let second = fixture.recover();
    // A later insertion must not move the original immutable pagination bound.
    let late = legacy_record(
        fixture.storage.workspace_id(),
        "late",
        &fixture.fingerprint,
        0,
        true,
    );
    fixture
        .storage
        .request(json!({"kind":"task.accept","record":late}), "alice")
        .await
        .unwrap();
    tokio::task::yield_now().await;
    assert_eq!(fixture.histories(), 2);
    assert_eq!(fixture.probes.maximum.load(Ordering::SeqCst), 2);
    fixture.probes.gate.add_permits(103);
    first.await.unwrap().unwrap();
    second.await.unwrap().unwrap();
    assert_eq!(fixture.histories(), 103);
    assert_eq!(fixture.probes.maximum.load(Ordering::SeqCst), 2);
    assert!(
        fixture
            .probes
            .histories
            .lock()
            .unwrap()
            .values()
            .all(|count| *count == 1)
    );
    assert_eq!(fixture.probes.writes.load(Ordering::SeqCst), 0);
    let late = TaskRuntime::get(&fixture.storage, "alice", "late")
        .await
        .unwrap();
    assert_eq!(late.status, TaskStatus::Succeeded);
    assert_eq!(late.result_state, ResultState::Unavailable);
    assert!(
        !fixture
            .probes
            .histories
            .lock()
            .unwrap()
            .contains_key("late")
    );
    fixture.close().await;
}

#[tokio::test]
async fn one_failed_history_remains_unknown_without_replaying_or_cancelling() {
    let fixture = Fixture::new(3, false).await;
    fixture.probes.fail.store(true, Ordering::SeqCst);
    fixture.probes.gate.add_permits(3);
    fixture.recover().await.unwrap().unwrap();
    let unknown = TaskRuntime::get(&fixture.storage, "alice", "task-0")
        .await
        .unwrap();
    assert_eq!(unknown.status, TaskStatus::Running);
    assert_eq!(unknown.recovery_state, RecoveryState::Unknown);
    assert!(!unknown.upstream_settled);
    assert_eq!(
        unknown.error_code.as_deref(),
        Some("TASK_RECONCILE_REQUIRED")
    );
    assert!(unknown.cancel_requested_at.is_none());
    assert_eq!(fixture.probes.writes.load(Ordering::SeqCst), 0);
    fixture.close().await;
}

#[tokio::test]
async fn whole_scan_timeout_stays_retryable_and_does_not_cancel_accepted_tasks() {
    let fixture = Fixture::new(3, false).await;
    let first = fixture.recover();
    fixture.wait_histories(2).await;
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(61)).await;
    // Storage writes use real worker threads: stop auto-advancing while the
    // bounded timeout cleanup writes unknown observations back to the fixture.
    tokio::time::resume();
    let error = first.await.unwrap().unwrap_err();
    assert_eq!(error.code, "TASK_RECOVERY_TIMEOUT");
    let probed = fixture
        .probes
        .histories
        .lock()
        .unwrap()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    for id in &probed {
        let task = TaskRuntime::get(&fixture.storage, "alice", id)
            .await
            .unwrap();
        assert_eq!(task.status, TaskStatus::Running);
        assert_eq!(task.recovery_state, RecoveryState::Unknown);
        assert!(!task.upstream_settled);
        assert!(task.cancel_requested_at.is_none());
    }
    assert_eq!(fixture.probes.writes.load(Ordering::SeqCst), 0);
    // Unblock stale neutral HTTP handlers and every later probe. A completed
    // retry must observe the original IDs and initialize OnceCell only now.
    fixture.probes.gate.add_permits(16);
    fixture.recover().await.unwrap().unwrap();
    let after_retry = fixture.histories();
    assert!(after_retry > probed.len());
    for index in 0..3 {
        assert!(
            TaskRuntime::get(&fixture.storage, "alice", &format!("task-{index}"))
                .await
                .unwrap()
                .upstream_settled
        );
    }
    fixture.recover().await.unwrap().unwrap();
    assert_eq!(fixture.histories(), after_retry);
    assert_eq!(fixture.probes.writes.load(Ordering::SeqCst), 0);
    fixture.close().await;
}

#[tokio::test]
async fn shutdown_ends_shared_initialization_waiters_without_remote_writes() {
    let fixture = Fixture::new(3, false).await;
    let first = fixture.recover();
    fixture.wait_histories(2).await;
    let second = fixture.recover();
    fixture.shutdown.cancel();
    for waiter in [first, second] {
        let error = tokio::time::timeout(Duration::from_secs(1), waiter)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert_eq!(error.code, "TASK_RUNTIME_CLOSED");
    }
    assert_eq!(fixture.histories(), 2);
    assert_eq!(fixture.probes.writes.load(Ordering::SeqCst), 0);
    for index in 0..3 {
        let task = TaskRuntime::get(&fixture.storage, "alice", &format!("task-{index}"))
            .await
            .unwrap();
        assert!(!task.upstream_settled);
        assert!(task.cancel_requested_at.is_none());
    }
    fixture.close().await;
}
