use super::*;
use crate::processes::OwnedProcess;
use tokio::process::{ChildStdin, ChildStdout};
use tokio::task::JoinHandle;

pub(super) struct Worker {
    pub process: OwnedProcess,
    pub input: ChildStdin,
    pub output: BufReader<ChildStdout>,
    stderr: JoinHandle<()>,
    pub idle: CancellationToken,
}
impl Worker {
    fn spawn(engine: &Engine, settings: &Settings) -> Result<Self> {
        let mut command = tokio::process::Command::new(&settings.python);
        command
            .arg("-I")
            .arg("-u")
            .arg(&settings.worker)
            .arg("--serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .env_remove("PYTHONPATH")
            .env_remove("PYTHONHOME")
            .env("HUIYU_INFERENCE_ACCELERATION", &settings.acceleration)
            .env("HUIYU_INFERENCE_MEMORY", &settings.memory_policy)
            .env("HF_HUB_OFFLINE", "1")
            .env("TRANSFORMERS_OFFLINE", "1");
        let process = engine.processes.spawn(&mut command)?;
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
            stderr,
            idle: CancellationToken::new(),
        })
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
impl Engine {
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
            if exited.is_none() {
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
                owner.admission.close();
                eprintln!("native idle release: {}", error.code);
            }
        });
    }
}

impl Service {
    pub(crate) async fn native_chat_handoff(&self) -> Result<Option<OwnedSemaphorePermit>> {
        if !self.native_enabled() {
            return Ok(None);
        }
        if self.inner.closed.load(Ordering::Relaxed) || self.inner.cancel.is_cancelled() {
            return Err(closed());
        }
        // Admission covers prepared, queued and running jobs. Keep every permit
        // until chat startup completes so a new generation cannot enter the GPU.
        let admission = self
            .inner
            .admission
            .clone()
            .try_acquire_many_owned(self.inner.scope.capacity() as u32)
            .map_err(|_| {
                if self.inner.admission.is_closed() {
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
                self.inner.admission.close();
                return Err(error);
            }
        }
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
