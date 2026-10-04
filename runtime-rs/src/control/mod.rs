mod actions;
mod http;
mod probe;
mod settings;
mod setup;
#[cfg(test)]
mod tests;
mod tunnel;

use crate::{
    config::Config,
    error::{ApiError, Result},
    processes::Processes,
    remote_content::RemoteAccess,
    upstream::LocalUpstream,
};
pub use http::router;
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex, RwLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio_util::{sync::CancellationToken, task::TaskTracker};

pub struct ControlService {
    voice: Arc<crate::voice::VoiceService>,
    config: Arc<Config>,
    remote: Arc<RemoteAccess>,
    shutdown: CancellationToken,
    transport: LocalUpstream,
    processes: Arc<Processes>,
    tasks: TaskTracker,
    settings: RwLock<Value>,
    config_write: Arc<tokio::sync::Mutex<()>>,
    saved: Arc<RwLock<Value>>,
    state: Mutex<ControlState>,
    probe_lock: tokio::sync::Mutex<()>,
    started: Instant,
    tunnel: tokio::sync::Mutex<Option<tunnel::TunnelRun>>,
    tunnel_action: tokio::sync::Mutex<()>,
    build_cache: tokio::sync::Mutex<Option<(Instant, Value)>>,
}
#[derive(Default)]
struct Managed {
    owned: bool,
    desired: bool,
    attempt: u32,
    next: Option<Instant>,
    last_error: String,
    last_restart: u64,
}
#[derive(Default)]
struct ControlState {
    operation: Option<Value>,
    seq: u64,
    logs: VecDeque<String>,
    log_seq: u64,
    managed: [Managed; 4],
    health: Value,
    health_at: Option<Instant>,
}
pub(super) fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
impl ControlService {
    pub fn new(
        config: Arc<Config>,
        remote: Arc<RemoteAccess>,
        shutdown: CancellationToken,
        voice: Arc<crate::voice::VoiceService>,
    ) -> Arc<Self> {
        let saved: Value = std::fs::read(config.runtime_root.join("config.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or(json!({}));
        let host = |env: &str, key: &str, default: &str| {
            std::env::var(env)
                .ok()
                .or_else(|| saved[key].as_str().map(str::to_owned))
                .filter(|s| crate::upstream::local_url(s).is_ok())
                .unwrap_or(default.into())
        };
        let settings = json!({"sdHost":config.sd_host,"comfyHost":config.comfy_host,"ttsHost":host("TTS_HOST","ttsHost","http://127.0.0.1:9880"),"ollamaHost":host("OLLAMA_HOST","ollamaHost","http://127.0.0.1:11434"),"voices":saved.get("voices").filter(|v|v.is_object()).cloned().unwrap_or(json!({})),"autoStartVoice":saved["autoStartVoice"]==true});
        let service = Arc::new(Self {
            voice,
            config,
            remote,
            shutdown: shutdown.child_token(),
            transport: LocalUpstream::new(),
            processes: Arc::default(),
            tasks: TaskTracker::new(),
            settings: RwLock::new(settings),
            saved: Arc::new(RwLock::new(saved)),
            config_write: Arc::new(tokio::sync::Mutex::new(())),
            state: Mutex::default(),
            probe_lock: tokio::sync::Mutex::new(()),
            started: Instant::now(),
            tunnel: tokio::sync::Mutex::new(None),
            tunnel_action: tokio::sync::Mutex::new(()),
            build_cache: tokio::sync::Mutex::new(None),
        });
        // No saved preference constitutes authorization to launch a model. The
        // watchdog stays inert until an explicit start was verified this session.
        let weak = Arc::downgrade(&service);
        let cancel = service.shutdown.clone();
        service.tasks.spawn(async move {loop {tokio::select! {_=cancel.cancelled()=>break,_=tokio::time::sleep(Duration::from_secs(5))=>{}}
            let Some(service)=weak.upgrade() else {break};service.watchdog().await;
        }});
        service
    }
    pub async fn close(&self) {
        self.shutdown.cancel();
        self.stop_tunnel().await;
        self.processes.close().await;
        self.tasks.close();
        self.tasks.wait().await;
    }
    fn settings(&self) -> Value {
        let mut value = self.settings.read().unwrap().clone();
        let saved = self.saved.read().unwrap();
        if saved["autoStartVoice"].is_boolean() {
            value["autoStartVoice"] = saved["autoStartVoice"].clone();
        }
        value
    }
    fn log(&self, message: &str) {
        let message = self.redact(message);
        let mut state = self.state.lock().unwrap();
        state.log_seq += 1;
        state.logs.push_back(format!("[{}] {}", now(), message));
        if state.logs.len() > 200 {
            state.logs.pop_front();
        }
    }
    fn redact(&self, message: &str) -> String {
        let mut value = message.to_owned();
        for secret in [
            &self.config.token,
            self.config.desktop_secret.as_deref().unwrap_or(""),
        ] {
            if !secret.is_empty() {
                value = value.replace(secret, "[redacted]");
            }
        }
        static SENSITIVE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
            regex::Regex::new(
                r#"(?i)https://[^\s]+trycloudflare\.com[^\s]*|https?://[^\s/@]+:[^\s/@]+@|bearer\s+[^\s,;"']+|\b(?:token|aics_token|api[-_]?key|password|secret|authorization)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)|\b[a-f0-9]{32,}\b"#,
            )
            .unwrap()
        });
        SENSITIVE.replace_all(&value, "[redacted]").into_owned()
    }
    fn begin(&self, kind: &str, stages: &[&str]) -> Result<Value> {
        if self.shutdown.is_cancelled() {
            return Err(ApiError::new(503, "SHUTTING_DOWN", "运行时正在退出"));
        }
        let mut state = self.state.lock().unwrap();
        if state
            .operation
            .as_ref()
            .is_some_and(|op| op["status"] == "running")
        {
            return Err(ApiError::new(
                409,
                "CONTROL_BUSY",
                "已有操作正在进行，请等待完成",
            ));
        }
        state.seq += 1;
        let op = json!({"id":format!("{}-{}",now(),state.seq),"kind":kind,"label":kind,"status":"running","stageIndex":0,"stages":stages,"message":stages.first().copied().unwrap_or(kind),"startedAt":now(),"finishedAt":0,"error":""});
        state.operation = Some(op.clone());
        Ok(op)
    }
    fn stage(&self, id: &Value, index: usize) {
        let mut state = self.state.lock().unwrap();
        if let Some(op) = state.operation.as_mut().filter(|op| op["id"] == id["id"]) {
            op["stageIndex"] = json!(index);
            op["message"] = op["stages"][index].clone();
        }
    }
    fn finish(&self, id: &Value, result: Result<()>) {
        let error = result.err().map(|e| self.redact(&e.message));
        if let Some(error) = &error {
            self.log(error);
        }
        let mut state = self.state.lock().unwrap();
        if let Some(op) = state.operation.as_mut().filter(|op| op["id"] == id["id"]) {
            op["status"] = json!(if error.is_some() {
                "failed"
            } else {
                "completed"
            });
            op["finishedAt"] = json!(now());
            op["error"] = json!(error.clone().unwrap_or_default());
            op["message"] = json!(error.unwrap_or("操作完成".into()));
        }
    }
}
