mod actions;
mod execution;
mod fingerprint;
mod hooks;
mod media;
mod providers;
mod recovery;
mod resume;
use providers::Preparation;
#[cfg(test)]
mod tests;

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
    images: Option<Arc<crate::images::ImageService>>,
    video: Option<Arc<crate::video::VideoService>>,
    recoveries: Mutex<HashMap<String, Arc<recovery::Initialization>>>,
    fingerprint: Fingerprint,
    unbound_epoch: String,
    jobs: Mutex<HashMap<String, JobBinding>>,
    tracker: TaskTracker,
    closed: AtomicBool,
    shutdown: CancellationToken,
}
#[derive(Clone)]
struct JobBinding {
    id: String,
    dispatching: bool,
    watching: bool,
    watch_requested: bool,
    operation: Arc<tokio::sync::Mutex<RecoveryState>>,
}
#[derive(Default)]
struct RecoveryState {
    single: Option<u8>,
    batch: HashMap<usize, Option<u8>>,
}
impl JobBinding {
    fn new(id: String) -> Self {
        Self {
            id,
            dispatching: false,
            watching: false,
            watch_requested: false,
            operation: Arc::new(tokio::sync::Mutex::new(RecoveryState::default())),
        }
    }
}
impl TaskRuntime {
    pub fn new(
        provider: Arc<GenerationService>,
        images: Option<Arc<crate::images::ImageService>>,
        video: Option<Arc<crate::video::VideoService>>,
        shutdown: CancellationToken,
    ) -> Result<Self> {
        Ok(Self {
            provider,
            images,
            video,
            recoveries: Mutex::new(HashMap::new()),
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
    pub async fn submit(
        self: &Arc<Self>,
        storage: Storage,
        principal: String,
        mut request: Value,
    ) -> Result<Value> {
        self.check_running()?;
        let key = request["requestKey"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 200)
            .ok_or_else(|| ApiError::invalid("Invalid task request key"))?
            .to_owned();
        let kind: TaskKind = serde_json::from_value(request["kind"].clone()).map_err(|_| {
            ApiError::new(
                501,
                "TASK_PROVIDER_NOT_MIGRATED",
                "This task provider has not been migrated",
            )
        })?;
        if !request["input"].is_object() {
            return Err(ApiError::invalid("Task input must be an object"));
        }
        let mut frozen = json!({"kind":request["kind"],"input":null});
        frozen["input"] = request["input"].take();
        if let Some(context) = request.get_mut("context") {
            frozen["context"] = context.take();
        }
        let existing = storage
            .task(
                TaskCommand::Get {
                    task_id: None,
                    request_key: Some(key.clone()),
                },
                &principal,
            )
            .await?;
        let existing: Option<TaskRecord> = serde_json::from_value(existing)?;
        let codec = existing
            .as_ref()
            .and_then(|task| task.request_fingerprint_locale.as_deref())
            .map(Fingerprint::new)
            .transpose()?;
        let fingerprint = codec.as_ref().unwrap_or(&self.fingerprint).hash(&frozen);
        if let Some(existing) = existing {
            if existing.request_fingerprint != fingerprint {
                return Err(ApiError::new(
                    409,
                    "TASK_KEY_CONFLICT",
                    "Request key already belongs to different input",
                ));
            }
            return Ok(serde_json::to_value(existing)?);
        }
        if request["kind"] == "generation" {
            return Err(ApiError::new(
                410,
                "SD_RETIRED",
                "SD 新生成已退役；原任务可继续查询、收集或取消",
            ));
        }
        let prepared = self.prepare(kind, frozen["input"].take()).await?;
        self.check_running()?;
        let task_id = uuid::Uuid::new_v4().to_string();
        let now = now();
        let record = TaskRecord {
            task_id,
            workspace_id: storage.workspace_id().into(),
            principal_id: principal.clone(),
            request_key: key,
            request_fingerprint: fingerprint,
            request_fingerprint_locale: Some(self.fingerprint.locale.clone()),
            kind,
            provider: prepared.provider().into(),
            provider_fingerprint: self.binding(),
            upstream_id: None,
            status: TaskStatus::Queued,
            recovery_state: TaskRecoveryState::Normal,
            revision: 0,
            runtime_epoch: storage.runtime_epoch().into(),
            created_at: now,
            updated_at: now,
            submission_intent_at: None,
            submission_observed_at: None,
            cancel_requested_at: None,
            upstream_settled: false,
            execution_deadline: now + 3 * 60 * 60 * 1000,
            input: prepared
                .input()
                .as_object()
                .cloned()
                .ok_or_else(|| ApiError::invalid("Invalid prepared task input"))?,
            input_media_refs: vec![],
            result_state: ResultState::None,
            result_refs: vec![],
            delivery_state: DeliveryState::Unseen,
            error_code: None,
            metadata: serde_json::Map::from_iter([(
                "context".into(),
                frozen
                    .get_mut("context")
                    .map(Value::take)
                    .unwrap_or(json!({})),
            )]),
            checkpoint: None,
            parent_batch_id: None,
            step_index: None,
        };
        let (reply, received) = tokio::sync::oneshot::channel();
        let runtime = self.clone();
        // After transfer, a lost HTTP response cannot orphan an accepted job.
        // The runtime owns acceptance and dispatch; callers query the stable key.
        self.tracker.spawn(async move {
            let accepted = async {
                runtime.check_running()?;
                let result = storage
                    .task(
                        TaskCommand::Accept {
                            record: Box::new(record),
                        },
                        &principal,
                    )
                    .await?;
                let task: TaskRecord = serde_json::from_value(result["task"].clone())?;
                if result["created"] == true {
                    let id = task.task_id.clone();
                    runtime.jobs.lock().unwrap().insert(
                        identity(&storage, &id),
                        JobBinding {
                            dispatching: true,
                            ..JobBinding::new(String::new())
                        },
                    );
                    let dispatcher = runtime.clone();
                    let storage = storage.clone();
                    let principal = principal.clone();
                    runtime.tracker.spawn(async move {
                        dispatcher.dispatch(storage, principal, id, prepared).await;
                    });
                }
                Ok(serde_json::to_value(task)?)
            }
            .await;
            let _ = reply.send(accepted);
        });
        received.await.map_err(|_| {
            ApiError::new(
                503,
                "TASK_ACCEPT_UNKNOWN",
                "Query the original request key before retrying",
            )
        })?
    }
    pub async fn cancel(
        self: &Arc<Self>,
        storage: Storage,
        principal: String,
        key: String,
    ) -> Result<Value> {
        self.check_running()?;
        let task = storage
            .task(TaskCommand::Cancel { request_key: key }, &principal)
            .await?;
        let Some(task): Option<TaskRecord> = serde_json::from_value(task)? else {
            return Ok(Value::Null);
        };
        if task.upstream_settled {
            return Ok(serde_json::to_value(task)?);
        }
        let id = task.task_id.clone();
        if let Some(job) = self.job(&storage, &id).filter(|job| !job.is_empty()) {
            // The live registry proves ownership of WebUI's global interrupt.
            let _ = self.cancel_provider(task.kind, &job, &principal).await;
            return self.reconcile(&storage, &principal, &id).await;
        }
        self.reconcile(&storage, &principal, &id).await
    }
    pub async fn delivery(
        storage: &Storage,
        principal: &str,
        id: &str,
        state: &str,
    ) -> Result<Value> {
        let state: DeliveryState = serde_json::from_value(json!(state))
            .map_err(|_| ApiError::invalid("Invalid delivery state"))?;
        Ok(serde_json::to_value(
            patch(
                storage,
                principal,
                id,
                TaskPatch {
                    delivery_state: Some(state),
                    ..Default::default()
                },
            )
            .await?,
        )?)
    }
    pub async fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.provider.close().await;
        if let Some(images) = &self.images {
            images.close().await;
        }
        if let Some(video) = &self.video {
            video.close().await;
        }
        {
            // Serialize closure with read-triggered recovery registration.
            let _recoveries = self.recoveries.lock().unwrap();
            self.tracker.close();
        }
        self.tracker.wait().await;
    }
    fn binding(&self) -> String {
        self.fingerprint
            .hash(&self.provider.provider_identity(&self.unbound_epoch))
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
fn image_family(kind: TaskKind) -> Option<&'static str> {
    match kind {
        TaskKind::Anima => Some("anima"),
        TaskKind::Creative => Some("krea2"),
        _ => None,
    }
}

pub(super) async fn patch(
    storage: &Storage,
    principal: &str,
    id: &str,
    value: TaskPatch,
) -> Result<TaskRecord> {
    let current = TaskRuntime::get(storage, principal, id).await?;
    patch_at(storage, principal, id, current.revision, value).await
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
            .task(
                TaskCommand::Patch {
                    task_id: id.into(),
                    expected_revision: revision,
                    patch: Box::new(value.clone()),
                },
                principal,
            )
            .await;
        match result {
            Err(error) if error.code == "REVISION_CONFLICT" && attempt < 4 => {
                revision = TaskRuntime::get(storage, principal, id).await?.revision;
            }
            result => return Ok(serde_json::from_value(result?)?),
        }
    }
    unreachable!()
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
