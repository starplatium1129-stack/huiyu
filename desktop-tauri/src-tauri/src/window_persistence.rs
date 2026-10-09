//! Capture geometry on the event thread; one debounced worker owns disk writes.
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Condvar, Mutex},
    thread::JoinHandle,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use crate::window_state::{save_window_bounds, save_window_presentation, WindowBounds};

struct Snapshot {
    bounds: Option<(WindowBounds, WindowBounds)>,
    maximized: Option<bool>,
}
impl Snapshot {
    fn save(self, file: &std::path::Path) {
        if let Some((logical, physical)) = self.bounds {
            save_window_bounds(file, &logical, Some(&physical));
        }
        if let Some(maximized) = self.maximized {
            save_window_presentation(file, None, Some(maximized));
        }
    }
}
#[derive(Default)]
struct Pending {
    windows: HashMap<PathBuf, Snapshot>,
    deadline: Option<Instant>,
    writing: bool,
    closing: bool,
}
pub struct WindowStateWriter {
    shared: Arc<(Mutex<Pending>, Condvar)>,
    worker: Mutex<Option<JoinHandle<()>>>,
}
impl WindowStateWriter {
    pub fn new() -> Self {
        let shared = Arc::new((Mutex::new(Pending::default()), Condvar::new()));
        let queue = shared.clone();
        let worker = std::thread::spawn(move || {
            let (lock, changed) = &*queue;
            let mut pending = lock.lock().unwrap();
            loop {
                if pending.windows.is_empty() {
                    if pending.closing { return; }
                    pending = changed.wait(pending).unwrap();
                    continue;
                }
                let delay = pending.deadline.unwrap().saturating_duration_since(Instant::now());
                if !pending.closing && !delay.is_zero() {
                    pending = changed.wait_timeout(pending, delay).unwrap().0;
                    continue;
                }
                let windows = std::mem::take(&mut pending.windows);
                pending.deadline = None;
                pending.writing = true;
                drop(pending);
                for (file, snapshot) in windows { snapshot.save(&file); }
                pending = lock.lock().unwrap();
                pending.writing = false;
                changed.notify_all();
            }
        });
        Self { shared, worker: Mutex::new(Some(worker)) }
    }
    fn schedule(&self, file: PathBuf, mut snapshot: Snapshot) {
        let (lock, changed) = &*self.shared;
        let mut pending = lock.lock().unwrap();
        if pending.closing { return; }
        // Maximizing before the debounce expires must retain the last normal bounds.
        if snapshot.bounds.is_none() {
            snapshot.bounds = pending.windows.get_mut(&file).and_then(|previous| previous.bounds.take());
        }
        pending.windows.insert(file, snapshot);
        pending.deadline = Some(Instant::now() + Duration::from_millis(250));
        changed.notify_all();
    }
    pub fn flush(&self) {
        let (lock, changed) = &*self.shared;
        let mut pending = lock.lock().unwrap();
        pending.deadline = Some(Instant::now());
        changed.notify_all();
        while pending.writing || !pending.windows.is_empty() {
            pending = changed.wait(pending).unwrap();
        }
    }
    pub fn shutdown(&self) {
        let (lock, changed) = &*self.shared;
        lock.lock().unwrap().closing = true;
        changed.notify_all();
        if let Some(worker) = self.worker.lock().unwrap().take() { let _ = worker.join(); }
    }
}
impl Drop for WindowStateWriter {
    fn drop(&mut self) { self.shutdown(); }
}

pub fn changed(app: &AppHandle, label: &str) {
    let state = app.state::<crate::state::AppState>();
    let file = match label {
        "companion" => &state.paths.companion_window_file,
        "atelier" => &state.paths.atelier_window_file,
        "companion-chat" => &state.paths.companion_chat_window_file,
        _ => return,
    };
    let Some(window) = app.get_webview_window(label) else { return };
    let maximized = if label == "companion" { None } else {
        if window.is_minimized().unwrap_or(true) || window.is_fullscreen().unwrap_or(true) { return; }
        let Ok(value) = window.is_maximized() else { return };
        Some(value)
    };
    let bounds = if maximized == Some(true) { None } else {
        crate::main_shared::persisted_webview_bounds(&window)
    };
    if label == "companion" {
        if let Some((_, physical)) = &bounds { let _ = window.emit("aics:window-bounds", physical); }
    }
    app.state::<WindowStateWriter>().schedule(file.clone(), Snapshot { bounds, maximized });
}

pub fn closing(app: &AppHandle, label: &str) {
    changed(app, label);
    // The worker never calls window APIs, so flushing cannot wait on the event thread.
    app.state::<WindowStateWriter>().flush();
}

pub fn shutdown(app: &AppHandle) {
    for label in ["companion", "atelier", "companion-chat"] { changed(app, label); }
    app.state::<WindowStateWriter>().shutdown();
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::window_state::{load_window_bounds, load_window_presentation};

    #[test]
    fn flush_and_shutdown_keep_latest_normal_bounds_and_zoom() {
        let root = std::env::temp_dir().join(format!("aics-window-writer-{}", std::process::id()));
        let file = root.join("window.json");
        assert!(save_window_presentation(&file, Some(1.25), None));
        let writer = WindowStateWriter::new();
        for x in [10, 20, 30] {
            let bounds = WindowBounds { x, y: 80, width: 600, height: 800 };
            writer.schedule(file.clone(), Snapshot { bounds: Some((bounds.clone(), bounds)), maximized: Some(false) });
        }
        writer.schedule(file.clone(), Snapshot { bounds: None, maximized: Some(true) });
        writer.flush();
        assert_eq!(load_window_bounds(&file, None).0.x, 30);
        assert!(load_window_presentation(&file).maximized);
        assert_eq!(load_window_presentation(&file).zoom, 1.25);
        let final_bounds = WindowBounds { x: 40, y: 90, width: 640, height: 840 };
        writer.schedule(file.clone(), Snapshot { bounds: Some((final_bounds.clone(), final_bounds.clone())), maximized: Some(false) });
        writer.shutdown();
        assert_eq!(load_window_bounds(&file, None), (final_bounds.clone(), Some(final_bounds)));
        assert!(!load_window_presentation(&file).maximized);
        assert_eq!(load_window_presentation(&file).zoom, 1.25);
        std::fs::remove_dir_all(root).unwrap();
    }
}
