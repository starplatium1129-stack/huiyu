use super::{
    config::Settings,
    payload::Validated,
    queue::{Permit, cancelled, speech_timeout},
};
use crate::{
    control::ControlService,
    error::{ApiError, Result},
    processes::{OwnedProcess, Processes},
};
use axum::body::Bytes;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    process::Stdio,
    sync::{
        Arc, Mutex as SyncMutex, RwLock, Weak,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{ChildStdin, ChildStdout, Command},
    sync::OwnedSemaphorePermit,
    time::Instant as Deadline,
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

const AUDIO_LIMIT: usize = 128 * 1024 * 1024;

struct InFlight {
    _voice: Arc<OwnedSemaphorePermit>,
    _drawing: Option<OwnedSemaphorePermit>,
    _comfy: tokio::sync::OwnedMutexGuard<()>,
}

// The process pool retains this while termination is unconfirmed, including
// after the HTTP caller disappears. Neither GPU admission nor the private
// configuration directory may be released before the worker has exited.
struct Lifetime {
    operation: SyncMutex<Option<InFlight>>,
    _directory: tempfile::TempDir,
}

struct Worker {
    process: OwnedProcess,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    lifetime: Arc<Lifetime>,
    ready: Arc<AtomicBool>,
    idle: CancellationToken,
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.idle.cancel();
        self.ready.store(false, Ordering::Release);
    }
}

pub(super) struct Native {
    python: PathBuf,
    source: PathBuf,
    config: PathBuf,
    script: PathBuf,
    temp_root: PathBuf,
    log: PathBuf,
    worker: tokio::sync::Mutex<Option<Worker>>,
    control: RwLock<Weak<ControlService>>,
    processes: Arc<Processes>,
    tasks: TaskTracker,
    cancel: CancellationToken,
    ready: Arc<AtomicBool>,
    failed_release: AtomicBool,
}
impl Native {
    pub fn new(settings: &Settings, cancel: CancellationToken) -> Arc<Self> {
        Arc::new(Self {
            python: settings.native_python.clone(),
            source: settings.native_source.clone(),
            config: settings.native_config.clone(),
            script: settings.native_script.clone(),
            temp_root: settings.native_temp.clone(),
            log: settings.native_log.clone(),
            worker: tokio::sync::Mutex::new(None),
            control: RwLock::new(Weak::new()),
            processes: Arc::default(),
            tasks: TaskTracker::new(),
            cancel,
            ready: Arc::new(AtomicBool::new(false)),
            failed_release: AtomicBool::new(false),
        })
    }

    pub fn bind_control(&self, control: &Arc<ControlService>) {
        *self.control.write().unwrap() = Arc::downgrade(control);
    }

    pub fn files_present(&self) -> bool {
        !self.failed_release.load(Ordering::Acquire)
            && self.python.is_file()
            && self.script.is_file()
            && self.config.is_file()
            && self
                .source
                .join("GPT_SoVITS/TTS_infer_pack/TTS.py")
                .is_file()
    }

    pub fn ready(&self) -> bool {
        if let Ok(mut slot) = self.worker.try_lock() {
            if let Some(worker) = slot.as_ref() {
                match worker.process.exited() {
                    Ok(None) => {}
                    Ok(Some(_)) => {
                        slot.take();
                    }
                    Err(_) => {
                        self.ready.store(false, Ordering::Release);
                        self.failed_release.store(true, Ordering::Release);
                    }
                }
            }
        }
        self.ready.load(Ordering::Acquire)
    }

    fn spawn(&self) -> Result<Worker> {
        if !self.files_present() {
            return Err(ApiError::new(
                503,
                "TTS_UNAVAILABLE",
                "缺少 GPT-SoVITS 运行环境或语音配置",
            ));
        }
        std::fs::create_dir_all(&self.temp_root)?;
        let directory = tempfile::Builder::new()
            .prefix("native-")
            .tempdir_in(&self.temp_root)?;
        let mut command = Command::new(&self.python);
        command
            .arg("-u")
            .arg(&self.script)
            .arg("--source")
            .arg(&self.source)
            .arg("--config")
            .arg(&self.config)
            .arg("--runtime")
            .arg(directory.path())
            .current_dir(&self.source)
            .env("PYTHONUTF8", "1")
            .env("PYTHONDONTWRITEBYTECODE", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        if let Some(root) = self.python.parent() {
            let mut paths = vec![
                root.to_path_buf(),
                root.join("Scripts"),
                root.join("Library/bin"),
                self.source.clone(),
            ];
            paths.extend(std::env::split_paths(
                &std::env::var_os("PATH").unwrap_or_default(),
            ));
            command.env(
                "PATH",
                std::env::join_paths(paths).map_err(|_| unavailable())?,
            );
        }
        if let Some(parent) = self.log.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.log)?;
        command.stderr(log);
        let lifetime = Arc::new(Lifetime {
            operation: SyncMutex::new(None),
            _directory: directory,
        });
        let process = self
            .processes
            .spawn_with_keep_alive(&mut command, lifetime.clone())?;
        let input = process.take_input().ok_or_else(unavailable)?;
        let (output, _) = process.take_output();
        Ok(Worker {
            process,
            input,
            output: BufReader::new(output.ok_or_else(unavailable)?),
            lifetime,
            ready: self.ready.clone(),
            idle: CancellationToken::new(),
        })
    }

    pub async fn execute(
        self: &Arc<Self>,
        value: &Validated,
        permit: &Permit,
        deadline: Deadline,
        synthesize: bool,
    ) -> Result<Bytes> {
        if self.cancel.is_cancelled() {
            return Err(cancelled());
        }
        if self.failed_release.load(Ordering::Acquire) {
            return Err(release_error());
        }
        let control = self
            .control
            .read()
            .unwrap()
            .upgrade()
            .ok_or_else(unavailable)?;
        let (drawing, comfy) = control.native_voice_handoff().await?;
        let mut slot = self.worker.lock().await;
        if self.cancel.is_cancelled() {
            return Err(cancelled());
        }
        // Idle retirement may have failed while this request waited for the
        // worker lock. Do not start a second model in that case.
        if self.failed_release.load(Ordering::Acquire) {
            return Err(release_error());
        }
        let mut worker = match slot.take() {
            Some(worker) => match worker.process.exited() {
                Ok(None) => worker,
                Ok(Some(_)) => {
                    if worker.process.stop().await.is_err() {
                        self.failed_release.store(true, Ordering::Release);
                        return Err(release_error());
                    }
                    self.spawn()?
                }
                Err(_) => {
                    self.failed_release.store(true, Ordering::Release);
                    return Err(release_error());
                }
            },
            None => self.spawn()?,
        };
        worker.idle.cancel();
        *worker.lifetime.operation.lock().unwrap() = Some(InFlight {
            _voice: permit.serial.clone(),
            _drawing: drawing,
            _comfy: comfy,
        });
        let id = uuid::Uuid::new_v4().to_string();
        let input = json!({"id": id, "op": if synthesize { "synthesize" } else { "prepare" },
            "gpt":value.profile.gpt_weights_path,"sovits":value.profile.sovits_weights_path,"payload":value.payload});
        let work = async {
            let mut bytes = serde_json::to_vec(&input)?;
            bytes.push(b'\n');
            worker.input.write_all(&bytes).await?;
            worker.input.flush().await?;
            let mut header = Vec::new();
            let size = (&mut worker.output)
                .take(16385)
                .read_until(b'\n', &mut header)
                .await?;
            if size == 0 || size > 16384 || header.last() != Some(&b'\n') {
                return Err(protocol_error());
            }
            let reply: Value = serde_json::from_slice(&header).map_err(|_| protocol_error())?;
            if reply["id"] != id {
                return Err(protocol_error());
            }
            if reply["event"] == "error" {
                return Err(ApiError::new(
                    502,
                    "TTS_FAILED",
                    reply["message"]
                        .as_str()
                        .unwrap_or("语音模型加载或生成失败"),
                ));
            }
            let length = reply["bytes"]
                .as_u64()
                .filter(|n| *n <= AUDIO_LIMIT as u64)
                .ok_or_else(protocol_error)? as usize;
            if reply["event"] != "result"
                || (synthesize && length < 64)
                || (!synthesize && length != 0)
            {
                return Err(protocol_error());
            }
            let mut audio = vec![0; length];
            worker.output.read_exact(&mut audio).await?;
            Ok(Bytes::from(audio))
        };
        let result = tokio::select! {
            biased;
            _ = self.cancel.cancelled() => Err(cancelled()),
            result = tokio::time::timeout_at(deadline, work) => result.map_err(|_| speech_timeout())?,
        };
        match result {
            Ok(audio) => {
                worker.lifetime.operation.lock().unwrap().take();
                worker.ready.store(true, Ordering::Release);
                worker.idle = CancellationToken::new();
                let idle = worker.idle.clone();
                *slot = Some(worker);
                drop(slot);
                let owner = self.clone();
                self.tasks.spawn(async move {
                    tokio::select! {
                        _ = idle.cancelled() => return,
                        _ = owner.cancel.cancelled() => return,
                        _ = tokio::time::sleep(Duration::from_secs(600)) => {}
                    }
                    let mut slot = owner.worker.lock().await;
                    if !idle.is_cancelled() {
                        if let Some(worker) = slot.take()
                            && worker.process.stop().await.is_err()
                        {
                            owner.failed_release.store(true, Ordering::Release);
                        }
                    }
                });
                Ok(audio)
            }
            Err(error) => {
                if worker.process.stop().await.is_err() {
                    self.failed_release.store(true, Ordering::Release);
                    return Err(release_error());
                }
                Err(error)
            }
        }
    }

    pub async fn retire(self: &Arc<Self>, idle: Arc<OwnedSemaphorePermit>) -> Result<()> {
        let owner = self.clone();
        // Keep voice admission until the process has exited, even if its caller
        // is cancelled while waiting for release.
        self.tasks
            .spawn(async move {
                let _idle = idle;
                owner.retire_worker().await
            })
            .await
            .map_err(|_| release_error())?
    }

    async fn retire_worker(&self) -> Result<()> {
        if self.failed_release.load(Ordering::Acquire) {
            return Err(release_error());
        }
        let mut slot = self
            .worker
            .try_lock()
            .map_err(|_| ApiError::new(409, "VOICE_BUSY", "语音正在生成，请稍后再绘图"))?;
        if self.failed_release.load(Ordering::Acquire) {
            return Err(release_error());
        }
        if let Some(worker) = slot.take()
            && worker.process.stop().await.is_err()
        {
            self.failed_release.store(true, Ordering::Release);
            return Err(release_error());
        }
        Ok(())
    }

    pub async fn close(&self) {
        self.cancel.cancel();
        self.processes.close().await;
        self.worker.lock().await.take();
        self.tasks.close();
        self.tasks.wait().await;
    }
}

fn unavailable() -> ApiError {
    ApiError::new(503, "TTS_UNAVAILABLE", "本地语音运行环境不可用")
}
fn protocol_error() -> ApiError {
    ApiError::new(502, "TTS_FAILED", "本地语音运行进程返回了无效数据")
}
fn release_error() -> ApiError {
    ApiError::new(
        503,
        "TERMINATION_UNCONFIRMED",
        "语音显存释放未确认，请完全退出并重启应用",
    )
}
