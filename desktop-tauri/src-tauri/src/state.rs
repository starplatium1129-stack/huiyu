use crate::mutex::RecoverMutex;
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

use crate::paths::DesktopPaths;
use crate::window_state::CompanionPreferences;

pub struct AppState {
    pub paths: DesktopPaths,
    pub gateway_url: Mutex<String>,
    pub gateway_recovery: crate::gateway_monitor::Recovery,
    pub ignore_mouse_events: AtomicBool,
    pub quitting: AtomicBool,
    pub startup_dispatched: AtomicBool,
    pub companion_presentation: Mutex<crate::companion_window::Presentation>,
    pub companion_input: Mutex<crate::companion_window::InputRegions>,
    pub live2d_enabled: Mutex<Option<bool>>,
    pub preferences: Mutex<CompanionPreferences>,
    pub workspace_root: Mutex<String>,
    pub log: crate::logger::FileLogger,
}

impl AppState {
    pub fn new(paths: DesktopPaths) -> Self {
        let preferences = crate::window_state::load_companion_preferences(&paths.preferences_file);
        let workspace_root = crate::window_state::load_ai_workspace(&paths.ai_workspace_file);
        let log_path = paths.desktop_log.clone();
        Self {
            paths,
            gateway_url: Mutex::new(String::new()),
            gateway_recovery: crate::gateway_monitor::Recovery::default(),
            ignore_mouse_events: AtomicBool::new(preferences.ignore_mouse_events),
            quitting: AtomicBool::new(false),
            startup_dispatched: AtomicBool::new(false),
            companion_presentation: Mutex::default(),
            companion_input: Mutex::default(),
            live2d_enabled: Mutex::new(preferences.live2d_enabled),
            preferences: Mutex::new(preferences),
            workspace_root: Mutex::new(workspace_root),
            log: crate::logger::FileLogger::new(&log_path),
        }
    }

    pub fn save_preferences(&self) {
        let prefs = self.preferences.recover_lock();
        if !crate::window_state::save_companion_preferences(&self.paths.preferences_file, &prefs) {
            self.warn("could not save companion preferences");
        }
    }

    pub fn log(&self, level: &str, message: &str) {
        eprintln!("[desktop] {message}");
        self.log.write(level, message);
    }

    pub fn info(&self, message: &str) {
        self.log("info", message);
    }

    pub fn warn(&self, message: &str) {
        self.log("warn", message);
    }

    pub fn error(&self, message: &str) {
        self.log("error", message);
    }
}
