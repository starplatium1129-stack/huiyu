pub mod taskbar;

use crate::mutex::RecoverMutex;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicU8, Ordering},
        Mutex,
    },
};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::state::AppState;
use crate::window_state::StartupMode;

const COMPANION_STATE: &str = "aics:desktop-companion";
const AUTOSTART_STATE: &str = "aics:desktop-autostart";
const DEFAULT_KEYS: [&str; 4] = [
    "Ctrl+Shift+P",
    "Ctrl+Shift+Space",
    "Ctrl+Shift+A",
    "Ctrl+Shift+X",
];

#[derive(Clone, Copy, Default, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CloseBehavior {
    #[default]
    Tray,
    Quit,
}

#[derive(Clone, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShortcutBinding {
    enabled: bool,
    accelerator: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct ShellPreferences {
    close_behavior: CloseBehavior,
    shortcuts: [ShortcutBinding; 4],
}

impl Default for ShellPreferences {
    fn default() -> Self {
        Self {
            close_behavior: CloseBehavior::Tray,
            shortcuts: DEFAULT_KEYS.map(|key| ShortcutBinding {
                enabled: true,
                accelerator: key.into(),
            }),
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutConflict {
    index: usize,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreferenceResult {
    preferences: ShellPreferences,
    conflicts: Vec<ShortcutConflict>,
    saved: bool,
}

#[derive(Clone, Default)]
struct Bindings {
    initialized: bool,
    preferences: ShellPreferences,
    registered: HashMap<u32, Shortcut>,
    actions: HashMap<u32, usize>,
    conflicts: Vec<ShortcutConflict>,
}

pub struct ShellState {
    file: PathBuf,
    updating: Mutex<()>,
    bindings: Mutex<Bindings>,
    last_window: AtomicU8,
    menu_actions: AtomicU8,
    notifications: taskbar::Notifications,
}

fn authorize(window: &WebviewWindow) -> Result<(), String> {
    let app = window.app_handle();
    if window.label() != "atelier"
        || crate::maintenance::active(app)
        || !window
            .url()
            .ok()
            .is_some_and(|url| crate::main_shared::is_gateway_origin(app, &url))
    {
        return Err("桌面操作只允许在已登记的主画室窗口中执行。".into());
    }
    Ok(())
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.recover_lock()
}

fn conflict(index: usize, message: impl Into<String>) -> ShortcutConflict {
    ShortcutConflict {
        index,
        message: message.into(),
    }
}

fn parsed_shortcuts(
    preferences: &ShellPreferences,
) -> (Vec<(usize, Shortcut)>, Vec<ShortcutConflict>) {
    let mut wanted = Vec::with_capacity(4);
    let mut conflicts = Vec::new();
    for (index, binding) in preferences.shortcuts.iter().enumerate() {
        let key = binding.accelerator.as_str();
        let parsed = if key.len() <= 48
            && key
                .split('+')
                .any(|part| matches!(part, "Ctrl" | "Alt" | "Super"))
        {
            key.parse::<Shortcut>().ok()
        } else {
            None
        };
        let Some(shortcut) = parsed else {
            conflicts.push(conflict(
                index,
                "请选择包含 Ctrl、Alt 或 Windows 键的有效组合键。",
            ));
            continue;
        };
        if !binding.enabled {
            continue;
        }
        if wanted
            .iter()
            .any(|&(_, prior): &(usize, Shortcut)| prior.id() == shortcut.id())
        {
            conflicts.push(conflict(
                index,
                format!("{} 已分配给绘遇的另一项操作。", key),
            ));
        } else {
            wanted.push((index, shortcut));
        }
    }
    (wanted, conflicts)
}

fn on_shortcut(
    app: &AppHandle,
    shortcut: &Shortcut,
    event: tauri_plugin_global_shortcut::ShortcutEvent,
) {
    if event.state() != ShortcutState::Pressed || crate::maintenance::active(app) {
        return;
    }
    let Some(shell) = app.try_state::<ShellState>() else {
        return;
    };
    let action = shell
        .bindings
        .try_lock()
        .ok()
        .and_then(|state| state.actions.get(&shortcut.id()).copied());
    match action {
        Some(0) => {
            let state = app.state::<AppState>();
            crate::bridge::set_ignore_mouse_events(
                app,
                !state.ignore_mouse_events.load(Ordering::Relaxed),
            );
        }
        Some(1) => toggle_companion(app),
        Some(2) => focus_atelier(app),
        Some(3) => {
            let url = gateway_url(app);
            crate::main_shared::toggle_companion_chat(app, &url);
        }
        _ => {}
    }
}

fn rollback_registrations(app: &AppHandle, bindings: &mut Bindings, added: &[(usize, Shortcut)]) {
    for &(_, shortcut) in added {
        if app.global_shortcut().unregister(shortcut).is_ok() {
            bindings.registered.remove(&shortcut.id());
        }
    }
}

fn configure(
    app: &AppHandle,
    shell: &ShellState,
    preferences: ShellPreferences,
    startup: bool,
) -> Result<PreferenceResult, String> {
    if crate::ui_entry::isolated_profile().is_some() && !startup {
        return Err("隔离配置不注册系统快捷键。".into());
    }
    let _updating = lock(&shell.updating);
    let mut bindings = lock(&shell.bindings).clone();
    if startup && bindings.initialized {
        return Ok(PreferenceResult {
            preferences: bindings.preferences,
            conflicts: bindings.conflicts,
            saved: true,
        });
    }
    let (wanted, mut conflicts) = parsed_shortcuts(&preferences);
    let mut added = Vec::new();
    let mut actions = HashMap::new();
    let mut rejected = !conflicts.is_empty();
    if startup || conflicts.is_empty() {
        for (index, shortcut) in wanted {
            if !bindings.registered.contains_key(&shortcut.id()) {
                if app
                    .global_shortcut()
                    .on_shortcut(shortcut, on_shortcut)
                    .is_err()
                {
                    conflicts.push(conflict(
                        index,
                        format!(
                            "{} 已被其他应用或 Windows 占用。",
                            preferences.shortcuts[index].accelerator
                        ),
                    ));
                    rejected |=
                        bindings.preferences.shortcuts[index] != preferences.shortcuts[index];
                    continue;
                }
                added.push((index, shortcut));
                bindings.registered.insert(shortcut.id(), shortcut);
            }
            actions.insert(shortcut.id(), index);
        }
    }
    if !startup && rejected {
        rollback_registrations(app, &mut bindings, &added);
        let preferences = bindings.preferences.clone();
        *lock(&shell.bindings) = bindings;
        return Ok(PreferenceResult {
            preferences,
            conflicts,
            saved: false,
        });
    }
    if !startup {
        if let Err(error) = crate::maintenance_protocol::write_json(&shell.file, &preferences) {
            rollback_registrations(app, &mut bindings, &added);
            *lock(&shell.bindings) = bindings;
            app.state::<AppState>()
                .warn(&format!("Desktop preference persistence failed: {error}"));
            return Err("桌面偏好未保存，请重试。".into());
        }
    }
    bindings.registered.retain(|key, shortcut| {
        actions.contains_key(key) || app.global_shortcut().unregister(*shortcut).is_err()
    });
    bindings.actions = actions;
    bindings.preferences = preferences;
    bindings.conflicts = conflicts.clone();
    bindings.initialized = true;
    let preferences = bindings.preferences.clone();
    *lock(&shell.bindings) = bindings;
    Ok(PreferenceResult {
        preferences,
        conflicts,
        saved: true,
    })
}

pub fn initialize(app: &AppHandle) {
    let file = app
        .state::<AppState>()
        .paths
        .config_root
        .join("desktop-shell.json");
    let preferences = std::fs::read(&file)
        .ok()
        .filter(|bytes| bytes.len() <= 16_384)
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    app.manage(ShellState {
        file,
        updating: Mutex::new(()),
        bindings: Mutex::new(Bindings {
            preferences,
            ..Bindings::default()
        }),
        last_window: AtomicU8::new(0),
        menu_actions: AtomicU8::new(0),
        notifications: taskbar::Notifications::default(),
    });
    if crate::ui_entry::isolated_profile().is_some() {
        return;
    }
    taskbar::initialize(app);
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let shell = app.state::<ShellState>();
        let preferences = lock(&shell.bindings).preferences.clone();
        let _ = configure(&app, &shell, preferences, true);
    });
}

#[tauri::command]
pub fn desktop_shell_preferences(
    window: WebviewWindow,
    shell: State<ShellState>,
) -> Result<PreferenceResult, String> {
    authorize(&window)?;
    let bindings = lock(&shell.bindings);
    Ok(PreferenceResult {
        preferences: bindings.preferences.clone(),
        conflicts: bindings.conflicts.clone(),
        saved: true,
    })
}

#[tauri::command]
pub async fn desktop_shell_set_preferences(
    window: WebviewWindow,
    preferences: ShellPreferences,
) -> Result<PreferenceResult, String> {
    authorize(&window)?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        configure(&app, &app.state::<ShellState>(), preferences, false)
    })
    .await
    .map_err(|_| "桌面偏好暂时不可用。".to_string())?
}

pub fn close_atelier(app: &AppHandle) {
    let quit = app.try_state::<ShellState>().is_some_and(|shell| {
        matches!(
            lock(&shell.bindings).preferences.close_behavior,
            CloseBehavior::Quit
        )
    });
    if quit {
        crate::maintenance::request_atelier_quit(app);
    } else if let Some(window) = app.get_webview_window("atelier") {
        if window.hide().is_ok() {
            let _ = window.emit("aics:atelier-visibility", false);
        }
    }
}

pub fn remember_focus(app: &AppHandle, label: &str) {
    let value = match label {
        "atelier" => 1,
        "companion" => 2,
        "companion-chat" => 3,
        _ => return,
    };
    if let Some(shell) = app.try_state::<ShellState>() {
        shell.last_window.store(value, Ordering::Relaxed);
    }
    if value == 1 {
        let _ = app.emit_to("atelier", "aics:atelier-visibility", true);
    }
}

fn gateway_url(app: &AppHandle) -> String {
    lock(&app.state::<AppState>().gateway_url).clone()
}

pub fn focus_atelier(app: &AppHandle) {
    if crate::maintenance::active(app) {
        return;
    }
    if let Some(window) = app.get_webview_window("atelier") {
        let _ = window.unminimize();
        if window.show().is_ok() {
            let _ = window.emit("aics:atelier-visibility", true);
        }
        let _ = window.set_focus();
    } else {
        crate::main_shared::open_atelier(app, &gateway_url(app), None);
    }
}

pub fn tray_click(app: &AppHandle) {
    if crate::maintenance::active(app) {
        return;
    }
    let mode = lock(&app.state::<AppState>().preferences).startup_mode;
    let last = app
        .try_state::<ShellState>()
        .map_or(0, |shell| shell.last_window.load(Ordering::Relaxed));
    match (mode, last) {
        (StartupMode::Atelier, _)
        | (StartupMode::Tray | StartupMode::Both, 1)
        | (StartupMode::Tray, 0) => focus_atelier(app),
        (StartupMode::Both | StartupMode::Tray, 3) => {
            crate::main_shared::open_companion_chat(app, &gateway_url(app))
        }
        _ => crate::main_shared::show_companion(app, true),
    }
}

fn companion_visible(app: &AppHandle) -> bool {
    lock(&app.state::<AppState>().companion_presentation).preparing()
        || app
            .get_webview_window("companion")
            .is_some_and(|window| window.is_visible().unwrap_or(false))
}

pub fn publish_companion(app: &AppHandle) {
    let _ = app.emit_to("atelier", COMPANION_STATE, companion_visible(app));
}

pub fn toggle_companion(app: &AppHandle) {
    crate::main_shared::toggle_companion_visibility(app);
}

#[tauri::command]
pub fn desktop_shell_companion_state(window: WebviewWindow) -> Result<bool, String> {
    authorize(&window)?;
    Ok(companion_visible(window.app_handle()))
}

#[tauri::command]
pub fn desktop_shell_toggle_companion(window: WebviewWindow) -> Result<(), String> {
    authorize(&window)?;
    toggle_companion(window.app_handle());
    Ok(())
}

fn autostart(app: &AppHandle) -> Result<bool, String> {
    if crate::ui_entry::isolated_profile().is_some() {
        return Err("隔离配置不访问系统启动项。".into());
    }
    app.autolaunch()
        .is_enabled()
        .map_err(|_| "无法读取 Windows 开机启动状态。".into())
}

pub fn set_autostart(app: &AppHandle, enabled: bool) -> Result<bool, String> {
    if autostart(app)? != enabled {
        let result = if enabled {
            app.autolaunch().enable()
        } else {
            app.autolaunch().disable()
        };
        result.map_err(|_| "无法更改 Windows 开机启动。".to_string())?;
    }
    let current = autostart(app)?;
    crate::tray::refresh_tray_menu(app);
    let _ = app.emit_to("atelier", AUTOSTART_STATE, current);
    Ok(current)
}

pub fn toggle_autostart(app: &AppHandle) {
    if let Err(error) = autostart(app).and_then(|current| set_autostart(app, !current)) {
        app.state::<AppState>().warn(&error);
    }
}

#[tauri::command]
pub fn desktop_shell_autostart(window: WebviewWindow) -> Result<bool, String> {
    authorize(&window)?;
    autostart(window.app_handle())
}

#[tauri::command]
pub fn desktop_shell_set_autostart(window: WebviewWindow, enabled: bool) -> Result<bool, String> {
    authorize(&window)?;
    set_autostart(window.app_handle(), enabled)
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MenuAction {
    CheckUpdates,
    ExportDiagnostics,
}

impl MenuAction {
    fn event(self) -> &'static str {
        match self {
            Self::CheckUpdates => "desktop-check-updates",
            Self::ExportDiagnostics => "desktop-export-diagnostics",
        }
    }

    fn mask(self) -> u8 {
        match self {
            Self::CheckUpdates => 1,
            Self::ExportDiagnostics => 2,
        }
    }
}

pub fn tray_action(app: &AppHandle, action: MenuAction) {
    if let Some(shell) = app.try_state::<ShellState>() {
        shell.menu_actions.fetch_or(action.mask(), Ordering::AcqRel);
        focus_atelier(app);
        let _ = app.emit_to("atelier", action.event(), ());
    }
}

#[tauri::command]
pub fn desktop_shell_take_action(
    window: WebviewWindow,
    action: MenuAction,
    shell: State<ShellState>,
) -> Result<bool, String> {
    authorize(&window)?;
    Ok(shell
        .menu_actions
        .fetch_and(!action.mask(), Ordering::AcqRel)
        & action.mask()
        != 0)
}
