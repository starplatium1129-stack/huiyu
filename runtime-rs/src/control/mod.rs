mod actions;
mod comfy;
mod hardware;
mod http;
mod inference;
mod inference_discovery;
mod inference_setup;
mod llama;
mod logs;
mod operation_journal;
mod native_setup;
mod probe;
mod settings;
mod setup;
mod setup_download;
mod setup_environment;
mod setup_http;
mod setup_verify;

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
    borrow::Cow,
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
    settings: RwLock<Arc<Value>>,
    config_write: Arc<tokio::sync::Mutex<()>>,
    inference: Result<crate::generation::native::Settings>,
    inference_probe: tokio::sync::Mutex<()>,
    images: RwLock<std::sync::Weak<crate::images::ImageService>>,
    saved: Arc<RwLock<Value>>,
    state: Mutex<ControlState>,
    operation_journal: Mutex<Result<operation_journal::Journal>>,
    instance_id: String,
    probe_lock: tokio::sync::Mutex<()>,
    setup_verify_lock: Arc<tokio::sync::Semaphore>,
    environment_cancel: Mutex<Option<CancellationToken>>,
    llama_cancel: Mutex<Option<CancellationToken>>,
    llama_process: tokio::sync::Mutex<Option<crate::processes::OwnedProcess>>,
    llama_secret: String,
    comfy_cancel: Mutex<Option<CancellationToken>>,
    comfy_action: tokio::sync::Mutex<()>,
    comfy_process: tokio::sync::Mutex<Option<crate::processes::OwnedProcess>>,
    started: Instant,
    tunnel: tokio::sync::Mutex<Option<tunnel::TunnelRun>>,
    tunnel_action: tokio::sync::Mutex<()>,
    build_cache: tokio::sync::Mutex<Option<(Instant, Value)>>,
    log_tails: Mutex<logs::Cache>,
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
    llama_release_unconfirmed: bool,
    operation: Option<Value>,
    operation_checkpoint: Option<Instant>,
    seq: u64,
    logs: VecDeque<Arc<String>>,
    log_seq: u64,
    managed: [Managed; 4],
    health: Arc<Value>,
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
        let settings = json!({"sdHost":config.sd_host,"comfyHost":config.comfy_host,"ttsHost":host("TTS_HOST","ttsHost","http://127.0.0.1:9880"),"ttsEngine":if saved["ttsEngine"]=="voxcpm2"{"voxcpm2"}else{"gpt-sovits"},"ollamaHost":host("OLLAMA_HOST","ollamaHost","http://127.0.0.1:11434"),"llamaHost":host("LLAMA_HOST","llamaHost","http://127.0.0.1:8000"),"llamaModel":saved["llamaModel"],"voices":saved.get("voices").filter(|v|v.is_object()).cloned().unwrap_or(json!({})),"autoStartVoice":saved["autoStartVoice"]==true});
        let inference = crate::generation::native::load(&crate::generation::Config {
            sd_host: config.sd_host.clone(),
            sd_auth: config.sd_auth.clone(),
            comfy_host: config.comfy_host.clone(),
            ai_workspace_root: config.ai_workspace_root.clone(),
            runtime_root: config.runtime_root.clone(),
        });
        let operation_journal = operation_journal::Journal::open(&config).and_then(|journal| {
            journal.get(None)?;
            Ok(journal)
        });
        let operation = operation_journal.as_ref().ok().and_then(|journal| journal.get(None).ok().flatten());
        let service = Arc::new(Self {
            voice,
            inference,
            inference_probe: tokio::sync::Mutex::new(()),
            images: RwLock::default(),
            config,
            remote,
            shutdown: shutdown.child_token(),
            transport: LocalUpstream::new(),
            processes: Arc::default(),
            tasks: TaskTracker::new(),
            settings: RwLock::new(Arc::new(settings)),
            saved: Arc::new(RwLock::new(saved)),
            config_write: Arc::new(tokio::sync::Mutex::new(())),
            state: Mutex::new(ControlState { operation, ..Default::default() }),
            operation_journal: Mutex::new(operation_journal),
            instance_id: uuid::Uuid::new_v4().to_string(),
            probe_lock: tokio::sync::Mutex::new(()),
            setup_verify_lock: Arc::new(tokio::sync::Semaphore::new(1)),
            environment_cancel: Mutex::new(None),
            llama_cancel: Mutex::new(None),
            llama_process: tokio::sync::Mutex::new(None),
            llama_secret: uuid::Uuid::new_v4().to_string(),
            comfy_cancel: Mutex::new(None),
            comfy_action: tokio::sync::Mutex::new(()),
            comfy_process: tokio::sync::Mutex::new(None),
            started: Instant::now(),
            tunnel: tokio::sync::Mutex::new(None),
            tunnel_action: tokio::sync::Mutex::new(()),
            build_cache: tokio::sync::Mutex::new(None),
            log_tails: Mutex::default(),
        });
        // Restore only the explicitly managed Comfy intent. Opening the app does
        // not launch a model: the first generation wakes it, then watchdog owns it.
        service.state.lock().unwrap().managed[1].desired = service.saved_comfy_intent();
        let weak = Arc::downgrade(&service);
        let cancel = service.shutdown.clone();
        service.tasks.spawn(async move {loop {tokio::select! {_=cancel.cancelled()=>break,_=tokio::time::sleep(Duration::from_secs(5))=>{}}
            let Some(service)=weak.upgrade() else {break};service.watchdog().await;
        }});
        service
    }
    pub async fn close(&self) {
        self.shutdown.cancel();
        let _ = self.stop_llama().await;
        let _ = self.run_comfy(false).await;
        self.stop_tunnel().await;
        // Cancellation must drain the setup owner before closing its process
        // pool: a VC++ installer may be in its protected Windows/UAC phase.
        let _setup_drained = self.setup_verify_lock.acquire().await;
        self.processes.close().await;
        self.tasks.close();
        self.tasks.wait().await;
    }
    fn runtime_settings(&self) -> Arc<Value> {
        self.settings.read().unwrap().clone()
    }
    fn runtime_setting(&self, key: &str) -> Value {
        self.settings.read().unwrap()[key].clone()
    }
    fn settings(&self) -> Value {
        let mut value = self.runtime_settings().as_ref().clone();
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
        state.logs.push_back(Arc::new(format!("[{}] {}", now(), message)));
        if state.logs.len() > 200 {
            state.logs.pop_front();
        }
    }
    fn redact(&self, message: &str) -> String {
        let mut value = Cow::Borrowed(message);
        for secret in [
            &self.config.token,
            &self.llama_secret,
            self.config.desktop_secret.as_deref().unwrap_or(""),
        ] {
            if !secret.is_empty() && value.contains(secret) {
                value = Cow::Owned(value.replace(secret, "[redacted]"));
            }
        }
        static SENSITIVE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
            regex::Regex::new(
                r#"(?i)https://[^\s]+trycloudflare\.com[^\s]*|https?://[^\s/@]+:[^\s/@]+@|bearer\s+[^\s,;"']+|\b(?:token|aics_token|api[-_]?key|password|secret|authorization)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;&]+)|\b[a-f0-9]{32,}\b"#,
            )
            .unwrap()
        });
        match SENSITIVE.replace_all(&value, "[redacted]") {
            Cow::Owned(redacted) => redacted,
            Cow::Borrowed(_) => value.into_owned(),
        }
    }
    fn begin(&self, kind: &str, stages: &[&str]) -> Result<Value> {
        self.begin_with_id(kind, stages, None)
    }
    fn begin_with_id(&self, kind: &str, stages: &[&str], requested_id: Option<&str>) -> Result<Value> {
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
        let id = match requested_id {
            Some(id) => uuid::Uuid::parse_str(id).map_err(|_| ApiError::invalid("操作编号无效"))?.to_string(),
            None => uuid::Uuid::new_v4().to_string(),
        };
        let op = json!({"id":id,"kind":kind,"label":kind,"workspacePath":self.config.ai_workspace_root,"status":"running","stageIndex":0,"stages":stages,"message":stages.first().copied().unwrap_or(kind),"startedAt":now(),"finishedAt":0,"error":""});
        self.persist_operation(&op, true)?;
        state.seq += 1;
        state.operation_checkpoint = None;
        state.operation = Some(op.clone());
        Ok(op)
    }
    fn stage(&self, id: &Value, index: usize) {
        let mut state = self.state.lock().unwrap();
        if let Some(op) = state.operation.as_mut().filter(|op| op["id"] == id["id"]) {
            op["stageIndex"] = json!(index);
            op["message"] = op["stages"][index].clone();
        }
        self.checkpoint_operation(&mut state, true);
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
        self.checkpoint_operation(&mut state, true);
    }
}
