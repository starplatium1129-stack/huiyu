mod actions;
mod execution;
mod fingerprint;
mod hooks;
mod manga;
mod media;
mod providers;
mod recovery;
mod resume;
mod retry;
mod submission;
mod image_batches;
mod image_batch_artwork;
use providers::Preparation;

use crate::{
    error::{ApiError, Result},
    generation::GenerationService,
    storage::Storage,
    task_contract::{
        DeliveryState, RecoveryState as TaskRecoveryState, ResultState, TaskCommand, TaskKind,
        TaskPatch, TaskRecord, TaskStatus,
    },
};
use fingerprint::Fingerprint;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub struct TaskRuntime {
    provider: Arc<GenerationService>,
    images: Arc<crate::images::ImageService>,
    video: Arc<crate::video::VideoService>,
    recoveries: Mutex<HashMap<String, Arc<recovery::Initialization>>>,
    image_batches: Mutex<std::collections::HashSet<String>>,
    fingerprint: Fingerprint,
    unbound_epoch: String,
    jobs: Mutex<HashMap<String, JobBinding>>,
    tracker: TaskTracker,
    closed: AtomicBool,
    shutdown: CancellationToken,
}
struct JobBinding {
    id: String,
    dispatching: bool,
    watching: bool,
    watch_requested: bool,
    changed: Arc<tokio::sync::Notify>,
    operation: Arc<tokio::sync::Mutex<RecoveryState>>,
}
#[derive(Default)]
struct RecoveryState {
    single: Option<u8>,
    batch: crate::video::BatchRecovery,
}
impl JobBinding {
    fn new(id: String) -> Self {
        Self {
            id,
            dispatching: false,
            watching: false,
            watch_requested: false,
            changed: Arc::new(tokio::sync::Notify::new()),
            operation: Arc::new(tokio::sync::Mutex::new(RecoveryState::default())),
        }
    }
    fn request_monitor(&mut self, changed: bool) -> Option<Arc<tokio::sync::Notify>> {
        if changed && self.watching {
            self.changed.notify_one();
        }
        if self.dispatching || self.watching {
            self.watch_requested = true;
            return None;
        }
        self.watching = true;
        self.watch_requested = false;
        Some(self.changed.clone())
    }
}
impl TaskRuntime {
    pub fn new(
        provider: Arc<GenerationService>,
        images: Arc<crate::images::ImageService>,
        video: Arc<crate::video::VideoService>,
        shutdown: CancellationToken,
    ) -> Result<Self> {
        Ok(Self {
            provider,
            images,
            video,
            recoveries: Mutex::new(HashMap::new()),
            image_batches: Mutex::new(std::collections::HashSet::new()),
            fingerprint: Fingerprint::system()?,
            unbound_epoch: uuid::Uuid::new_v4().to_string(),
            jobs: Mutex::new(HashMap::new()),
            tracker: TaskTracker::new(),
            closed: AtomicBool::new(false),
            shutdown,
        })
    }
    pub fn owns(&self, storage: &Storage, id: &str) -> bool {
        !self.closed.load(Ordering::Acquire)
            && self
                .jobs
                .lock()
                .unwrap()
                .get(&identity(storage, id))
                .is_some_and(|job| job.dispatching || job.watching)
    }
    pub async fn get(storage: &Storage, principal: &str, id: &str) -> Result<TaskRecord> {
        storage
            .task_record(id, principal)
            .await?
            .ok_or_else(|| ApiError::new(404, "TASK_NOT_FOUND", "Task does not exist"))
    }
    fn check_running(&self) -> Result<()> {
        if self.closed.load(Ordering::Acquire) || self.shutdown.is_cancelled() {
            Err(ApiError::new(
                503,
                "TASK_RUNTIME_CLOSED",
                "Task runtime is draining",
            ))
        } else {
            Ok(())
        }
    }
    pub async fn cancel(
        self: &Arc<Self>,
        storage: Storage,
        principal: String,
        key: String,
    ) -> Result<Value> {
        self.check_running()?;
        let (reply, received) = tokio::sync::oneshot::channel();
        let runtime = self.clone();
        // Cancellation is a runtime-owned command just like acceptance. A lost
        // response must not abandon a persisted intent before its first probe
        // installs a monitor, especially for tasks recovered after a restart.
        self.tracker.spawn(async move {
            let result = async {
                runtime.check_running()?;
                let task = storage
                    .task(TaskCommand::Cancel { request_key: key }, &principal)
                    .await?;
                let Some(task): Option<TaskRecord> = serde_json::from_value(task)? else {
                    return Ok(Value::Null);
                };
                if let Some(binding) = runtime
                    .jobs
                    .lock()
                    .unwrap()
                    .get(&identity(&storage, &task.task_id))
                {
                    binding.changed.notify_one();
                }
                if task.upstream_settled {
                    return Ok(task.into_value()?);
                }
                let id = task.task_id.clone();
                let kind = task.kind;
                drop(task);
                if let Some(job) = runtime.job(&storage, &id).filter(|job| !job.is_empty()) {
                    // The live registry proves ownership of WebUI's global interrupt.
                    let _ = runtime.cancel_provider(kind, &job, &principal).await;
                }
                runtime.reconcile(&storage, &principal, &id).await
            }
            .await;
            let _ = reply.send(result);
        });
        received.await.map_err(|_| {
            ApiError::new(
                503,
                "TASK_CANCEL_UNKNOWN",
                "Cancellation result unknown; query the original task",
            )
        })?
    }

    pub async fn delivery(
        storage: &Storage,
        principal: &str,
        id: &str,
        state: &str,
    ) -> Result<Value> {
        let state: DeliveryState = serde_json::from_value(json!(state))
            .map_err(|_| ApiError::invalid("Invalid delivery state"))?;
        Ok(patch(
            storage,
            principal,
            id,
            TaskPatch {
                delivery_state: Some(state),
                ..Default::default()
            },
        )
        .await?
        .into_value()?)
    }
    pub async fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.provider.close().await;
        self.images.close().await;
        self.video.close().await;
        {
            // Serialize closure with read-triggered recovery registration.
            let _recoveries = self.recoveries.lock().unwrap();
            self.tracker.close();
        }
        self.tracker.wait().await;
    }
    fn binding_for(&self, kind: TaskKind) -> String {
        let provider = if matches!(kind, TaskKind::Anima | TaskKind::Creative | TaskKind::Qwen) || kind.is_manga() {
            self.images.provider_identity(&self.unbound_epoch)
        } else if matches!(kind, TaskKind::Video | TaskKind::Batch) {
            self.video.provider_identity(&self.unbound_epoch)
        } else {
            self.provider.provider_identity(&self.unbound_epoch)
        };
        self.fingerprint.hash(&provider)
    }
    fn job(&self, storage: &Storage, id: &str) -> Option<String> {
        self.jobs
            .lock()
            .unwrap()
            .get(&identity(storage, id))
            .map(|job| job.id.clone())
    }
    fn register_job(&self, storage: &Storage, id: &str, job_id: String) {
        let mut jobs = self.jobs.lock().unwrap();
        jobs.entry(identity(storage, id))
            .and_modify(|job| job.id = job_id.clone())
            .or_insert_with(|| JobBinding::new(job_id));
    }
}
pub(super) async fn patch(
    storage: &Storage,
    principal: &str,
    id: &str,
    value: TaskPatch,
) -> Result<TaskRecord> {
    let current = revision(storage, principal, id).await?;
    patch_at(storage, principal, id, current, value).await
}
pub(super) async fn patch_at(
    storage: &Storage,
    principal: &str,
    id: &str,
    mut revision: i64,
    value: TaskPatch,
) -> Result<TaskRecord> {
    for attempt in 0..5 {
        let result = storage
            .patch_task(id,revision,value.clone(),principal)
            .await;
        match result {
            Err(error) if error.code == "REVISION_CONFLICT" && attempt < 4 => {
                revision = self::revision(storage, principal, id).await?;
            }
            result => return result,
        }
    }
    unreachable!()
}
async fn revision(storage: &Storage, principal: &str, id: &str) -> Result<i64> {
    storage
        .task_revision(id, principal)
        .await?
        .ok_or_else(|| ApiError::new(404, "TASK_NOT_FOUND", "Task does not exist"))
}
fn identity(storage: &Storage, id: &str) -> String {
    format!("{}:{id}", storage.runtime_epoch())
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .ok_or_else(|| ApiError::invalid(format!("Missing task {key}")))
}
fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
