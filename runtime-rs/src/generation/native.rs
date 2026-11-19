pub(crate) mod adapters;
mod config;
pub(crate) mod manga;
mod output;
use output::stage_text;
mod input;
mod model_layout;
pub(crate) use input::InputFile;
use input::RunFiles;
pub(crate) use model_layout::model_issue;
mod execution;
mod moss;
mod observations;
pub(in crate::generation) mod recovery;
pub(crate) mod resources;
mod results;
mod worker;
mod worker_job;
use super::*;
pub(crate) use config::{Settings, installed_runtime_for, load};
pub(super) use results::prune;
use std::{path::PathBuf, process::Stdio};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
pub(crate) use worker::ComfyLease;

pub(crate) struct Plan {
    pub input: Arc<Value>,
    pub settings: Settings,
    pub model_dir: PathBuf,
    pub mask_model_dir: Option<PathBuf>,
    pub upscale_model_path: Option<PathBuf>,
    pub init_image: std::sync::Mutex<Option<InputFile>>,
    pub last_frame: std::sync::Mutex<Option<InputFile>>,
    pub driving_media: std::sync::Mutex<Option<InputFile>>,
    pub reference_images: std::sync::Mutex<Vec<InputFile>>,
    pub mask_image: std::sync::Mutex<Option<InputFile>>,
    pub pen_lines: std::sync::Mutex<Option<InputFile>>,
    pub sketch_image: std::sync::Mutex<Option<InputFile>>,
    pub sketch_model_path: Option<PathBuf>,
    pub loras: Vec<Value>,
}
pub(crate) struct Engine {
    processes: Arc<crate::processes::Processes>,
    tokens: Mutex<HashMap<String, CancellationToken>>,
    pub(super) queue: std::sync::Mutex<VecDeque<String>>,
    slot: Arc<Semaphore>,
    pub(crate) gpu_owned: AtomicBool,
    comfy_leased: AtomicBool,
    admission: Arc<Semaphore>,
    worker: Mutex<Option<worker::Worker>>,
}
impl Default for Engine {
    fn default() -> Self {
        Self {
            processes: Arc::default(),
            tokens: Mutex::default(),
            queue: std::sync::Mutex::default(),
            slot: Arc::new(Semaphore::new(1)),
            gpu_owned: AtomicBool::new(false),
            comfy_leased: AtomicBool::new(false),
            admission: Arc::new(Semaphore::new(4)),
            worker: Mutex::new(None),
        }
    }
}
impl Engine {
    pub(super) fn pending(&self) -> usize {
        if self.comfy_leased.load(Ordering::SeqCst) {
            0
        } else {
            4 - self.admission.available_permits()
        }
    }
    pub async fn close(&self) {
        self.processes.close().await;
        if let Some(mut worker) = self.worker.lock().await.take() {
            let _ = worker.stop().await;
        }
    }
}
impl Service {
    pub(crate) fn remote_capacity(&self) -> Result<bool> {
        if self.inner.cancel.is_cancelled() || self.inner.closed.load(Ordering::Relaxed) {
            return Err(closed());
        }
        if self.inner.native.admission.is_closed() {
            return Err(worker::release_error());
        }
        Ok(self.inner.native.admission.available_permits() > 0)
    }

    pub(crate) fn reserve_native(
        &self,
        cancel: &CancellationToken,
    ) -> Result<OwnedSemaphorePermit> {
        if self.inner.closed.load(Ordering::Relaxed)
            || self.inner.cancel.is_cancelled()
            || cancel.is_cancelled()
        {
            return Err(closed());
        }
        self.inner
            .native
            .admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                if self.inner.native.admission.is_closed() {
                    worker::release_error()
                } else {
                    ApiError::new(
                        429,
                        "ANIMA_QUEUE_FULL",
                        "图像生成队列已满或正在交接显存，请稍后重试",
                    )
                }
            })
    }
    pub(crate) fn prepare_native(
        &self,
        plan: Plan,
        permit: OwnedSemaphorePermit,
        cancel: &CancellationToken,
    ) -> Result<Prepared> {
        if self.inner.closed.load(Ordering::Relaxed)
            || self.inner.cancel.is_cancelled()
            || cancel.is_cancelled()
        {
            return Err(closed());
        }
        // Worker cleanup can close admission while inputs are being prepared.
        if self.inner.native.admission.is_closed() {
            return Err(worker::release_error());
        }
        Ok(Prepared {
            input: plan.input.as_ref().clone(),
            execution: Execution::Native(Box::new(plan)),
            permit,
            gpu: None,
        })
    }
}
pub(super) async fn submit(inner: Arc<Inner>, job: Arc<Job>) {
    let token = inner.cancel.child_token();
    inner
        .native
        .tokens
        .lock()
        .await
        .insert(job.id.clone(), token.clone());
    // A checkpoint can expose the job to cancellation before token registration.
    if job.state.lock().await.status == "cancelling" {
        token.cancel();
    }
    let worker = inner.clone();
    inner.tasks.spawn(async move {
        let mut registered = false;
        let acquire = worker.native.slot.acquire();
        tokio::pin!(acquire);
        let slot = tokio::select! {
            biased;
            _ = token.cancelled() => Err(closed()),
            slot = std::future::poll_fn(|cx| {
                use std::future::Future;
                if !registered {
                    // Establish order in the same critical section as the first
                    // fair semaphore poll, including jobs from the video service.
                    let mut queue = worker.native.queue.lock().unwrap();
                    queue.push_back(job.id.clone());
                    registered = true;
                    acquire.as_mut().poll(cx)
                } else {
                    acquire.as_mut().poll(cx)
                }
            }) => slot.map_err(|_| {
                if token.is_cancelled() { closed() } else { worker::release_error() }
            }),
        };
        match slot {
            Ok(slot) => {
                job.started_at.store(now(), Ordering::Relaxed);
                worker.native.gpu_owned.store(true, Ordering::SeqCst);
                let outcome = worker_job::run(&worker, &job, &token).await;
                // Hold the GPU slot through the cancellation acknowledgement
                // and publication. No next job may run before worker cleanup.
                if settle(&worker, &job, outcome, token.is_cancelled()).await {
                    worker.native.slot.close();
                    worker.native.admission.close();
                    worker.admission.close();
                    slot.forget();
                } else if worker.native.worker.lock().await.is_none() {
                    worker.native.gpu_owned.store(false, Ordering::SeqCst);
                }
            }
            Err(error) => {
                settle(&worker, &job, Err(error), token.is_cancelled()).await;
            }
        }
        if registered {
            worker
                .native
                .queue
                .lock()
                .unwrap()
                .retain(|id| id != &job.id);
        }
        worker.native.tokens.lock().await.remove(&job.id);
    });
}
async fn settle(
    inner: &Arc<Inner>,
    job: &Arc<Job>,
    outcome: Result<Output>,
    token_cancelled: bool,
) -> bool {
    // Queued cancellation and early failures never reach the private-file copy.
    // Historical jobs retain recipes/results, not their admitted image buffers.
    if let Execution::Native(plan) = &job.execution {
        plan.init_image.lock().unwrap().take();
        plan.reference_images.lock().unwrap().clear();
        plan.last_frame.lock().unwrap().take();
        plan.driving_media.lock().unwrap().take();
        plan.mask_image.lock().unwrap().take();
        plan.pen_lines.lock().unwrap().take();
        plan.sketch_image.lock().unwrap().take();
    }
    let error = match outcome {
        Ok(output) => {
            jobs::succeed(inner, job, output).await;
            // Cancellation can win between worker completion and publication.
            // succeed intentionally refuses publication in cancelling state.
            if job.state.lock().await.status == "cancelling" {
                // run already received ready; publication cancellation cannot
                // make its clean resident model unsafe for the next request.
                cancelled(job).await;
                if let Some(archive) = inner.archive_for(job) {
                    archive.finish(job, "cancelled", None, None).await;
                }
            }
            return false;
        }
        Err(error) => error,
    };
    let unconfirmed = error.code == "TERMINATION_UNCONFIRMED";
    let mut state = job.state.lock().await;
    if unconfirmed {
        state.status = "failed".into();
        state.unknown = true;
        state.settled = false;
        state.code = Some(error.code);
        state.error = Some(error.message);
    } else {
        // Decide under the same lock as cancel, including cancellation
        // accepted before a process/token was registered.
        if token_cancelled || state.status == "cancelling" {
            state.status = "cancelled".into();
        } else {
            state.status = "failed".into();
            state.code = Some(error.code);
            state.error = Some(error.message);
        }
        state.unknown = false;
        state.settled = true;
        state.finished = Some(now());
        state.permit.take();
    }
    let archive_status = if inner.cancel.is_cancelled() {
        "interrupted"
    } else {
        &state.status
    }
    .to_owned();
    let archive_error = state.error.clone();
    let archive_code = state.code.clone();
    drop(state);
    job.notify.notify_waiters();
    jobs::notify_settled(job);
    if let Some(archive) = inner.archive_for(job) {
        archive
            .finish(
                job,
                &archive_status,
                archive_error.as_deref(),
                archive_code.as_deref(),
            )
            .await;
    }
    unconfirmed
}
async fn cancelled(job: &Job) {
    let mut state = job.state.lock().await;
    if terminal(&state.status) {
        return;
    }
    state.status = "cancelled".into();
    state.settled = true;
    state.unknown = false;
    state.finished = Some(now());
    state.permit.take();
    drop(state);
    job.notify.notify_waiters();
    jobs::notify_settled(job);
}
pub(super) async fn cancel(inner: Arc<Inner>, job: Arc<Job>) -> Result<()> {
    let _collection = job.collection.lock().await;
    let mut state = job.state.lock().await;
    if state.status == "succeeded" && state.result_sha256.is_some() {
        return Ok(());
    }
    if state.status == "succeeded" && state.collection_pending {
        state.status = "cancelled".into();
        drop(state);
        jobs::discard_output(&job).await;
        snapshots::remove(&inner, &job.id).await;
        job.notify.notify_waiters();
        jobs::notify_settled(&job);
        return Ok(());
    }
    if !terminal(&state.status) {
        state.status = "cancelling".into();
        if let Some(token) = inner.native.tokens.lock().await.get(&job.id) {
            token.cancel();
        }
    }
    Ok(())
}
fn protocol_error() -> ApiError {
    ApiError::new(502, "NATIVE_PROTOCOL_ERROR", "独立推理协议或结果无效")
}
