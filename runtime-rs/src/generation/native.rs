pub(crate) mod adapters;
mod config;
pub(crate) mod manga;
mod output;
use output::stage_text;
mod model_layout;
pub(crate) use model_layout::model_issue;
pub(crate) mod resources;
mod observations;
mod results;
pub(in crate::generation) mod recovery;
mod worker;
pub(crate) use worker::ComfyLease;
use super::*;
pub(crate) use config::{Settings, load, installed_runtime_for};
pub(super) use results::prune;
use std::{path::PathBuf, process::Stdio};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

pub(crate) struct Plan {
    pub input: Arc<Value>,
    pub settings: Settings,
    pub model_dir: PathBuf,
    pub mask_model_dir: Option<PathBuf>,
    pub upscale_model_path: Option<PathBuf>,
    pub init_image: std::sync::Mutex<Option<Arc<Vec<u8>>>>,
    pub reference_images: std::sync::Mutex<Vec<Arc<Vec<u8>>>>,
    pub mask_image: std::sync::Mutex<Option<Arc<Vec<u8>>>>,
    pub pen_lines: std::sync::Mutex<Option<Arc<Vec<u8>>>>,
    pub sketch_image: std::sync::Mutex<Option<Arc<Vec<u8>>>>,
    pub sketch_model_path: Option<PathBuf>,
    pub loras: Vec<Value>,
}
pub(crate) struct Engine {
    processes: Arc<crate::processes::Processes>,
    tokens: Mutex<HashMap<String, CancellationToken>>,
    slot: Arc<Semaphore>,
    pub(crate) gpu_owned: AtomicBool,
    comfy_leased: AtomicBool,
    admission: Arc<Semaphore>,
    worker: Mutex<Option<worker::Worker>>,
    idle_timeout: Duration,
}
impl Default for Engine {
    fn default() -> Self {
        Self {
            processes: Arc::default(),
            tokens: Mutex::default(),
            slot: Arc::new(Semaphore::new(1)),
            gpu_owned: AtomicBool::new(false),
            comfy_leased: AtomicBool::new(false),
            admission: Arc::new(Semaphore::new(4)),
            worker: Mutex::new(None),
            idle_timeout: Duration::from_secs(600),
        }
    }
}
impl Engine {
    pub(super) fn pending(&self) -> usize {
        if self.comfy_leased.load(Ordering::SeqCst) { 0 } else { 4 - self.admission.available_permits() }
    }
    pub async fn close(&self) {
        self.processes.close().await;
        if let Some(mut worker) = self.worker.lock().await.take() {
            let _ = worker.stop().await;
        }
    }
}
impl Service {
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
            provider: "native".into(),
            execution: Execution::Native(Box::new(plan)),
            selected: "native",
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
        let slot = tokio::select! {
            biased;
            _ = token.cancelled() => Err(closed()),
            slot = worker.native.slot.acquire() => slot.map_err(|_| {
                if token.is_cancelled() { closed() } else { worker::release_error() }
            }),
        };
        match slot {
            Ok(slot) => {
                worker.native.gpu_owned.store(true,Ordering::SeqCst);
                let outcome = run(&worker, &job, &token).await;
                // Hold the GPU slot through the cancellation acknowledgement
                // and publication. No next job may run before worker cleanup.
                if settle(&worker, &job, outcome, token.is_cancelled()).await {
                    worker.native.slot.close();
                    worker.native.admission.close();
                    worker.admission.close();
                    slot.forget();
                } else if worker.native.worker.lock().await.is_none() {
                    worker.native.gpu_owned.store(false,Ordering::SeqCst);
                }
            }
            Err(error) => {
                settle(&worker, &job, Err(error), token.is_cancelled()).await;
            }
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
    drop(state);
    job.notify.notify_waiters();
    jobs::notify_settled(job);
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
    if state.status == "succeeded" && state.collection_pending {
        state.status = "cancelled".into();
        drop(state);
        jobs::discard_output(&job).await;
        snapshots::remove(&inner, &job.id).await;
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
async fn run(inner: &Arc<Inner>, job: &Arc<Job>, token: &CancellationToken) -> Result<Output> {
    let Execution::Native(plan) = &job.execution else {
        unreachable!()
    };
    let control = inner.control.read().unwrap().upgrade();
    if let Some(control) = control
        .filter(|_| plan.input["family"] != "manga-screen" || plan.input["rewrite"].is_object())
    {
        control.ensure_native_drawing(token).await?;
    }
    if let Some(hooks) = &job.hooks {
        tokio::select! { biased; _=token.cancelled()=>return Err(closed()), result=hooks.submitting("native".into())=>result? }
    }
    if token.is_cancelled() || job.state.lock().await.status == "cancelling" {
        return Err(ApiError::new(499, "ABORT_ERR", "独立推理已取消"));
    }
    let output_dir = inner.config.runtime_root.join("outputs/native");
    tokio::fs::create_dir_all(&output_dir).await?;
    let temp = Arc::new(
        tempfile::Builder::new()
            .prefix("native-")
            .tempdir_in(&output_dir)?,
    );
    let video = plan.input["mediaKind"] == "video";
    let output = temp
        .path()
        .join(if video { "result.mp4" } else { "result.png" });
    // Pass only accepted original bytes, never a mutable upload path. The request
    // and owned process retain this directory until ready or confirmed retirement.
    let init_image = plan.init_image.lock().unwrap().take();
    let input_image_path = if let Some(bytes) = init_image {
        let path = temp.path().join("input-image");
        let mut file = tokio::fs::File::create(&path).await?;
        file.write_all(bytes.as_slice()).await?;
        file.flush().await?;
        Some(path)
    } else {
        None
    };
    let mask_image = plan.mask_image.lock().unwrap().take();
    let mask_image_path = if let Some(bytes) = mask_image {
        let path = temp.path().join("mask-image");
        let mut file = tokio::fs::File::create(&path).await?;
        file.write_all(bytes.as_slice()).await?;
        file.flush().await?;
        Some(path)
    } else {
        None
    };
    let pen_lines = plan.pen_lines.lock().unwrap().take();
    let pen_lines_path = if let Some(bytes) = pen_lines {
        let path = temp.path().join("pen-lines");
        let mut file = tokio::fs::File::create(&path).await?;
        file.write_all(bytes.as_slice()).await?;
        file.flush().await?;
        Some(path)
    } else {
        None
    };
    let sketch_image = plan.sketch_image.lock().unwrap().take();
    let sketch_image_path = if let Some(bytes) = sketch_image {
        let path = temp.path().join("sketch-image");
        let mut file = tokio::fs::File::create(&path).await?;
        file.write_all(bytes.as_slice()).await?;
        file.flush().await?;
        Some(path)
    } else { None };
    let references = std::mem::take(&mut *plan.reference_images.lock().unwrap());
    let mut reference_paths = Vec::new();
    for (index, bytes) in references.into_iter().enumerate() {
        if token.is_cancelled() { return Err(ApiError::new(499, "ABORT_ERR", "参考图准备已取消")); }
        let path = temp.path().join(format!("reference-{index}"));
        let mut file = tokio::fs::File::create(&path).await?;
        file.write_all(bytes.as_slice()).await?;
        file.flush().await?;
        reference_paths.push(path);
    }
    let mut request = if plan.input["family"] == "manga-screen" {
        output::manga_request(job, plan, &output, input_image_path, pen_lines_path)
    } else if adapters::model(plan.input["modelId"].as_str().unwrap_or("")).is_some() {
        output::adapter_request(job, plan, &output, input_image_path)
    } else {
        output::anima_request(job, plan, &output, input_image_path, mask_image_path, sketch_image_path)
    };
    if !reference_paths.is_empty() { request["referenceImagePaths"] = json!(reference_paths); }
    let mut worker = inner.native.take_worker(&plan.settings).await?;
    *worker.current_temp.lock().unwrap() = Some(temp.clone());
    // Do not interrupt a partially written JSONL request with another command.
    // The stdin reader operates independently of loading and CUDA execution.
    let sent = tokio::time::timeout(Duration::from_secs(10), async {
        worker
            .input
            .write_all(format!("{}\n", request).as_bytes())
            .await?;
        worker.input.flush().await
    })
    .await;
    match sent {
        Ok(Ok(())) => {}
        value => {
            worker.stop().await?;
            return match value {
                Ok(Err(error)) => Err(error.into()),
                _ => Err(ApiError::new(504, "NATIVE_TIMEOUT", "独立推理请求发送超时")),
            };
        }
    }
    let mut produced = false;
    let mut ready = false;
    let mut host_failure = false;
    let result = async {
        let mut runtime_observation = Value::Null;
        let events = async {
            {
                let mut state = job.state.lock().await;
                if state.status == "cancelling" {
                    return Err(ApiError::new(499, "ABORT_ERR", "独立推理已取消"));
                }
                state.status = "running".into();
                state.upstream_id = job.id.clone();
                state.progress_text = "独立推理加载模型".into();
            }
            if let Some(hooks) = &job.hooks {
                hooks
                    .observed(
                        job.id.clone(),
                        json!({"gatewayJobId":job.id,"provider":"native"}),
                    )
                    .await?;
            }
            loop {
                let event = worker.event(&job.id).await?;
                match event["event"].as_str() {
                    Some("stage") if !produced => {
                        let text = stage_text(&event)?;
                        let mut state = job.state.lock().await;
                        state.progress_text = text;
                        if plan.input["family"] == "manga-screen" {
                            state.progress = None;
                        }
                    }
                    Some("progress") if !produced => {
                        let step = event["step"].as_u64().ok_or_else(protocol_error)?;
                        let total = event["total"]
                            .as_u64()
                            .filter(|n| *n > 0 && step <= *n)
                            .ok_or_else(protocol_error)?;
                        let mut state = job.state.lock().await;
                        state.progress = Some(step as f64 / total as f64);
                        state.progress_text = format!("独立推理 {step}/{total}");
                    }
                    Some("result") if !produced => {
                        if event["outputPath"].as_str() != output.to_str() {
                            return Err(protocol_error());
                        }
                        runtime_observation = observations::capture(&event["nativeRuntime"]);
                        produced = true;
                    }
                    Some("ready") if produced => {
                        ready = true;
                        return Ok(());
                    }
                    Some("error") => {
                        return Err(ApiError::new(
                            502,
                            event["code"].as_str().unwrap_or("NATIVE_EXECUTION_FAILED"),
                            event["message"].as_str().unwrap_or("独立推理失败"),
                        ));
                    }
                    _ => return Err(protocol_error()),
                }
            }
        };
        events.await?;
        // Output paths are chosen by this runtime, never accepted from worker input.
        let metadata = tokio::fs::symlink_metadata(&output).await?;
        if !metadata.is_file()
            || metadata.file_type().is_symlink()
            || metadata.len()
                > if video {
                    256 * 1024 * 1024
                } else {
                    32 * 1024 * 1024
                }
        {
            return Err(protocol_error());
        }
        if let Err(error) = output::validate(&output, video, token).await {
            // Host decoder admission says nothing about worker integrity.
            host_failure = error.code == "IMAGE_STORAGE_BUSY";
            return Err(error);
        }
        manga::validate(job, &output, token).await?;
        let length = metadata.len();
        // Do not block cancellation or observation while reading the PNG header.
        let read_dimensions = plan.input["family"] == "manga-screen"
            && job.state.lock().await.status == "running";
        let dimensions = if read_dimensions {
            Some(output::png_dimensions(&output).await)
        } else {
            None
        };
        {
            let mut state = job.state.lock().await;
            if state.status == "running" {
                let metadata = Arc::make_mut(&mut state.metadata);
                metadata["nativeRuntime"] = runtime_observation;
                if let Some(dimensions) = dimensions {
                    let (width, height) = dimensions?;
                    metadata["width"] = json!(width);
                    metadata["height"] = json!(height);
                }
            }
        }
        let publication = results::publish(inner, job, &output, length, token).await;
        // Only classify storage failures after the worker's PNG fully decoded.
        host_failure = publication
            .as_ref()
            .err()
            .is_some_and(|error| error.code == "STORAGE_UNAVAILABLE");
        publication
    };
    let value = tokio::select! { biased; _=token.cancelled()=>Err(ApiError::new(499,"ABORT_ERR","独立推理已取消")), value=tokio::time::timeout(Duration::from_secs(if video {1800} else {600}),result)=>value.unwrap_or_else(|_| Err(ApiError::new(504,"NATIVE_TIMEOUT","独立推理超时"))) };
    let cancelling = value.as_ref().err().is_some_and(|error| {
        token.is_cancelled() && matches!(error.code.as_str(), "ABORT_ERR" | "CANCELLED")
    });
    let retain = if value.is_ok() || (ready && (cancelling || host_failure)) {
        true
    } else if cancelling {
        match worker.cancel_and_wait(&job.id, produced, &output).await {
            Ok(()) => true,
            Err(error) => {
                eprintln!("native cooperative cancellation: {}", error.code);
                false
            }
        }
    } else {
        false
    };
    if retain {
        // Ready confirms worker-side cleanup; the request keeps its directory Arc.
        worker.current_temp.lock().unwrap().take();
        Engine::retain_worker(inner.clone(), worker).await;
        return value;
    }
    // Unacknowledged cancellation, faults and timeouts still retire the process
    // while its process entry retains the temporary inputs through reap.
    worker.stop().await?;
    value
}
fn protocol_error() -> ApiError {
    ApiError::new(502, "NATIVE_PROTOCOL_ERROR", "独立推理协议或结果无效")
}
