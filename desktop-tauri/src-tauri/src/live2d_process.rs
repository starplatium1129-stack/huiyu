//! Opt-in R12 renderer ownership. Only an explicit model selection starts a child.
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, Command as ProcessCommand, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::oneshot;
use crate::live2d_process_protocol::{ChildMessage, Command, Request, CHILD_ARGUMENT, MAX_MESSAGE_BYTES};
#[path = "live2d_process_job.rs"]
mod job;

pub type EventSink = Arc<dyn Fn(&str, Value) + Send + Sync>;
type Reply = Result<Value, String>;
static CURRENT: OnceLock<Mutex<Option<Arc<RendererProcess>>>> = OnceLock::new();
static START: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static GENERATION: AtomicU64 = AtomicU64::new(0);
// Ownership changes and event delivery share this gate. An atomic check alone
// allows an old callback to resume after a new renderer has already started.
static EVENT_GENERATION: Mutex<u64> = Mutex::new(0);
static SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);
const MAX_PENDING: usize = 32;

pub fn enabled() -> bool {
    std::env::var("AICS_LIVE2D_RENDERER_PROCESS").as_deref() == Ok("1")
        && crate::ui_entry::isolated_profile().is_some()
        && std::env::var_os("AICS_DESKTOP_CONFIG_ROOT")
            .map(PathBuf::from).is_some_and(|path| path.is_absolute())
}

pub struct RendererProcess {
    generation: u64,
    pid: u32,
    child: Mutex<Child>,
    _job: job::RendererJob,
    writer: mpsc::SyncSender<Vec<u8>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Reply>>>,
    next_id: AtomicU64,
    stopped: AtomicBool,
    shutdown_requested: AtomicBool,
    emit: EventSink,
}

impl RendererProcess {
    fn emit_current(&self, name: &str, payload: Value) {
        let generation = EVENT_GENERATION.lock().unwrap();
        if *generation == self.generation
            && (name == "aics:live2d:stopped" || !self.stopped.load(Ordering::SeqCst))
        {
            (self.emit)(name, payload);
        }
    }

    pub fn diagnostics(&self) -> Value {
        json!({"alive": !self.stopped.load(Ordering::SeqCst), "childPid": self.pid,
            "generation": self.generation, "pending": self.pending.lock().unwrap().len()})
    }

    pub fn stop(&self, reason: &str) {
        if self.stopped.swap(true, Ordering::SeqCst) { return; }
        let _ = self.child.lock().unwrap().kill();
        for (_, reply) in self.pending.lock().unwrap().drain() {
            let _ = reply.send(Err(format!("renderer stopped: {reason}")));
        }
        self.emit_current("aics:live2d:stopped", json!({"reason": reason}));
    }

    pub async fn call(self: &Arc<Self>, command: Command, timeout: Duration) -> Reply {
        let is_shutdown = matches!(&command, Command::Shutdown);
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let mut bytes = serde_json::to_vec(&Request { id, command }).map_err(|e| e.to_string())?;
        if bytes.len() >= MAX_MESSAGE_BYTES { return Err("renderer request exceeds limit".into()); }
        bytes.push(b'\n');
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap();
            if self.stopped.load(Ordering::SeqCst) { return Err("renderer not attached".into()); }
            if self.shutdown_requested.load(Ordering::SeqCst) { return Err("renderer is shutting down".into()); }
            if pending.len() >= MAX_PENDING { return Err("renderer request queue is full".into()); }
            if is_shutdown { self.shutdown_requested.store(true, Ordering::SeqCst); }
            pending.insert(id, tx);
            // Keep enqueue order with admission: nothing may reach the pipe after
            // Shutdown and race its final reply by writing to the closed child.
            if self.writer.try_send(bytes).is_err() {
                pending.remove(&id);
                if is_shutdown { self.shutdown_requested.store(false, Ordering::SeqCst); }
                return Err("renderer request queue unavailable".into());
            }
        }
        // Cancellation of the caller also releases its pending slot.
        let _pending = Pending { process: self.clone(), id };
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(reply)) => reply,
            Ok(Err(_)) => Err("renderer reply channel closed".into()),
            Err(_) => {
                // A timed-out mutation has an unknown outcome. Discard this generation;
                // never replay commands or implicitly reload its last model.
                self.stop("renderer request timed out");
                Err("renderer request timed out".into())
            }
        }
    }
}

struct Pending { process: Arc<RendererProcess>, id: u64 }
impl Drop for Pending {
    fn drop(&mut self) { self.process.pending.lock().unwrap().remove(&self.id); }
}
struct Starting { process: Arc<RendererProcess>, accepted: bool }
impl Drop for Starting {
    fn drop(&mut self) { if !self.accepted { self.process.stop("renderer startup cancelled"); } }
}

/// Bounded line reads prevent child corruption from growing the parent's heap.
pub fn read_line(reader: &mut impl BufRead) -> Result<Option<Vec<u8>>, String> {
    let mut bytes = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(|e| e.to_string())?;
        if available.is_empty() {
            return if bytes.is_empty() { Ok(None) } else { Err("truncated renderer message".into()) };
        }
        let newline = available.iter().position(|b| *b == b'\n');
        let consumed = newline.map_or(available.len(), |position| position + 1);
        if bytes.len() + consumed > MAX_MESSAGE_BYTES + 1 { return Err("renderer message exceeds limit".into()); }
        bytes.extend_from_slice(&available[..consumed]);
        reader.consume(consumed);
        if newline.is_some() { return Ok(Some(bytes)); }
    }
}

fn spawn(emit: EventSink) -> Result<Starting, String> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut child = ProcessCommand::new(executable).arg(CHILD_ARGUMENT)
        .creation_flags(0x08000000) // CREATE_NO_WINDOW; stderr remains diagnostic-only.
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit())
        .spawn().map_err(|e| format!("start renderer: {e}"))?;
    // Child may only read stdin until Initialize. EOF exits if the host dies in
    // the short spawn/assign interval; after assignment the kernel owns cleanup.
    let job = match job::RendererJob::attach(&child) {
        Ok(job) => job,
        Err(error) => { let _ = child.kill(); let _ = child.wait(); return Err(format!("attach renderer job: {error}")); }
    };
    let mut stdin = child.stdin.take().ok_or("renderer stdin unavailable")?;
    let stdout = child.stdout.take().ok_or("renderer stdout unavailable")?;
    let (writer, queued) = mpsc::sync_channel::<Vec<u8>>(MAX_PENDING);
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    *EVENT_GENERATION.lock().unwrap() = generation;
    let process = Arc::new(RendererProcess {
        generation,
        pid: child.id(), child: Mutex::new(child), _job: job, writer,
        pending: Mutex::new(HashMap::new()), next_id: AtomicU64::new(1),
        stopped: AtomicBool::new(false), shutdown_requested: AtomicBool::new(false), emit,
    });
    let writing = process.clone();
    std::thread::spawn(move || {
        while !writing.stopped.load(Ordering::SeqCst) {
            match queued.recv_timeout(Duration::from_millis(100)) {
                Ok(bytes) => if stdin.write_all(&bytes).and_then(|_| stdin.flush()).is_err() {
                    writing.stop("renderer stdin disconnected"); break;
                },
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(_) => break,
            }
        }
    });
    let reading = process.clone();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        while !reading.stopped.load(Ordering::SeqCst) {
            let message = match read_line(&mut reader) {
                Ok(Some(line)) => serde_json::from_slice::<ChildMessage>(&line),
                Ok(None) => { reading.stop("renderer process exited"); break; }
                Err(error) => { reading.stop(&error); break; }
            };
            if reading.stopped.load(Ordering::SeqCst) { break; }
            match message {
                Ok(ChildMessage::Reply { id, result }) => {
                    if let Some(reply) = reading.pending.lock().unwrap().remove(&id) { let _ = reply.send(result); }
                }
                Ok(ChildMessage::Event { name, payload }) => {
                    if name == "aics:live2d:stopped" {
                        if reading.shutdown_requested.load(Ordering::SeqCst) { continue; }
                        reading.stop(payload["reason"].as_str().unwrap_or("renderer stopped")); break;
                    }
                    if matches!(name.as_str(), "aics:live2d:ready" | "aics:live2d:hit-test"
                        | "aics:live2d:entrance-finished" | "aics:live2d:adapter-diagnostic"
                        | "aics:live2d:motion-started" | "aics:live2d:motion-failed") {
                        reading.emit_current(&name, payload);
                    }
                }
                Err(error) => { reading.stop(&format!("invalid renderer protocol: {error}")); break; }
            }
        }
    });
    let waiting = process.clone();
    std::thread::spawn(move || loop {
        let status = waiting.child.lock().unwrap().try_wait();
        match status {
            Ok(Some(_)) => {
                // A clean Shutdown writes its reply immediately before exiting.
                // The reader must drain that pipe before EOF rejects leftovers.
                if !waiting.shutdown_requested.load(Ordering::SeqCst) {
                    waiting.stop("renderer process exited");
                }
                break;
            }
            Err(_) => { waiting.stop("renderer process wait failed"); break; }
            Ok(None) => std::thread::sleep(Duration::from_millis(30)),
        }
    });
    Ok(Starting { process, accepted: false })
}

pub fn current() -> Option<Arc<RendererProcess>> {
    CURRENT.get_or_init(|| Mutex::new(None)).lock().unwrap().clone()
        .filter(|process| !process.stopped.load(Ordering::SeqCst))
}

pub async fn get_or_start(assets_root: PathBuf, local_root: Option<PathBuf>, emit: EventSink)
    -> Result<Arc<RendererProcess>, String>
{
    if !enabled() { return Err("renderer process requires explicit isolated profile".into()); }
    let _start = START.lock().await;
    if SHUTTING_DOWN.load(Ordering::SeqCst) { return Err("desktop is shutting down".into()); }
    if let Some(process) = current() { return Ok(process); }
    let mut starting = tauri::async_runtime::spawn_blocking(move || spawn(emit))
        .await.map_err(|e| e.to_string())??;
    starting.process.call(Command::Initialize {
        assets_root: assets_root.to_string_lossy().into_owned(),
        local_root: local_root.map(|path| path.to_string_lossy().into_owned()),
    }, Duration::from_secs(35)).await?;
    if SHUTTING_DOWN.load(Ordering::SeqCst) { return Err("desktop is shutting down".into()); }
    *CURRENT.get_or_init(|| Mutex::new(None)).lock().unwrap() = Some(starting.process.clone());
    starting.accepted = true;
    Ok(starting.process.clone())
}

pub fn inactive_state() -> Value {
    json!({"active": false, "rect": {"x": 0, "y": 0, "width": 0, "height": 0},
        "visible": false, "frameCount": 0, "targetFps": 0, "character": null,
        "ready": false, "windowReady": false, "rendererAttached": false, "starting": false,
        "modelBounds": null, "mouthLevel": 0.0, "mouthMappedValue": 0.0,
        "surfaceFailures": 0, "surfaceRecoveries": 0, "renderErrors": 0})
}

pub async fn call(app: &AppHandle, command: Command) -> Reply {
    let process = if matches!(&command, Command::SetCharacter { .. }) {
        let paths = app.state::<crate::state::AppState>().paths.clone();
        let app = app.clone();
        get_or_start(paths.assets_root.clone(), Some(paths.runtime_root.join("live2d-imports")),
            Arc::new(move |name, payload| { let _ = app.emit(name, payload); })).await?
    } else if let Some(process) = current() { process }
    else { return match command {
        Command::GetState => Ok(inactive_state()), Command::Destroy => Ok(Value::Null),
        _ => Err("renderer not attached".into()),
    }; };
    let timeout = if matches!(&command, Command::SetCharacter { .. }) { 45 } else { 5 };
    process.call(command, Duration::from_secs(timeout)).await
}

pub fn shutdown() {
    SHUTTING_DOWN.store(true, Ordering::SeqCst);
    if let Some(process) = CURRENT.get_or_init(|| Mutex::new(None)).lock().unwrap().take() {
        process.stop("desktop exiting");
    }
}
