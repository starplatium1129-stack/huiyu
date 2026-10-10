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
        let result = self.process.stop().await;
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
            if worker.process.exited()?.is_none() {
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
                eprintln!("native idle release: {}", error.code);
            }
        });
    }
}
