use tauri::menu::{CheckMenuItem, Menu, MenuBuilder, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

const MENU_SHOW_COMPANION: &str = "show_companion";
const MENU_OPEN_CHAT: &str = "open_chat";
const MENU_OPEN_ATELIER: &str = "open_atelier";
const MENU_TOGGLE_ALWAYS_ON_TOP: &str = "toggle_always_on_top";
const MENU_TOGGLE_PASSTHROUGH: &str = "toggle_passthrough";
const MENU_TOGGLE_AUTOSTART: &str = "toggle_autostart";
const MENU_OPEN_WORKSPACE: &str = "open_workspace";
const MENU_OPEN_RUNTIME: &str = "open_runtime";
const MENU_OPEN_LOG: &str = "open_log";
const MENU_QUIT: &str = "quit";

const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/icon-32.png");

pub fn create_tray(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let image = image::load_from_memory(TRAY_ICON_PNG).expect("tray icon must decode");
    let rgba = image.to_rgba8();
    let icon = tauri::image::Image::new(rgba.as_raw().as_slice(), rgba.width(), rgba.height());
    let tray = TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("绘遇 Companion")
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                let _ = tray.app_handle().emit("aics:tray-left-click", ());
            }
        })
        .menu(&build_menu(app)?)
        .on_menu_event(|app, event| {
            if crate::maintenance::active(app)
                && !(event.id().as_ref() == MENU_QUIT && crate::maintenance::admits(app, "quit")) { return; }
            let state = app.state::<AppState>();
            match event.id().as_ref() {
                MENU_SHOW_COMPANION => {
                    let _ = app.emit("aics:show-companion", ());
                }
                MENU_OPEN_CHAT => {
                    let _ = app.emit("aics:open-chat", ());
                }
                MENU_OPEN_ATELIER => {
                    let _ = app.emit("aics:open-atelier", ());
                }
                MENU_TOGGLE_ALWAYS_ON_TOP => {
                    if let Some(w) = app.get_webview_window("companion") {
                        let next = !w.is_always_on_top().unwrap_or(false);
                        let _ = w.set_always_on_top(next);
                        state.preferences.lock().unwrap().always_on_top = next;
                        state.save_preferences();
                        refresh_tray_menu(app);
                    }
                }
                MENU_TOGGLE_PASSTHROUGH => {
                    let next = !state.ignore_mouse_events.load(std::sync::atomic::Ordering::Relaxed);
                    crate::bridge::set_ignore_mouse_events(app, next);
                    refresh_tray_menu(app);
                }
                MENU_TOGGLE_AUTOSTART => {
                    let currently = app.autolaunch().is_enabled().unwrap_or(false);
                    let _ = if currently {
                        app.autolaunch().disable()
                    } else {
                        app.autolaunch().enable()
                    };
                    refresh_tray_menu(app);
                }
                MENU_OPEN_WORKSPACE => {
                    let root = state.workspace_root.lock().unwrap().clone();
                    let root = if root.is_empty() {
                        state.paths.config_root.parent().unwrap_or(&state.paths.config_root).join("AI").to_string_lossy().to_string()
                    } else {
                        root
                    };
                    let _ = app.opener().open_path(root, None::<&str>);
                }
                MENU_OPEN_RUNTIME => {
                    let _ = app.opener().open_path(state.paths.config_root.to_string_lossy().to_string(), None::<&str>);
                }
                MENU_OPEN_LOG => {
                    let log = state.paths.desktop_log.to_string_lossy().to_string();
                    let _ = app.opener().open_path(log, None::<&str>);
                }
                MENU_QUIT => {
                    state.quitting.store(true, std::sync::atomic::Ordering::Relaxed);
                    state.log("info", "quit from tray");
                    app.exit(0);
                }
                _ => {}
            }
        })
        .build(app)?;
    Ok(tray)
}

pub fn refresh_tray_menu(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id("main") {
        if let Ok(menu) = build_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let always_on_top = app
        .get_webview_window("companion")
        .map(|w| w.is_always_on_top().unwrap_or(false))
        .unwrap_or(false);
    let state = app.state::<AppState>();
    let passthrough = state.ignore_mouse_events.load(std::sync::atomic::Ordering::Relaxed);
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);

    let show_companion = MenuItem::with_id(app, MENU_SHOW_COMPANION, "显示 Companion", true, None::<&str>)?;
    let open_chat = MenuItem::with_id(app, MENU_OPEN_CHAT, "打开聊天", true, None::<&str>)?;
    let open_atelier = MenuItem::with_id(app, MENU_OPEN_ATELIER, "打开 Atelier 工作台", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let toggle_top = MenuItem::with_id(
        app,
        MENU_TOGGLE_ALWAYS_ON_TOP,
        if always_on_top { "取消置顶 Companion" } else { "置顶 Companion" },
        true,
        None::<&str>,
    )?;
    let toggle_passthrough = MenuItem::with_id(
        app,
        MENU_TOGGLE_PASSTHROUGH,
        if passthrough { "关闭鼠标穿透" } else { "开启鼠标穿透" },
        true,
        None::<&str>,
    )?;
    let toggle_autostart = CheckMenuItem::with_id(app, MENU_TOGGLE_AUTOSTART, "开机启动", true, autostart, None::<&str>)?;
    let open_workspace = MenuItem::with_id(app, MENU_OPEN_WORKSPACE, "打开 AI 工作区", true, None::<&str>)?;
    let open_runtime = MenuItem::with_id(app, MENU_OPEN_RUNTIME, "打开运行时目录", true, None::<&str>)?;
    let open_log = MenuItem::with_id(app, MENU_OPEN_LOG, "查看日志文件", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "退出 Companion", true, None::<&str>)?;

    MenuBuilder::new(app)
        .item(&show_companion)
        .item(&open_chat)
        .item(&open_atelier)
        .item(&separator)
        .item(&toggle_top)
        .item(&toggle_passthrough)
        .item(&toggle_autostart)
        .item(&open_workspace)
        .item(&open_runtime)
        .item(&open_log)
        .item(&separator)
        .item(&quit)
        .build()
}
