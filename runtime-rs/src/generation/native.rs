mod config;
mod model_layout;
pub(crate) use model_layout::model_issue;
mod observations;
mod results;
mod worker;
use super::*;
pub(crate) use config::{Settings, load};
pub(super) use results::prune;
use std::{path::PathBuf, process::Stdio};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

pub(crate) struct Plan {
    pub input: Value,
    pub settings: Settings,
    pub model_dir: PathBuf,
    pub mask_model_dir: Option<PathBuf>,
    pub tea_cache_profile_path: Option<PathBuf>,
    pub upscale_model_path: Option<PathBuf>,
    pub init_image: std::sync::Mutex<Option<Arc<Vec<u8>>>>,
    pub mask_image: std::sync::Mutex<Option<Arc<Vec<u8>>>>,
    pub loras: Vec<Value>,
}
pub(super) struct Engine {
    processes: Arc<crate::processes::Processes>,
    tokens: Mutex<HashMap<String, CancellationToken>>,
    slot: Semaphore,
    worker: Mutex<Option<worker::Worker>>,
    idle_timeout: Duration,
}
impl Default for Engine {
    fn default() -> Self {
        Self {
            processes: Arc::default(),
            tokens: Mutex::default(),
            slot: Semaphore::new(1),
            worker: Mutex::new(None),
            idle_timeout: Duration::from_secs(600),
        }
    }
}
impl Engine {
    pub async fn close(&self) {
        self.processes.close().await;
        if let Some(mut worker) = self.worker.lock().await.take() {
            let _ = worker.stop().await;
        }
    }
}
impl Service {
    pub(crate) fn reserve_native(&self, cancel: &CancellationToken) -> Result<OwnedSemaphorePermit> {
        if self.inner.closed.load(Ordering::Relaxed)
            || self.inner.cancel.is_cancelled()
            || cancel.is_cancelled()
        {
            return Err(closed());
        }
        self.inner
            .admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| {
                if self.inner.admission.is_closed() {
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
        if self.inner.admission.is_closed() {
            return Err(worker::release_error());
        }
        Ok(Prepared {
            input: plan.input.clone(),
            provider: "native".into(),
            execution: Execution::Native(Box::new(plan)),
            selected: "native",
            permit,
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
                let outcome = run(&worker, &job, &token).await;
                // Hold the GPU slot through the cancellation acknowledgement
                // and publication. No next job may run before worker cleanup.
                if settle(&worker, &job, outcome, token.is_cancelled()).await {
                    worker.native.slot.close();
                    worker.admission.close();
                    slot.forget();
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
        plan.mask_image.lock().unwrap().take();
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
    let mut state = job.state.lock().await;
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
    if let Some(control) = control {
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
    let temp = tempfile::Builder::new()
        .prefix("native-")
        .tempdir_in(&output_dir)?;
    let output = temp.path().join("result.png");
    let mut input = json!({"negativePrompt":plan.input["negative"]});
    for key in [
        "prompt",
        "width",
        "height",
        "steps",
        "cfg",
        "seed",
        "family",
        "modelId",
        "sampler",
        "scheduler",
        "teaCache",
        "hiresFix",
        "hiresScale",
        "hiresDenoise",
        "hiresUpscaler",
        "superResModel",
        "hiresSampler",
        "hiresScheduler",
        "rcasStrength",
    ] {
        input[key] = plan.input[key].clone();
    }
    input["teaCacheAuto"] = json!(plan.input["teaCacheAuto"] == true);
    if let Some(threshold) = plan.input.get("teaCacheThresh") {
        input["teaCacheThresh"] = threshold.clone();
    }
    // Pass only accepted original bytes, never a mutable upload path. Each job
    // owns this temporary copy until its child process has been reaped.
    let init_image = plan.init_image.lock().unwrap().take();
    let input_image_path = if let Some(bytes) = init_image {
        input["denoisingStrength"] = plan.input["denoisingStrength"].clone();
        let path = temp.path().join("input-image");
        let mut file = tokio::fs::File::create(&path).await?;
        file.write_all(bytes.as_slice()).await?;
        file.flush().await?;
        Some(path)
    } else {
        None
    };
    if plan.mask_model_dir.is_some() {
        for key in ["maskPrompt", "maskThreshold", "growMaskBy"] {
            input[key] = plan.input[key].clone();
        }
    }
    let mask_image = plan.mask_image.lock().unwrap().take();
    let mask_image_path = if let Some(bytes) = mask_image {
        input["growMaskBy"] = plan.input["growMaskBy"].clone();
        let path = temp.path().join("mask-image");
        let mut file = tokio::fs::File::create(&path).await?;
        file.write_all(bytes.as_slice()).await?;
        file.flush().await?;
        Some(path)
    } else {
        None
    };
    let request = json!({"id":job.id,"op":"generate","modelDir":plan.model_dir,"maskModelDir":plan.mask_model_dir,"teaCacheProfilePath":plan.tea_cache_profile_path,"upscaleModelPath":plan.upscale_model_path,"outputPath":output,"input":input,"inputImagePath":input_image_path,"maskImagePath":mask_image_path,"loras":plan.loras});
    let mut worker = inner.native.take_worker(&plan.settings).await?;
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
            || metadata.len() > 32 * 1024 * 1024
        {
            return Err(protocol_error());
        }
        let bytes = tokio::fs::read(&output).await?;
        if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err(protocol_error());
        }
        // Fully decode bounded PNG output; a signature alone is not an image.
        let bytes = Arc::new(bytes);
        crate::image_decode::validate(bytes.clone(), token).await?;
        let length = bytes.len() as u64;
        drop(bytes);
        {
            let mut state = job.state.lock().await;
            if state.status == "running" {
                state.metadata["nativeRuntime"] = runtime_observation;
            }
        }
        results::publish(inner, job, &output, length, token).await
    };
    let value = tokio::select! { biased; _=token.cancelled()=>Err(ApiError::new(499,"ABORT_ERR","独立推理已取消")), value=tokio::time::timeout(Duration::from_secs(600),result)=>value.unwrap_or_else(|_| Err(ApiError::new(504,"NATIVE_TIMEOUT","独立推理超时"))) };
    let cancelling = value.as_ref().err().is_some_and(|error| {
        token.is_cancelled() && matches!(error.code.as_str(), "ABORT_ERR" | "CANCELLED")
    });
    let retain = if value.is_ok() || (cancelling && ready) {
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
        Engine::retain_worker(inner.clone(), worker).await;
        return value;
    }
    // Unacknowledged cancellation, faults and timeouts still retire the process
    // while its GPU slot and temporary inputs are held by this request.
    worker.stop().await?;
    value
}
fn stage_text(event: &Value) -> Result<String> {
    let label = match event["stage"].as_str() {
        Some("dependencies") => "准备推理环境",
        Some("fingerprint") => "确认模型与 LoRA",
        Some("preparing_image") => "处理输入图像",
        Some("loading") => "加载模型",
        Some("uploading") => "传输模型到显卡",
        Some("adapters") => "应用 LoRA",
        Some("encoding") => "编码提示词",
        Some("sampling") => "采样",
        Some("decoding") => "解码图像",
        Some("upscaling") => "放大图像",
        Some("saving") => "保存图像",
        _ => return Err(protocol_error()),
    };
    let component = match event.get("component").and_then(Value::as_str) {
        None => "",
        Some("text_encoder") => " · 文本编码器",
        Some("text_conditioner") => " · 文本条件模型",
        Some("transformer") => " · 扩散模型",
        Some("vae") => " · VAE",
        Some("tokenizer" | "t5_tokenizer") => " · 分词器",
        Some("scheduler") => " · 调度器",
        Some(_) => return Err(protocol_error()),
    };
    Ok(format!("独立推理{label}{component}"))
}
fn protocol_error() -> ApiError {
    ApiError::new(502, "NATIVE_PROTOCOL_ERROR", "独立推理协议或结果无效")
}
