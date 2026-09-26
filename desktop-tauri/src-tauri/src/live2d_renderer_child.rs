//! Renderer-only entry point: no Tauri runtime, workspace, gateway, or WebView.
use std::io::{BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use crate::live2d_process_protocol::{ChildMessage, Command, Request, MAX_MESSAGE_BYTES};
use crate::live2d_renderer::live2d_adapter::Live2DAdapterConfig;
use crate::live2d_renderer::{
    apply_frame, overlay_window_thread, send_command, state_snapshot, Live2DOverlayState,
    OverlayCommand, RendererEnvironment, RendererEvents,
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
        let output = output.clone();
        let events = RendererEvents(Arc::new(move |name, payload| {
            if write_message(&output, &ChildMessage::Event { name: name.into(), payload }).is_err() {
                events_state.shutdown.store(true, Ordering::SeqCst);
            }
        }));
        self.worker = Some(thread::spawn(move || {
            let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                overlay_window_thread(state, RendererEnvironment {
                    assets_root, local_root, events: Some(events.clone()),
                });
            }));
            if result.is_err() {
                let _ = events.emit("aics:live2d:stopped", json!({ "reason": "renderer thread panicked" }));
                // OS process teardown owns any window left behind by the unwind.
                std::process::exit(1);
            }
        }));
        let deadline = Instant::now() + Duration::from_secs(30);
        while !self.state.renderer_attached.load(Ordering::SeqCst) {
            if self.worker.as_ref().is_some_and(|worker| worker.is_finished()) {
                return Err("renderer initialization failed; see stopped event".into());
            }
            if Instant::now() >= deadline { return Err("renderer initialization timed out".into()); }
            thread::sleep(Duration::from_millis(10));
        }
        Ok(state_snapshot(&self.state))
    }

    fn wait<T>(&self, mut receiver: tokio::sync::oneshot::Receiver<T>) -> Result<T, String> {
        let deadline = Instant::now() + Duration::from_secs(60);
        loop {
            match receiver.try_recv() {
                Ok(value) => return Ok(value),
                Err(tokio::sync::oneshot::error::TryRecvError::Closed) => return Err("renderer dropped command".into()),
                Err(tokio::sync::oneshot::error::TryRecvError::Empty) => {}
            }
            if Instant::now() >= deadline { return Err("renderer command timed out".into()); }
            thread::sleep(Duration::from_millis(5));
        }
    }

    fn acknowledged<T>(&self, make: impl FnOnce(tokio::sync::oneshot::Sender<Result<T, String>>) -> OverlayCommand) -> Result<T, String> {
        let (sender, receiver) = tokio::sync::oneshot::channel();
        send_command(&self.state, make(sender))?;
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
                *self.state.framing.lock().unwrap() = framing.validate()?;
                apply_frame(&self.state, rect, visible, opacity, companion_hwnd)?;
            }
            Command::PlayMotion { group, index, priority } => {
                self.acknowledged(|reply| OverlayCommand::PlayMotion { group, index, priority, reply })?;
            }
            Command::SetExpression { name } => {
                self.acknowledged(|reply| OverlayCommand::SetExpression { name, reply })?;
            }
            Command::SetMouthLevel { level } => send_command(&self.state, OverlayCommand::SetMouthLevel(level))?,
            Command::SetEmotion { name, intensity } => send_command(&self.state, OverlayCommand::SetEmotion { name, intensity })?,
            Command::SetGaze { x, y } => send_command(&self.state, OverlayCommand::SetGaze(x, y))?,
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
                let (reply, receiver) = tokio::sync::oneshot::channel();
                send_command(&self.state, OverlayCommand::Destroy { reply })?;
                self.wait(receiver)?;
            }
        }
        Ok(json!({ "ok": true }))
    }

    fn stop(&mut self) {
        self.state.shutdown.store(true, Ordering::SeqCst);
        if let Some(sender) = self.state.cmd_tx.lock().unwrap().as_ref() { let _ = sender.send(OverlayCommand::Shutdown); }
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
