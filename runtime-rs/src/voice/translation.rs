use super::{
    config::Settings,
    queue::{Queue, cancelled},
};
use crate::{
    error::{ApiError, Result},
    processes::{OwnedProcess, Processes},
    upstream::LocalUpstream,
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    process::Stdio,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::watch,
};
use tokio_util::sync::CancellationToken;

type Startup = watch::Receiver<Option<std::result::Result<(), String>>>;
fn translation_process_error(error: ApiError) -> ApiError {
    if error.code == "ABORT_ERR" {
        cancelled()
    } else {
        ApiError::new(503, "TRANSLATION_UNAVAILABLE", "本地日语翻译组件启动失败")
    }
}
pub(super) struct Translation {
    settings: Arc<Settings>,
    transport: LocalUpstream,
    cancel: CancellationToken,
    queue: Queue,
    cache: Mutex<VecDeque<(String, Value)>>,
    ready: AtomicBool,
    starting: Mutex<Option<Startup>>,
    managed: Mutex<Option<OwnedProcess>>,
    processes: Arc<Processes>,
}
impl Translation {
    pub fn new(
        settings: Arc<Settings>,
        transport: LocalUpstream,
        cancel: CancellationToken,
    ) -> Arc<Self> {
        Arc::new(Self {
            settings,
            transport,
            cancel,
            queue: Queue::new("zh-ja-translation"),
            cache: Mutex::new(VecDeque::new()),
            ready: AtomicBool::new(false),
            starting: Mutex::new(None),
            managed: Mutex::new(None),
            processes: Arc::new(Processes::default()),
        })
    }
    async fn ping(&self) -> bool {
        self.transport
            .json(
                &self.settings.translation_url,
                "/health",
                None,
                Duration::from_millis(800),
                64 * 1024,
                &self.cancel,
            )
            .await
            .is_ok_and(|(status, _)| status == 200)
    }
    pub async fn status(&self) -> Value {
        let ready = self.ping().await;
        self.ready.store(ready, Ordering::Relaxed);
        let managed = self
            .managed
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|child| child.exited().ok().flatten().is_none());
        json!({"ready": ready, "managed": managed, "queue": self.queue.status(), "cached": self.cache.lock().unwrap().len()})
    }
    pub fn owned(&self) -> bool {
        self.managed.lock().unwrap().is_some()
    }
    pub async fn prepare(self: &Arc<Self>) -> Result<()> {
        if self.cancel.is_cancelled() {
            return Err(cancelled());
        }
        if self.ready.load(Ordering::Relaxed) {
            return Ok(());
        }
        let mut receiver = {
            let mut starting = self.starting.lock().unwrap();
            if let Some(receiver) = &*starting {
                receiver.clone()
            } else {
                let (send, receiver) = watch::channel(None);
                *starting = Some(receiver.clone());
                let service = self.clone();
                tokio::spawn(async move {
                    let result = service.ensure_server().await;
                    service.ready.store(result.is_ok(), Ordering::Relaxed);
                    let _ = send.send(Some(result.map_err(|error| error.message)));
                    service.starting.lock().unwrap().take();
                });
                receiver
            }
        };
        loop {
            let result = receiver.borrow().clone();
            if let Some(result) = result {
                return result
                    .map_err(|message| ApiError::new(503, "TRANSLATION_UNAVAILABLE", message));
            }
            tokio::select! { result = receiver.changed() => result.map_err(|_| cancelled())?, _ = self.cancel.cancelled() => return Err(cancelled()) }
        }
    }
    async fn ensure_server(&self) -> Result<()> {
        if self.ping().await {
            return Ok(());
        }
        if self.cancel.is_cancelled() {
            return Err(cancelled());
        }
        if !self.settings.python.is_file() || !self.settings.script.is_file() {
            return Err(ApiError::new(
                503,
                "TRANSLATION_UNAVAILABLE",
                "本地日语翻译组件尚未安装",
            ));
        }
        self.managed.lock().unwrap().take();
        let mut command = Command::new(&self.settings.python);
        command
            .arg(&self.settings.script)
            .args([
                "--serve",
                "--port",
                &self.settings.translation_port.to_string(),
            ])
            .env("PYTHONUTF8", "1")
            .env(
                "AICS_TRANSLATE_PORT",
                self.settings.translation_port.to_string(),
            )
            .stdin(Stdio::null());
        let log = self.settings.log.parent().and_then(|parent| {
            std::fs::create_dir_all(parent).ok()?;
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.settings.log)
                .ok()
        });
        if let Some(log) = log {
            command.stderr(log.try_clone()?).stdout(log);
        } else {
            command.stdout(Stdio::null()).stderr(Stdio::null());
        }
        *self.managed.lock().unwrap() = Some(
            self.processes
                .spawn(&mut command)
                .map_err(translation_process_error)?,
        );
        let wait = async {
            loop {
                if self
                    .managed
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_none_or(|child| child.exited().ok().flatten().is_some())
                {
                    return Err(ApiError::new(
                        503,
                        "TRANSLATION_UNAVAILABLE",
                        "翻译常驻服务启动后退出",
                    ));
                }
                if self.ping().await {
                    return Ok(());
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        };
        let result = tokio::select! { result = tokio::time::timeout(Duration::from_secs(120), wait) => result.unwrap_or_else(|_| Err(ApiError::new(503, "TRANSLATION_TIMEOUT", "翻译常驻服务启动超时"))), _ = self.cancel.cancelled() => Err(cancelled()) };
        if result.is_err() {
            self.managed.lock().unwrap().take();
        }
        result
    }
    pub async fn translate(self: &Arc<Self>, text: String) -> Result<Value> {
        if let Some(value) = self.cached(&text) {
            return Ok(value);
        }
        let _permit = self
            .queue
            .enter(self.queue.reserve()?, &self.cancel)
            .await?;
        // A queued duplicate can use work completed while it waited.
        if let Some(value) = self.cached(&text) {
            return Ok(value);
        }
        let current = async {
            self.prepare().await?;
            let (status, value) = self
                .transport
                .json(
                    &self.settings.translation_url,
                    "/translate",
                    Some(&json!({"text": text})),
                    Duration::from_secs(120),
                    64 * 1024,
                    &self.cancel,
                )
                .await?;
            let value = value.ok().filter(|value| {
                value["translation"]
                    .as_str()
                    .is_some_and(|text| !text.is_empty())
            });
            if !(200..300).contains(&status) || value.is_none() {
                return Err(ApiError::new(
                    503,
                    "TRANSLATION_FAILED",
                    "翻译服务没有返回译文",
                ));
            }
            Ok(value.unwrap())
        }
        .await;
        let result = match current {
            Ok(value) => value,
            Err(error) => {
                self.ready.store(false, Ordering::Relaxed);
                if self.cancel.is_cancelled() {
                    return Err(cancelled());
                }
                self.legacy(&text).await.map_err(|_| error)?
            }
        };
        let mut cache = self.cache.lock().unwrap();
        cache.push_back((text, result.clone()));
        if cache.len() > 100 {
            cache.pop_front();
        }
        Ok(result)
    }
    fn cached(&self, text: &str) -> Option<Value> {
        self.cache
            .lock()
            .unwrap()
            .iter()
            .find(|(key, _)| key == text)
            .map(|(_, value)| value.clone())
    }
    async fn legacy(&self, text: &str) -> Result<Value> {
        let mut command = Command::new(&self.settings.python);
        command
            .arg(&self.settings.script)
            .env("PYTHONUTF8", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let child = self
            .processes
            .spawn(&mut command)
            .map_err(translation_process_error)?;
        let (stdout, stderr) = child.take_output();
        let mut input = child
            .take_input()
            .ok_or_else(|| ApiError::new(503, "TRANSLATION_FAILED", "翻译进程输入不可用"))?;
        let work = async {
            // Writing stdin can block before the child starts reading. Keep it
            // under the same cancellation and deadline as output and exit waits.
            input
                .write_all(&serde_json::to_vec(&json!({"text": text}))?)
                .await?;
            drop(input);
            let stdout = async {
                let mut bytes = Vec::new();
                if let Some(stdout) = stdout {
                    stdout.take(65537).read_to_end(&mut bytes).await?;
                }
                Ok::<_, std::io::Error>(bytes)
            };
            let stderr = async {
                let mut bytes = Vec::new();
                if let Some(stderr) = stderr {
                    stderr.take(65537).read_to_end(&mut bytes).await?;
                }
                Ok::<_, std::io::Error>(bytes)
            };
            let wait = async {
                loop {
                    if let Some(success) = child.exited()? {
                        return Ok::<_, ApiError>(success);
                    }
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            };
            let (output, _errors, status) = tokio::join!(stdout, stderr, wait);
            let output = output?;
            if !status? || output.len() > 65536 {
                return Err(ApiError::new(503, "TRANSLATION_FAILED", "本地日语翻译失败"));
            }
            let result: Value = serde_json::from_slice(&output)?;
            if !result["translation"]
                .as_str()
                .is_some_and(|value| !value.is_empty())
            {
                return Err(ApiError::new(
                    503,
                    "TRANSLATION_FAILED",
                    "翻译服务没有返回译文",
                ));
            }
            Ok(result)
        };
        tokio::select! { result = tokio::time::timeout(Duration::from_secs(180), work) => result.map_err(|_| ApiError::new(503, "TRANSLATION_TIMEOUT", "本地日语翻译超时"))?, _ = self.cancel.cancelled() => Err(cancelled()) }
    }
    pub async fn close(&self) {
        self.cancel.cancel();
        self.managed.lock().unwrap().take();
        self.processes.close().await;
        self.cache.lock().unwrap().clear();
        self.ready.store(false, Ordering::Relaxed);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn legacy_cancellation_interrupts_blocked_stdin() {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("blocked-stdin.cjs");
        std::fs::write(&script, "setInterval(() => {}, 1000);").unwrap();
        let cancel = CancellationToken::new();
        let translation = Translation::new(
            Arc::new(Settings {
                tts_host: "http://127.0.0.1:1".into(),
                profiles: Default::default(),
                translation_url: "http://127.0.0.1:1".into(),
                translation_port: 1,
                python: "node".into(),
                script,
                log: directory.path().join("unused.log"),
            }),
            LocalUpstream::new(),
            cancel.clone(),
        );
        // Exercise the internal pipe boundary independently of the HTTP text
        // limit and OS-specific pipe capacity. No translator or model is used.
        let text = "x".repeat(2 * 1024 * 1024);
        let outcome = {
            let request = translation.legacy(&text);
            tokio::pin!(request);
            assert!(futures_util::poll!(request.as_mut()).is_pending());
            cancel.cancel();
            tokio::time::timeout(Duration::from_secs(1), request.as_mut()).await
        };
        // Always reap the owned fixture, including when the assertion fails.
        translation.close().await;
        assert_eq!(
            outcome
                .expect("stdin write ignored cancellation")
                .unwrap_err()
                .code,
            "ABORTED"
        );
    }
}
