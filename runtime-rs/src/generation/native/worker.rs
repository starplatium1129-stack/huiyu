use super::*;
use crate::processes::OwnedProcess;
use tokio::process::{ChildStdin, ChildStdout};
use tokio::task::JoinHandle;

pub(super) struct Worker {
    pub process: OwnedProcess,
    pub input: ChildStdin,
    pub output: BufReader<ChildStdout>,
    pub(super) current_temp: Arc<std::sync::Mutex<Option<Arc<tempfile::TempDir>>>>,
    event_line: Vec<u8>,
    stderr: JoinHandle<()>,
    pub idle: CancellationToken,
    settings: Settings,
}
impl Worker {
    fn spawn(engine: &Engine, settings: &Settings) -> Result<Self> {
        let mut command = settings.worker_command();
        command
            .arg("--serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // The child owns the same single-job slot before it can receive input.
        // Retirement keeps it through reap, even after this Worker is dropped.
        let current_temp = Arc::new(std::sync::Mutex::new(None));
        let process = engine
            .processes
            .spawn_with_keep_alive(&mut command, current_temp.clone())?;
        let input = process.take_input().ok_or_else(protocol_error)?;
        let (stdout, stderr) = process.take_output();
        let output = BufReader::new(stdout.ok_or_else(protocol_error)?);
        let mut stderr = stderr.ok_or_else(protocol_error)?;
        let stderr = tokio::spawn(async move {
            let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
        });
        Ok(Self {
            process,
            input,
            output,
            current_temp,
            event_line: Vec::new(),
            stderr,
            idle: CancellationToken::new(),
            settings: settings.clone(),
        })
    }
    pub async fn event(&mut self, id: &str) -> Result<Value> {
        // read_until is cancellation-safe only while its destination survives.
        // Keep a partial JSONL event when cancellation takes over the read loop.
        let remaining = 65537 - self.event_line.len();
        let count = (&mut self.output)
            .take(remaining as u64)
            .read_until(b'\n', &mut self.event_line)
            .await?;
        if count == 0 || self.event_line.len() > 65536 || self.event_line.last() != Some(&b'\n') {
            return Err(protocol_error());
        }
        let event: Value =
            serde_json::from_slice(&self.event_line).map_err(|_| protocol_error())?;
        self.event_line.clear();
        if event["id"] != id {
            return Err(protocol_error());
        }
        Ok(event)
    }
    pub async fn cancel_and_wait(
        &mut self,
        id: &str,
        mut produced: bool,
        output: &std::path::Path,
    ) -> Result<()> {
        let settle = async {
            self.input
                .write_all(format!("{}\n", json!({"id": id, "op": "cancel"})).as_bytes())
                .await?;
            self.input.flush().await?;
            let mut cancelled = false;
            loop {
                let event = self.event(id).await?;
                match event["event"].as_str() {
                    Some("stage") if !produced && !cancelled => {
                        stage_text(&event)?;
                    }
                    Some("progress") if !produced && !cancelled => {
                        let step = event["step"].as_u64().ok_or_else(protocol_error)?;
                        event["total"]
                            .as_u64()
                            .filter(|total| *total > 0 && step <= *total)
                            .ok_or_else(protocol_error)?;
                    }
                    Some("result") if !produced && !cancelled => {
                        if event["outputPath"].as_str() != output.to_str() {
                            return Err(protocol_error());
                        }
                        produced = true;
                    }
                    Some("cancelled") if !produced && !cancelled => cancelled = true,
                    // Generation can finish before the reader receives cancel.
                    // Either terminal event must be followed by cleanup's ready.
                    Some("ready") if produced || cancelled => return Ok(()),
                    _ => return Err(protocol_error()),
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(10), settle)
            .await
            .map_err(|_| ApiError::new(504, "NATIVE_CANCEL_TIMEOUT", "独立推理取消等待超时"))?
    }
    pub async fn stop(&mut self) -> Result<()> {
        self.idle.cancel();
        let result = self.process.stop().await.map_err(|error| {
            ApiError::new(
                503,
                "TERMINATION_UNCONFIRMED",
                format!(
                    "独立绘图进程退出未确认（{}），请完全退出并重启应用",
                    error.code
                ),
            )
        });
        self.stderr.abort();
        result
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.idle.cancel();
        self.stderr.abort();
    }
}
pub(crate) struct ComfyLease {
    engine: Arc<Engine>,
    _slot: OwnedSemaphorePermit,
    _admission: OwnedSemaphorePermit,
}
impl Drop for ComfyLease {
    fn drop(&mut self) { self.engine.comfy_leased.store(false,Ordering::SeqCst); }
}
impl Engine {
    pub(crate) async fn comfy_handoff(self: &Arc<Self>) -> Result<ComfyLease> {
        let engine = self.clone();
        // Retirement owns the slot even if preparation's HTTP future disappears.
        tokio::spawn(async move {
            let admission = engine.admission.clone().try_acquire_many_owned(4).map_err(|_| {
                if engine.admission.is_closed() { release_error() }
                else { ApiError::new(409,"DRAWING_BUSY","独立推理仍有准备、排队或显存交接，请待任务结束后重试") }
            })?;
            let slot = engine.slot.clone().try_acquire_owned().map_err(|_| {
                if engine.slot.is_closed() { release_error() }
                else { ApiError::new(409,"DRAWING_BUSY","另一引擎仍在使用或释放显存，请待任务结束后重试") }
            })?;
            if let Some(mut worker) = engine.worker.lock().await.take() {
                if let Err(error) = worker.stop().await {
                    engine.slot.close(); engine.admission.close(); slot.forget();
                    return Err(error);
                }
            }
            engine.gpu_owned.store(false,Ordering::SeqCst);
            engine.comfy_leased.store(true,Ordering::SeqCst);
            Ok(ComfyLease { engine, _slot:slot, _admission:admission })
        }).await.map_err(|_| release_error())?
    }
    pub(super) async fn take_worker(&self, settings: &Settings) -> Result<Worker> {
        if let Some(mut worker) = self.worker.lock().await.take() {
            worker.idle.cancel();
            let exited = match worker.process.exited() {
                Ok(exited) => exited,
                Err(error) => {
                    worker.stop().await?;
                    return Err(error);
                }
            };
            if exited.is_none() && worker.settings == *settings {
                return Ok(worker);
            }
            worker.stop().await?;
        }
        Worker::spawn(self, settings)
    }
    pub(super) async fn retain_worker(inner: Arc<Inner>, mut worker: Worker) {
        worker.idle = CancellationToken::new();
        let idle = worker.idle.clone();
        *inner.native.worker.lock().await = Some(worker);
        let owner = inner.clone();
        inner.tasks.spawn(async move {
            tokio::select! {
                _ = idle.cancelled() => return,
                _ = owner.cancel.cancelled() => return,
                _ = tokio::time::sleep(owner.native.idle_timeout) => {}
            }
            // Submission can fail before take_worker cancels the old timer.
            // Wait for its GPU slot instead of abandoning idle cleanup, but
            // stop waiting if that worker is reused or the service shuts down.
            let slot = tokio::select! {
                biased;
                _ = idle.cancelled() => return,
                _ = owner.cancel.cancelled() => return,
                slot = owner.native.slot.acquire() => match slot {
                    Ok(slot) => slot,
                    Err(_) => return,
                }
            };
            let mut resident = owner.native.worker.lock().await;
            if idle.is_cancelled() {
                return;
            }
            if let Some(mut worker) = resident.take()
                && let Err(error) = worker.stop().await
            {
                slot.forget();
                owner.native.slot.close();
                owner.native.admission.close();
                owner.admission.close();
                eprintln!("native idle release: {}", error.code);
            } else {
                owner.native.gpu_owned.store(false,Ordering::SeqCst);
            }
        });
    }
}

impl Service {
    pub(crate) async fn native_chat_handoff(&self) -> Result<Option<OwnedSemaphorePermit>> {
        // Images and videos can select different providers but share this worker.
        if !self.native_enabled() && self.inner.native_settings.video_engine() != "native" {
            return Ok(None);
        }
        if self.inner.closed.load(Ordering::Relaxed) || self.inner.cancel.is_cancelled() {
            return Err(closed());
        }
        // Admission covers prepared, queued and running jobs. Keep every permit
        // until chat startup completes so a new generation cannot enter the GPU.
        let admission = self
            .inner
            .native.admission
            .clone()
            .try_acquire_many_owned(4)
            .map_err(|_| {
                if self.inner.native.admission.is_closed() {
                    release_error()
                } else {
                    ApiError::new(
                        409,
                        "DRAWING_BUSY",
                        "绘图任务尚未结束，请稍后开启本地聊天或改用 API",
                    )
                }
            })?;
        // Publication can release admission just before settlement drops the GPU
        // slot. Idle retirement also owns the slot through process termination.
        let slot = self.inner.native.slot.try_acquire().map_err(|_| {
            if self.inner.native.slot.is_closed() {
                release_error()
            } else {
                ApiError::new(
                    409,
                    "DRAWING_BUSY",
                    "独立绘图仍在结束或释放显存，请稍后重试",
                )
            }
        })?;
        let resident = self.inner.native.worker.lock().await.take();
        if let Some(mut worker) = resident {
            if let Err(error) = worker.stop().await {
                // A child that was not reaped must never share the GPU with a
                // new worker or local chat; restarting the runtime is required.
                slot.forget();
                self.inner.native.slot.close();
                self.inner.native.admission.close();
                self.inner.admission.close();
                return Err(error);
            }
        }
        self.inner.native.gpu_owned.store(false,Ordering::SeqCst);
        Ok(Some(admission))
    }
}

pub(super) fn release_error() -> ApiError {
    ApiError::new(
        503,
        "NATIVE_RELEASE_UNCONFIRMED",
        "独立绘图显存释放未确认，请完全退出并重启应用",
    )
}
