mod protocol;
#[cfg(test)]
mod tests;

use crate::{
    error::{ApiError, Result},
    processes::{OwnedProcess, Processes},
};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex as SyncMutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, ChildStdout, Command},
    sync::{Mutex, OwnedSemaphorePermit, Semaphore, oneshot},
    task::JoinHandle,
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(110);
const STDERR_LIMIT: usize = 64 * 1024;

#[derive(Clone)]
pub(super) struct Settings {
    pub python: PathBuf,
    pub model_dir: PathBuf,
    pub deps_dir: PathBuf,
    pub torch_site_packages: PathBuf,
    pub script: PathBuf,
    pub temp_root: PathBuf,
}

#[derive(Default)]
struct Snapshot {
    cached: bool,
    loading: bool,
    meta: Option<Value>,
    reason: Option<String>,
}

struct Worker {
    process: OwnedProcess,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    stderr: JoinHandle<Vec<u8>>,
}

pub(super) struct Client {
    settings: Arc<Settings>,
    worker: Arc<Mutex<Option<Worker>>>,
    snapshot: Arc<SyncMutex<Snapshot>>,
    processes: Arc<Processes>,
    gate: Arc<Semaphore>,
    closed: SyncMutex<bool>,
    shutdown: CancellationToken,
    jobs: TaskTracker,
    timeout: Duration,
}

impl Client {
    pub fn new(settings: Settings) -> Self {
        Self {
            settings: Arc::new(settings),
            worker: Arc::new(Mutex::new(None)),
            snapshot: Arc::new(SyncMutex::new(Snapshot::default())),
            processes: Arc::new(Processes::default()),
            gate: Arc::new(Semaphore::new(1)),
            closed: SyncMutex::new(false),
            shutdown: CancellationToken::new(),
            jobs: TaskTracker::new(),
            timeout: REQUEST_TIMEOUT,
        }
    }

    pub(super) fn admit(&self) -> Result<OwnedSemaphorePermit> {
        if self.shutdown.is_cancelled() || self.gate.is_closed() {
            return Err(closed());
        }
        self.gate
            .clone()
            .try_acquire_owned()
            .map_err(|_| ApiError::new(429, "INTERROGATE_BUSY", "PixAI 正在处理另一张图片"))
    }

    pub async fn run(
        &self,
        image: Arc<Vec<u8>>,
        threshold: f64,
        cancel: CancellationToken,
    ) -> Result<Value> {
        if !threshold.is_finite() || !(0.0..=1.0).contains(&threshold) {
            return Err(ApiError::new(400, "INVALID_PARAMETER", "反推阈值无效"));
        }
        let admission = Arc::new(self.admit()?);
        let cancel = cancel.child_token();
        // An abandoned HTTP future cancels the tracked work; it does not drop
        // the permit or worker before the cleanup task has confirmed exit.
        let _cancel = cancel.clone().drop_guard();
        let (send, receive) = oneshot::channel();
        let settings = self.settings.clone();
        let worker = self.worker.clone();
        let snapshot = self.snapshot.clone();
        let processes = self.processes.clone();
        let gate = self.gate.clone();
        let shutdown = self.shutdown.clone();
        let timeout = self.timeout;
        {
            // Register jobs and close the tracker under the same lock.
            let guard = self.closed.lock().unwrap();
            if *guard {
                return Err(closed());
            }
            self.jobs.spawn(async move {
                let result = async {
                    check(&cancel, &shutdown)?;
                    tokio::fs::create_dir_all(&settings.temp_root).await?;
                    let input =
                        tempfile::NamedTempFile::new_in(&settings.temp_root)?.into_temp_path();
                    tokio::fs::write(&input, image.as_slice()).await?;
                    let mut worker = worker.lock().await;
                    let result = tokio::select! {
                        biased;
                        _ = shutdown.cancelled() => Err(closed()),
                        _ = cancel.cancelled() => Err(cancelled()),
                        result = tokio::time::timeout(timeout, infer(
                            &settings, &processes, &snapshot, &mut worker, &input, threshold
                        )) => result.unwrap_or_else(|_| Err(ApiError::new(
                            504, "INTERROGATE_TIMEOUT", "PixAI 加载或反推超过时限"
                        ))),
                    };
                    let result = if result.is_err() {
                        let stop = match worker.take() {
                            Some(worker) => worker.stop().await,
                            None => Ok(()),
                        };
                        let mut status = snapshot.lock().unwrap();
                        status.cached = false;
                        status.loading = false;
                        status.reason = result.as_ref().err().map(|e| e.message.clone());
                        if let Err(error) = stop {
                            // Never admit new GPU work after an unconfirmed stop.
                            gate.close();
                            Err(error)
                        } else {
                            result
                        }
                    } else {
                        result
                    };
                    // The private image stays alive until completion or process exit.
                    input.close()?;
                    result
                }
                .await;
                drop(admission);
                let _ = send.send(result);
            });
        }
        receive
            .await
            .map_err(|_| unavailable("PixAI 工作进程通信已中断"))?
    }

    pub async fn probe(&self) -> Value {
        let status = self.snapshot.lock().unwrap();
        let cached = status.cached
            && self.worker.try_lock().map_or(true, |worker| {
                worker
                    .as_ref()
                    .is_some_and(|worker| matches!(worker.process.exited(), Ok(None)))
            });
        let model = protocol::MODEL_FILES
            .iter()
            .all(|name| self.settings.model_dir.join(name).is_file());
        let dependencies = self.settings.deps_dir.join("timm/__init__.py").is_file()
            && self
                .settings
                .torch_site_packages
                .join("torch/__init__.py")
                .is_file();
        let runtime = self.settings.python.is_file() && self.settings.script.is_file();
        let closed = self.shutdown.is_cancelled() || self.gate.is_closed();
        let available = !closed && model && dependencies && runtime;
        let reason = if closed {
            Some("PixAI 服务已关闭")
        } else if !model {
            Some("未找到完整 PixAI 模型，请安装反推模型")
        } else if !dependencies || !runtime {
            Some("PixAI Python 或模型依赖未安装")
        } else {
            status.reason.as_deref()
        };
        json!({
            "engine":"pixai", "model":protocol::MODEL, "available":available,
            "modelPresent":model, "dependencyPresent":dependencies,
            "cached":cached, "loading":status.loading,
            "busy":self.gate.available_permits() == 0 && !closed,
            "gpuResident":cached, "device":"cuda", "meta":status.meta,
            "reason":reason
        })
    }

    pub async fn close(&self) {
        {
            *self.closed.lock().unwrap() = true;
            self.shutdown.cancel();
            self.jobs.close();
        }
        self.jobs.wait().await;
        if let Some(worker) = self.worker.lock().await.take()
            && let Err(error) = worker.stop().await
        {
            eprintln!("pixai: {error}");
        }
        self.processes.close().await;
        let mut status = self.snapshot.lock().unwrap();
        status.cached = false;
        status.loading = false;
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        self.shutdown.cancel();
        self.jobs.close();
    }
}

async fn infer(
    settings: &Settings,
    processes: &Arc<Processes>,
    snapshot: &SyncMutex<Snapshot>,
    worker: &mut Option<Worker>,
    image: &Path,
    threshold: f64,
) -> Result<Value> {
    if worker
        .as_ref()
        .is_some_and(|w| !matches!(w.process.exited(), Ok(None)))
    {
        if let Some(exited) = worker.take() {
            exited.stop().await?;
        }
        snapshot.lock().unwrap().cached = false;
    }
    if worker.is_none() {
        snapshot.lock().unwrap().loading = true;
        *worker = Some(Worker::spawn(settings, processes)?);
        let ready = protocol::ready(protocol::read(&mut worker.as_mut().unwrap().output).await?)?;
        let mut status = snapshot.lock().unwrap();
        status.cached = true;
        status.loading = false;
        status.meta = Some(ready);
        status.reason = None;
    }
    let worker = worker.as_mut().unwrap();
    let id = uuid::Uuid::new_v4().simple().to_string();
    let mut request = serde_json::to_vec(&json!({
        "requestId":id, "imagePath":image, "threshold":threshold
    }))?;
    request.push(b'\n');
    worker
        .input
        .write_all(&request)
        .await
        .map_err(|_| unavailable("PixAI 工作进程输入已断开"))?;
    worker
        .input
        .flush()
        .await
        .map_err(|_| unavailable("PixAI 工作进程输入已断开"))?;
    protocol::response(protocol::read(&mut worker.output).await?, &id)
}

impl Worker {
    fn spawn(settings: &Settings, processes: &Arc<Processes>) -> Result<Self> {
        if !settings.python.is_file() || !settings.script.is_file() {
            return Err(unavailable("PixAI Python 或模型脚本未安装"));
        }
        let mut command = Command::new(&settings.python);
        command
            .arg("-u")
            .arg(&settings.script)
            .arg("--model-dir")
            .arg(&settings.model_dir)
            .arg("--deps-dir")
            .arg(&settings.deps_dir)
            .arg("--torch-site-packages")
            .arg(&settings.torch_site_packages)
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUTF8", "1")
            .env("PYTHONNOUSERSITE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let process = processes.spawn(&mut command)?;
        let input = process
            .take_input()
            .ok_or_else(|| unavailable("PixAI 输入未建立"))?;
        let (output, stderr) = process.take_output();
        let output = output.ok_or_else(|| unavailable("PixAI 输出未建立"))?;
        let mut stderr = stderr.ok_or_else(|| unavailable("PixAI 日志未建立"))?;
        let stderr = tokio::spawn(async move {
            let mut logs = Vec::new();
            let mut buffer = [0; 4096];
            while let Ok(count) = stderr.read(&mut buffer).await {
                if count == 0 {
                    break;
                }
                let keep = count.min(STDERR_LIMIT - logs.len());
                logs.extend_from_slice(&buffer[..keep]);
            }
            logs
        });
        Ok(Self {
            process,
            input,
            output: BufReader::new(output),
            stderr,
        })
    }

    async fn stop(self) -> Result<()> {
        let stopped = self.process.stop().await;
        let mut stderr = self.stderr;
        if stopped.is_err() {
            stderr.abort();
        } else {
            match tokio::time::timeout(Duration::from_secs(1), &mut stderr).await {
                Ok(Ok(logs)) if !logs.is_empty() => {
                    eprintln!("pixai worker: {}", String::from_utf8_lossy(&logs));
                }
                Err(_) => stderr.abort(),
                _ => {}
            }
        }
        stopped
    }
}

fn check(cancel: &CancellationToken, shutdown: &CancellationToken) -> Result<()> {
    if shutdown.is_cancelled() {
        Err(closed())
    } else if cancel.is_cancelled() {
        Err(cancelled())
    } else {
        Ok(())
    }
}
fn closed() -> ApiError {
    ApiError::new(503, "INTERROGATE_CLOSED", "PixAI 反推服务已关闭")
}
fn cancelled() -> ApiError {
    ApiError::new(499, "CANCELLED", "PixAI 反推已取消")
}
fn unavailable(message: &str) -> ApiError {
    ApiError::new(503, "PIXAI_UNAVAILABLE", message)
}
