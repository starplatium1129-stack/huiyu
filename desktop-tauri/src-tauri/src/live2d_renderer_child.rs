//! Renderer-only entry point: no Tauri runtime, workspace, gateway, or WebView.
use crate::mutex::RecoverMutex;
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

use crate::live2d_process_protocol::{ChildMessage, Command, Request, MAX_MESSAGE_BYTES};
use crate::live2d_renderer::live2d_adapter::Live2DAdapterConfig;
use crate::live2d_renderer::{
    apply_frame, overlay_window_thread, send_command, state_snapshot, Live2DOverlayState,
    OverlayCommand, OverlayReply, RendererEnvironment, RendererEvents,
};
use serde_json::{json, Value};

type Output = Arc<Mutex<std::io::Stdout>>;

fn write_message(output: &Output, message: &ChildMessage) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(message).map_err(|error| error.to_string())?;
    if bytes.len() > MAX_MESSAGE_BYTES { return Err("renderer reply exceeds protocol limit".into()); }
    bytes.push(b'\n');
    let mut writer = output.lock().map_err(|_| "renderer stdout lock poisoned")?;
    writer.write_all(&bytes).and_then(|_| writer.flush()).map_err(|error| error.to_string())
}

/// Read incrementally instead of allocating an unbounded line before checking it.
fn read_request(reader: &mut impl BufRead) -> Result<Option<Request>, String> {
    let mut bytes = Vec::new();
    loop {
        let buffer = reader.fill_buf().map_err(|error| error.to_string())?;
        if buffer.is_empty() {
            return if bytes.is_empty() { Ok(None) } else { Err("renderer protocol ended mid-message".into()) };
        }
        let count = buffer.iter().position(|byte| *byte == b'\n').map(|i| i + 1).unwrap_or(buffer.len());
        if bytes.len() + count > MAX_MESSAGE_BYTES { return Err("renderer request exceeds protocol limit".into()); }
        let complete = buffer[count - 1] == b'\n';
        bytes.extend_from_slice(&buffer[..count]);
        reader.consume(count);
        if complete {
            return serde_json::from_slice(&bytes).map(Some).map_err(|error| format!("invalid renderer request: {error}"));
        }
    }
}

struct ChildRuntime {
    state: Arc<Live2DOverlayState>,
    worker: Option<thread::JoinHandle<()>>,
    initialized: bool,
}

impl ChildRuntime {
    fn new() -> Self {
        Self { state: Arc::new(Live2DOverlayState::default()), worker: None, initialized: false }
    }

    fn initialize(&mut self, assets_root: String, local_root: Option<String>, output: &Output) -> Result<Value, String> {
        if self.initialized { return Err("renderer already initialized".into()); }
        let assets_root = std::fs::canonicalize(assets_root).map_err(|error| format!("renderer assets: {error}"))?;
        if !assets_root.is_dir() { return Err("renderer assets root is not a directory".into()); }
        let local_root = local_root.map(PathBuf::from);
        if local_root.as_ref().is_some_and(|path| !path.is_absolute()) {
            return Err("renderer local root must be absolute".into());
        }
        self.initialized = true;
        self.state.starting.store(true, Ordering::SeqCst);
        let state = self.state.clone();
        let events_state = state.clone();
        let pointer_writer = output.clone();
        let pointer_state = Arc::downgrade(&state);
        let _ = state.pointer_feedback.set(Arc::new(move |sample| {
            if write_message(&pointer_writer, &ChildMessage::PointerHit { sample }).is_err() {
                if let Some(state) = pointer_state.upgrade() {
                    state.shutdown.store(true, Ordering::SeqCst);
                }
            }
        }));
        let output = output.clone();
        let events = RendererEvents(Arc::new(move |name, payload| {
            if write_message(&output, &ChildMessage::Event { name: name.into(), payload }).is_err() {
                events_state.shutdown.store(true, Ordering::SeqCst);
            }
        }));
        let (attached, wait_for_attach) = mpsc::sync_channel(1);
        self.worker = Some(thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                overlay_window_thread(state, RendererEnvironment {
                    cache_root: local_root.as_ref().and_then(|path| path.parent()).map(|path| path.join("live2d-cache")),
                    assets_root, local_root, events: Some(events.clone()), attached: Some(attached),
                });
            }));
            if result.is_err() {
                let _ = events.emit("aics:live2d:stopped", json!({ "reason": "renderer thread panicked" }));
                // OS process teardown owns any window left behind by the unwind.
                std::process::exit(1);
            }
        }));
        wait_for_attach.recv_timeout(Duration::from_secs(30)).map_err(|error| match error {
            mpsc::RecvTimeoutError::Timeout => "renderer initialization timed out",
            mpsc::RecvTimeoutError::Disconnected => "renderer initialization failed; see stopped event",
        })?;
        Ok(state_snapshot(&self.state))
    }

    fn wait<T>(&self, receiver: mpsc::Receiver<T>) -> Result<T, String> {
        receiver.recv_timeout(Duration::from_secs(60)).map_err(|error| match error {
            mpsc::RecvTimeoutError::Disconnected => "renderer dropped command".into(),
            mpsc::RecvTimeoutError::Timeout => "renderer command timed out".into(),
        })
    }

    fn acknowledged<T>(&self, make: impl FnOnce(OverlayReply<Result<T, String>>) -> OverlayCommand) -> Result<T, String> {
        let (sender, receiver) = mpsc::sync_channel(1);
        send_command(&self.state, make(OverlayReply::Blocking(sender)))?;
        self.wait(receiver)?
    }

    fn command(&mut self, command: Command, output: &Output) -> Result<Value, String> {
        if let Command::Initialize { assets_root, local_root } = command {
            return self.initialize(assets_root, local_root, output);
        }
        if matches!(command, Command::Shutdown) {
            self.stop();
            return Ok(json!({ "ok": true }));
        }
        if !self.initialized || !self.state.renderer_attached.load(Ordering::SeqCst) {
            return Err("renderer not initialized or stopped".into());
        }
        match command {
            Command::Initialize { .. } | Command::Shutdown => unreachable!(),
            Command::GetState => return Ok(state_snapshot(&self.state)),
            Command::SetCharacter { character, texture_scale, adapter } => {
                if !matches!(texture_scale, 1 | 2 | 4) { return Err("invalid Live2D texture scale".into()); }
                let adapter: Live2DAdapterConfig = serde_json::from_value(adapter).map_err(|error| format!("invalid Live2D adapter: {error}"))?;
                adapter.validate()?;
                self.acknowledged(|reply| OverlayCommand::SetCharacter { character, texture_scale, adapter, reply })?;
            }
            Command::SetFrame { rect, visible, opacity, framing, companion_hwnd } => {
                let framing: crate::live2d_framing::StageFraming = framing.map(serde_json::from_value)
                    .transpose().map_err(|error| format!("invalid Live2D framing: {error}"))?.unwrap_or_default();
                *self.state.framing.recover_lock() = framing.validate()?;
                apply_frame(&self.state, rect, visible, opacity, companion_hwnd)?;
            }
            Command::PlayMotion { group, index, priority } => {
                self.acknowledged(|reply| OverlayCommand::PlayMotion { group, index, priority, reply })?;
            }
            Command::SetExpression { name } => {
                self.acknowledged(|reply| OverlayCommand::SetExpression { name, reply })?;
            }
            Command::SetMouthLevel { level } => self.state.publish_mouth(level),
            Command::SetEmotion { name, intensity } => send_command(&self.state, OverlayCommand::SetEmotion { name, intensity })?,
            Command::SetGaze { x, y } => self.state.publish_gaze(x, y),
            Command::SetMaxFps { fps } => send_command(&self.state, OverlayCommand::SetMaxFps(fps))?,
            Command::HitTest { x, y } => {
                let areas = self.acknowledged(|reply| OverlayCommand::HitTest { x, y, reply })?;
                return Ok(json!({ "areas": areas }));
            }
            Command::Snapshot { path } => {
                if !PathBuf::from(&path).is_absolute() { return Err("snapshot path must be absolute".into()); }
                self.acknowledged(|reply| OverlayCommand::Snapshot { path, reply })?;
            }
            Command::Destroy => {
                let (reply, receiver) = mpsc::sync_channel(1);
                send_command(&self.state, OverlayCommand::Destroy { reply: OverlayReply::Blocking(reply) })?;
                self.wait(receiver)?;
            }
        }
        Ok(json!({ "ok": true }))
    }

    fn stop(&mut self) {
        self.state.shutdown.store(true, Ordering::SeqCst);
        if let Some(sender) = self.state.cmd_tx.recover_lock().as_ref() { let _ = sender.send(OverlayCommand::Shutdown); }
        if let Some(worker) = self.worker.take() { let _ = worker.join(); }
    }
}

impl Drop for ChildRuntime {
    fn drop(&mut self) { self.stop(); }
}

pub fn run() -> Result<(), String> {
    let output = Arc::new(Mutex::new(std::io::stdout()));
    let mut runtime = ChildRuntime::new();
    let input = std::io::stdin();
    let mut reader = input.lock();
    while let Some(request) = read_request(&mut reader)? {
        let shutdown = matches!(request.command, Command::Shutdown);
        let result = runtime.command(request.command, &output);
        write_message(&output, &ChildMessage::Reply { id: request.id, result })?;
        if shutdown { break; }
    }
    // EOF and protocol failure both run Drop, joining the renderer after GPU/HWND release.
    Ok(())
}
