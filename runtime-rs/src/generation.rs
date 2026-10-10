mod comfy;
mod constants;
mod decoder;
mod http;
mod jobs;
pub(crate) mod native;
mod output;
mod plan;
mod probe;
mod recovery;
mod resources;
mod service;
mod snapshots;
mod transport;
mod types;
mod validation;
mod video_output;
mod webui;
mod webui_results;
mod workflow;

use crate::{
    error::{ApiError, Result},
    execution::{ExecutionHooks, Observation, Output},
    upstream::LocalUpstream,
};
pub(crate) use http::{RateLimit, limit_request, owner as request_owner};
use plan::Execution;
pub(crate) use plan::{ComfyPlan, MediaKind};
pub use resources::{is_wai_checkpoint, normalize_checkpoint};
pub(crate) use resources::{super_res, super_res_name};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Notify, OnceCell, OwnedSemaphorePermit, Semaphore};
use tokio_util::{sync::CancellationToken, task::TaskTracker};
pub use types::{Config, Input};
pub use validation::validate;
pub(crate) use validation::{adult_intent, truthy};
pub use workflow::build as build_workflow;

/// Prepared owns admission capacity and the validated execution input. Its public
/// JSON is a detached ledger copy; changing it cannot change an admitted request.
pub struct Prepared {
    pub input: Value,
    pub provider: String,
    execution: Execution,
    selected: &'static str,
    permit: OwnedSemaphorePermit,
}

#[derive(Clone)]
pub struct Service {
    inner: Arc<Inner>,
    _life: Arc<Life>,
}
pub type GenerationService = Service;
pub fn router(service: Arc<GenerationService>) -> axum::Router<crate::AppState> {
    http::router(service)
}
struct Life {
    cancel: CancellationToken,
}
impl Drop for Life {
    fn drop(&mut self) {
        self.cancel.cancel();
    }
}

struct Inner {
    native: native::Engine,
    native_images: bool,
    native_settings: native::Settings,
    scope: Scope,
    config: Config,
    transport: LocalUpstream,
    decoder: decoder::Decoder,
    cancel: CancellationToken,
    closed: AtomicBool,
    admission: Arc<Semaphore>,
    state: Mutex<State>,
    tasks: TaskTracker,
    probe_lock: Mutex<()>,
    probe_cache: Mutex<Option<(Instant, types::WebUiStatus)>>,
    probe_generation: AtomicU64,
    initialized: OnceCell<Initialized>,
}
#[derive(Clone, Copy)]
enum Scope {
    Wai,
    Images,
    Video,
}
impl Scope {
    fn capacity(self) -> usize {
        match self {
            Self::Wai | Self::Images => constants::MAX_PENDING,
            Self::Video => 2,
        }
    }
    fn namespace(self) -> &'static str {
        match self {
            Self::Wai => "wai",
            Self::Images => "anima",
            Self::Video => "video",
        }
    }
    fn client(self) -> &'static str {
        match self {
            Self::Wai => "sd",
            Self::Images => "anima",
            Self::Video => "video",
        }
    }
}
struct Initialized {
    client_id: String,
    session_id: String,
    progress: std::sync::Mutex<Option<crate::upstream::progress::ProgressMonitor>>,
}
#[derive(Default)]
struct State {
    jobs: HashMap<String, Arc<Job>>,
    lost: HashMap<String, Lost>,
    queue: VecDeque<Arc<Job>>,
    runner: bool,
}
struct Job {
    id: String,
    owner: String,
    input: Value,
    execution: Execution,
    provider: &'static str,
    created: i64,
    state: Mutex<JobState>,
    collection: Mutex<()>,
    notify: Notify,
    hooks: Option<Arc<dyn ExecutionHooks>>,
}
struct Lost {
    owner: String,
    family: Option<String>,
}
struct JobState {
    collection_pending: bool,
    status: String,
    result: Option<Output>,
    error: Option<String>,
    code: Option<String>,
    metadata: Value,
    upstream_id: String,
    progress: Option<f64>,
    current_node: Option<String>,
    progress_text: String,
    history_urgent: bool,
    history_finishing: Option<tokio::time::Instant>,
    progress_live: bool,
    execution_started: bool,
    finished: Option<i64>,
    settled: bool,
    unknown: bool,
    observed: bool,
    interrupt_pending: bool,
    cancel_acknowledged: bool,
    cancel_deadline: Option<Instant>,
    cancel_checks: u8,
    permit: Option<OwnedSemaphorePermit>,
}

impl Service {
    pub(crate) fn native_settings(&self) -> Result<native::Settings> {
        Ok(self.inner.native_settings.clone())
    }
    pub(crate) fn native_enabled(&self) -> bool {
        self.inner.native_settings.engine == "native"
    }
    pub fn new(
        config: Config,
        transport: LocalUpstream,
        shutdown: CancellationToken,
    ) -> Result<Self> {
        Self::with_scope(config, transport, shutdown, Scope::Wai)
    }
    fn with_scope(
        config: Config,
        transport: LocalUpstream,
        shutdown: CancellationToken,
        scope: Scope,
    ) -> Result<Self> {
        crate::upstream::local_url(&config.sd_host)?;
        crate::upstream::local_url(&config.comfy_host)?;
        let cancel = shutdown.child_token();
        let native_settings = native::load(&config)?;
        let inner = Arc::new(Inner {
            native: native::Engine::default(),
            native_images: matches!(scope, Scope::Images) && native_settings.engine == "native",
            native_settings,
            scope,
            config,
            transport,
            decoder: decoder::Decoder::default(),
            cancel: cancel.clone(),
            closed: AtomicBool::new(false),
            admission: Arc::new(Semaphore::new(scope.capacity())),
            state: Mutex::new(State::default()),
            tasks: TaskTracker::new(),
            probe_lock: Mutex::new(()),
            probe_cache: Mutex::new(None),
            probe_generation: AtomicU64::new(0),
            initialized: OnceCell::new(),
        });
        Ok(Self {
            inner,
            _life: Arc::new(Life { cancel }),
        })
    }
    pub async fn prepare(
        &self,
        raw: Value,
        direct_local: bool,
        cancel: CancellationToken,
    ) -> Result<Prepared> {
        service::prepare(self.inner.clone(), raw, direct_local, cancel).await
    }
    pub async fn submit(
        self: Arc<Self>,
        prepared: Prepared,
        owner: String,
        hooks: Option<Arc<dyn ExecutionHooks>>,
    ) -> Result<Value> {
        if self.inner.closed.load(Ordering::Relaxed) {
            return Err(closed());
        }
        let (reply, result) = tokio::sync::oneshot::channel();
        let inner = self.inner.clone();
        self.inner.tasks.spawn(async move {
            let value = service::submit(inner, prepared, owner, hooks).await;
            let _ = reply.send(value);
        });
        result.await.map_err(|_| {
            ApiError::new(
                503,
                "GENERATION_SUBMIT_UNKNOWN",
                "生成提交结果未知，请通过任务标识查询",
            )
        })?
    }
    pub async fn get_status(&self) -> Result<Value> {
        service::status(self.inner.clone()).await
    }
    pub async fn get_job(&self, id: &str, owner: &str) -> Result<Value> {
        let job = jobs::find(&self.inner, id, owner, false).await?;
        jobs::public(&job).await
    }
    pub async fn query(&self, id: &str, owner: &str) -> Result<Observation> {
        jobs::observe(&self.inner, id, owner).await
    }
    pub async fn result(&self, id: &str, owner: &str) -> Result<Output> {
        jobs::result(&self.inner, id, owner).await
    }
    pub async fn cancel(&self, id: &str, owner: &str) -> Result<Value> {
        let job = jobs::find(&self.inner, id, owner, false).await?;
        if job.provider == "native" {
            native::cancel(self.inner.clone(), job.clone()).await?;
        } else if job.provider == "webui" {
            webui::cancel(self.inner.clone(), job.clone()).await?;
        } else {
            comfy::cancel(self.inner.clone(), job.clone()).await?;
        }
        jobs::public(&job).await
    }
    pub async fn close(&self) {
        service::close(self.inner.clone()).await;
    }
}
fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
fn terminal(status: &str) -> bool {
    matches!(status, "succeeded" | "failed" | "cancelled")
}
fn closed() -> ApiError {
    ApiError::new(503, "GENERATION_CLOSED", "生成服务已关闭")
}
