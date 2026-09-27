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
    recoveries: Mutex<HashMap<String, Arc<tokio::sync::OnceCell<()>>>>,
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
    pub async fn get(storage: &Storage, principal: &str, id: &str) -> Result<Value> {
        let task = storage
            .request(json!({"kind":"task.get","taskId":id}), principal)
            .await?;
        if task.is_null() {
            Err(ApiError::new(404, "TASK_NOT_FOUND", "Task does not exist"))
        } else {
            Ok(task)
        }
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
        request: Value,
    ) -> Result<Value> {
        self.check_running()?;
        let key = request["requestKey"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 200)
            .ok_or_else(|| ApiError::invalid("Invalid task request key"))?;
        let kind = request["kind"].as_str().unwrap_or("");
        if !["generation", "anima", "creative", "video", "batch"].contains(&kind) {
            return Err(ApiError::new(
                501,
                "TASK_PROVIDER_NOT_MIGRATED",
                "This task provider has not been migrated",
            ));
        }
        if !request["input"].is_object() {
            return Err(ApiError::invalid("Task input must be an object"));
        }
        let mut frozen = json!({"kind":request["kind"],"input":request["input"]});
        if let Some(context) = request.get("context") {
            frozen["context"] = context.clone();
        }
        let existing = storage
            .request(json!({"kind":"task.get","requestKey":key}), &principal)
            .await?;
        let codec = existing["requestFingerprintLocale"]
            .as_str()
            .map(Fingerprint::new)
            .transpose()?;
        let fingerprint = codec.as_ref().unwrap_or(&self.fingerprint).hash(&frozen);
        if !existing.is_null() {
            if existing["requestFingerprint"] != fingerprint {
                return Err(ApiError::new(
                    409,
                    "TASK_KEY_CONFLICT",
                    "Request key already belongs to different input",
                ));
            }
            return Ok(existing);
        }
        let prepared = self.prepare(kind, request["input"].clone()).await?;
        self.check_running()?;
        let task_id = uuid::Uuid::new_v4().to_string();
        let now = now();
        let record = json!({"taskId":task_id,"workspaceId":storage.workspace_id(),"principalId":principal,
            "requestKey":key,"requestFingerprint":fingerprint,"requestFingerprintLocale":self.fingerprint.locale,
            "kind":kind,"provider":prepared.provider(),"providerFingerprint":self.binding(&storage),"upstreamId":null,
            "status":"queued","recoveryState":"normal","revision":0,"runtimeEpoch":storage.runtime_epoch(),
            "createdAt":now,"updatedAt":now,"submissionIntentAt":null,"submissionObservedAt":null,"cancelRequestedAt":null,
            "upstreamSettled":false,"executionDeadline":now+3*60*60*1000,"input":prepared.input(),"inputMediaRefs":[],
            "resultState":"none","resultRefs":[],"deliveryState":"unseen","errorCode":null,
            "metadata":{"context":request.get("context").cloned().unwrap_or(json!({}))},"checkpoint":null,"parentBatchId":null,"stepIndex":null});
        let (reply, received) = tokio::sync::oneshot::channel();
        let runtime = self.clone();
        // After transfer, a lost HTTP response cannot orphan an accepted job.
        // The runtime owns acceptance and dispatch; callers query the stable key.
        self.tracker.spawn(async move {
            let accepted = async {
                runtime.check_running()?;
                let result = storage
                    .request(json!({"kind":"task.accept","record":record}), &principal)
                    .await?;
                let task = result["task"].clone();
                if result["created"] == true {
                    let id = task["taskId"].as_str().unwrap().to_owned();
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
                Ok(task)
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
            .request(json!({"kind":"task.cancel","requestKey":key}), &principal)
            .await?;
        if task.is_null() || task["upstreamSettled"] == true {
            return Ok(task);
        }
        let id = text(&task, "taskId")?.to_owned();
        if let Some(job) = self.job(&storage, &id).filter(|job| !job.is_empty()) {
            // The live registry proves ownership of WebUI's global interrupt.
            let _ = self
                .cancel_provider(text(&task, "kind")?, &job, &principal)
                .await;
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
        if !["unseen", "seen", "saved", "discarded"].contains(&state) {
            return Err(ApiError::invalid("Invalid delivery state"));
        }
        patch(storage, principal, id, json!({"deliveryState":state})).await
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
        self.tracker.close();
        self.tracker.wait().await;
    }
    fn binding(&self, _storage: &Storage) -> String {
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
fn image_family(kind: &str) -> Option<&'static str> {
    match kind {
        "anima" => Some("anima"),
        "creative" => Some("krea2"),
        _ => None,
    }
}

pub(super) async fn patch(
    storage: &Storage,
    principal: &str,
    id: &str,
    value: Value,
) -> Result<Value> {
    for attempt in 0..5 {
        let current = TaskRuntime::get(storage, principal, id).await?;
        let result = storage.request(json!({"kind":"task.patch","taskId":id,"expectedRevision":current["revision"],"patch":value}),principal).await;
        match result {
            Err(error) if error.code == "REVISION_CONFLICT" && attempt < 4 => continue,
            result => return result,
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
