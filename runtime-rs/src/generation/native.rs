mod config;
mod worker;
use super::*;
pub(crate) use config::{Settings, load};
use std::{path::PathBuf, process::Stdio};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

pub(crate) struct Plan {
    pub input: Value,
    pub settings: Settings,
    pub model_dir: PathBuf,
    pub mask_model_dir: Option<PathBuf>,
    pub tea_cache_profile_path: Option<PathBuf>,
    pub init_image: Option<Arc<Vec<u8>>>,
    pub mask_image: Option<Arc<Vec<u8>>>,
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
            idle_timeout: Duration::from_secs(120),
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
    pub(crate) async fn prepare_native(
        &self,
        plan: Plan,
        cancel: CancellationToken,
    ) -> Result<Prepared> {
        if self.inner.cancel.is_cancelled() || cancel.is_cancelled() {
            return Err(closed());
        }
        let permit = self
            .inner
            .admission
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError::new(429, "ANIMA_QUEUE_FULL", "图像生成队列已满"))?;
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
    let worker = inner.clone();
    inner.tasks.spawn(async move {
        let slot = tokio::select! {
            biased;
            _ = token.cancelled() => Err(closed()),
            slot = worker.native.slot.acquire() => slot.map_err(|_| closed()),
        };
        match slot {
            Ok(slot) => {
                let outcome = run(&worker, &job, &token).await;
                // Hold the GPU slot through publication/cancel settlement. A
                // cancelling completed job must not retire the next job's model.
                if settle(&worker, &job, outcome, token.is_cancelled()).await {
                    slot.forget();
                }
            }
            Err(error) => {
                settle(&worker, &job, Err(error), true).await;
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
    let error = match outcome {
        Ok(output) => {
            jobs::succeed(inner, job, output).await;
            // Cancellation can win between worker completion and publication.
            // succeed intentionally refuses publication in cancelling state.
            if job.state.lock().await.status == "cancelling" {
                let resident = inner.native.worker.lock().await.take();
                if let Some(mut resident) = resident {
                    if let Err(error) = resident.stop().await {
                        error
                    } else {
                        cancelled(job).await;
                        return false;
                    }
                } else {
                    cancelled(job).await;
                    return false;
                }
            } else {
                return false;
            }
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
    if let Some(hooks) = &job.hooks {
        tokio::select! { biased; _=token.cancelled()=>return Err(closed()), result=hooks.submitting("native".into(), String::new())=>result? }
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
    ] {
        input[key] = plan.input[key].clone();
    }
    if let Some(threshold) = plan.input.get("teaCacheThresh") {
        input["teaCacheThresh"] = threshold.clone();
    }
    // Pass only accepted original bytes, never a mutable upload path. Each job
    // owns this temporary copy until its child process has been reaped.
    let input_image_path = if let Some(bytes) = &plan.init_image {
        input["denoisingStrength"] = plan.input["denoisingStrength"].clone();
        let path = temp.path().join("input-image");
        tokio::fs::write(&path, bytes.as_slice()).await?;
        Some(path)
    } else {
        None
    };
    if plan.mask_model_dir.is_some() {
        for key in ["maskPrompt", "maskThreshold", "growMaskBy"] {
            input[key] = plan.input[key].clone();
        }
    }
    let mask_image_path = if let Some(bytes) = &plan.mask_image {
        input["growMaskBy"] = plan.input["growMaskBy"].clone();
        let path = temp.path().join("mask-image");
        tokio::fs::write(&path, bytes.as_slice()).await?;
        Some(path)
    } else {
        None
    };
    let request = json!({"id":job.id,"op":"generate","modelDir":plan.model_dir,"maskModelDir":plan.mask_model_dir,"teaCacheProfilePath":plan.tea_cache_profile_path,"outputPath":output,"input":input,"inputImagePath":input_image_path,"maskImagePath":mask_image_path,"loras":plan.loras});
    let mut worker = inner.native.take_worker(&plan.settings).await?;
    let result = async {
        worker
            .input
            .write_all(format!("{}\n", request).as_bytes())
            .await?;
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
            let mut line = Vec::new();
            let mut produced = false;
            loop {
                line.clear();
                let count = (&mut worker.output)
                    .take(65537)
                    .read_until(b'\n', &mut line)
                    .await?;
                if count == 0 || count > 65536 {
                    return Err(protocol_error());
                }
                let event: Value = serde_json::from_slice(&line).map_err(|_| protocol_error())?;
                if event["id"] != job.id {
                    return Err(protocol_error());
                }
                match event["event"].as_str() {
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
                        runtime_observation = native_runtime(&event["nativeRuntime"]);
                        produced = true;
                    }
                    Some("ready") if produced => return Ok(()),
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
        {
            let mut state = job.state.lock().await;
            if state.status == "running" {
                state.metadata["nativeRuntime"] = runtime_observation;
            }
        }
        Ok(Output::Bytes {
            bytes,
            mime: "image/png".into(),
        })
    };
    // Cancel/error/timeout retires the resident process before another GPU job.
    let value = tokio::select! { biased; _=token.cancelled()=>Err(ApiError::new(499,"ABORT_ERR","独立推理已取消")), value=tokio::time::timeout(Duration::from_secs(600),result)=>value.unwrap_or_else(|_| Err(ApiError::new(504,"NATIVE_TIMEOUT","独立推理超时"))) };
    if value.is_ok() && !token.is_cancelled() {
        Engine::retain_worker(inner.clone(), worker).await;
        return value;
    }
    worker.stop().await?;
    value
}
fn protocol_error() -> ApiError {
    ApiError::new(502, "NATIVE_PROTOCOL_ERROR", "独立推理协议或结果无效")
}

// Optional evidence must neither break legacy workers nor forward arbitrary worker data.
// Missing/malformed evidence stays visibly unverified; image/protocol checks are unchanged.
fn native_runtime(value: &Value) -> Value {
    fn finite(value: &Value) -> Option<f64> {
        value.as_f64().filter(|n| n.is_finite() && *n >= 0.)
    }
    let parsed = (|| -> Option<Value> {
        if value["schemaVersion"] != 1
            || value["timingMode"] != "cpu-wall-no-extra-sync"
            || value["timingsAreAdditive"] != false
        {
            return None;
        }
        let mut result = json!({"schemaVersion":1,"timingMode":"cpu-wall-no-extra-sync",
            "timingsAreAdditive":false,"baseReused":value["baseReused"].as_bool()?,
            "existingReportSynchronization":value["existingReportSynchronization"].as_bool()?,
            "completedSteps":value["completedSteps"].as_u64()?,"timings":{}});
        for key in [
            "workerWallSeconds",
            "imagePreparationWallSeconds",
            "modelAcquireWallSeconds",
            "pipelineWallSeconds",
            "compositeWallSeconds",
            "outputSaveSeconds",
            "residentFingerprintSeconds",
        ] {
            result["timings"][key] = json!(finite(&value["timings"][key])?);
        }
        let groups: [(&str, &[&str], &[&str]); 3] = [
            ("textCache", &[], &["hits", "misses", "entries", "cpuBytes"]),
            (
                "maskCache",
                &["used", "modelReused", "resultReused"],
                &["resultBytes"],
            ),
            (
                "teaCache",
                &[],
                &[
                    "fullComputes",
                    "skippedComputes",
                    "skippedBlocks",
                    "resets",
                    "nonfinite",
                ],
            ),
        ];
        for (group, flags, counters) in groups {
            let source = value[group].as_object()?;
            result[group] = json!({"enabled":source.get("enabled")?.as_bool()?});
            for &key in flags {
                if let Some(v) = source.get(key) {
                    result[group][key] = json!(v.as_bool()?);
                }
            }
            for &key in counters {
                if let Some(v) = source.get(key) {
                    result[group][key] = json!(v.as_u64()?);
                }
            }
        }
        if let Some(v) = value["maskCache"].get("fingerprintSeconds") {
            result["maskCache"]["fingerprintSeconds"] = json!(finite(v)?);
        }
        let memory = &value["memory"];
        if memory["deviceIndex"] != 0 || memory["scope"] != "image-preparation-through-pipeline" {
            return None;
        }
        let mut captured = json!({"deviceIndex":0,"scope":"image-preparation-through-pipeline"});
        match memory["status"].as_str()? {
            "per-job-allocator" => {
                captured["status"] = json!("per-job-allocator");
                captured["reason"] = Value::Null;
                for key in ["peakAllocatedBytes", "peakReservedBytes"] {
                    captured[key] = json!(memory[key].as_u64()?);
                }
            }
            "unverified" => {
                let reason = memory["reason"].as_str()?;
                if !matches!(
                    reason,
                    "cuda-uninitialized-at-window-start"
                        | "unsupported-allocator"
                        | "allocator-observation-error"
                ) || !memory["peakAllocatedBytes"].is_null()
                    || !memory["peakReservedBytes"].is_null()
                {
                    return None;
                }
                captured["status"] = json!("unverified");
                captured["reason"] = json!(reason);
                captured["peakAllocatedBytes"] = Value::Null;
                captured["peakReservedBytes"] = Value::Null;
            }
            _ => return None,
        }
        result["memory"] = captured;
        Some(result)
    })();
    parsed.unwrap_or_else(|| json!({"status":"unverified","reason":if value.is_null(){"worker-metrics-missing"}else{"invalid-worker-metrics"}}))
}

#[cfg(test)]
mod tests;
