use crate::mutex::RecoverMutex;
use tauri::menu::{CheckMenuItem, Menu, MenuBuilder, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_opener::OpenerExt;

use crate::state::AppState;

const MENU_SHOW_COMPANION: &str = "show_companion";
const MENU_OPEN_CHAT: &str = "open_chat";
const MENU_OPEN_ATELIER: &str = "open_atelier";
const MENU_COMPANION_SETTINGS: &str = "companion_settings";
const MENU_TOGGLE_ALWAYS_ON_TOP: &str = "toggle_always_on_top";
const MENU_TOGGLE_PASSTHROUGH: &str = "toggle_passthrough";
const MENU_TOGGLE_AUTOSTART: &str = "toggle_autostart";
const MENU_OPEN_WORKSPACE: &str = "open_workspace";
const MENU_OPEN_RUNTIME: &str = "open_runtime";
const MENU_OPEN_LOG: &str = "open_log";
const MENU_CHECK_UPDATES: &str = "check_updates";
const MENU_EXPORT_DIAGNOSTICS: &str = "export_diagnostics";
const MENU_QUIT: &str = "quit";

const TRAY_ICON_PNG: &[u8] = include_bytes!("../icons/icon-32.png");

pub fn create_tray(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let image = image::load_from_memory(TRAY_ICON_PNG).expect("tray icon must decode");
    let rgba = image.to_rgba8();
    let icon = tauri::image::Image::new(rgba.as_raw().as_slice(), rgba.width(), rgba.height());
    let tray = TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("绘遇 · 桌面陪伴")
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: tauri::tray::MouseButtonState::Up, .. } = event {
                crate::desktop_shell::tray_click(tray.app_handle());
            }
        })
        .menu(&build_menu(app)?)
        .on_menu_event(|app, event| {
            if crate::maintenance::active(app)
                && !(event.id().as_ref() == MENU_QUIT && crate::maintenance::admits(app, "quit")) { return; }
            let state = app.state::<AppState>();
            match event.id().as_ref() {
                MENU_SHOW_COMPANION => {
                    crate::main_shared::toggle_companion_visibility(app);
                }
                MENU_OPEN_CHAT => {
                    let url = state.gateway_url();
                    crate::main_shared::open_companion_chat(app, &url);
                }
                MENU_OPEN_ATELIER => {
                    crate::desktop_shell::focus_atelier(app);
                }
                MENU_COMPANION_SETTINGS => {
                    crate::companion_window::show(app, true, true);
                    crate::desktop_shell::publish_companion(app);
                }
                MENU_TOGGLE_ALWAYS_ON_TOP => {
                    crate::bridge::toggle_always_on_top(app.clone(), state);
                }
                MENU_TOGGLE_PASSTHROUGH => {
                    let next = !state.ignore_mouse_events.load(std::sync::atomic::Ordering::Relaxed);
                    crate::bridge::set_ignore_mouse_events(app, next);
                }
                MENU_TOGGLE_AUTOSTART => crate::desktop_shell::toggle_autostart(app),
                MENU_OPEN_WORKSPACE => {
                    let root = state.workspace_root.recover_lock().clone();
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
                    state.log.flush();
                    let log = state.paths.desktop_log.to_string_lossy().to_string();
                    let _ = app.opener().open_path(log, None::<&str>);
                }
                MENU_CHECK_UPDATES => crate::desktop_shell::tray_action(app, crate::desktop_shell::MenuAction::CheckUpdates),
                MENU_EXPORT_DIAGNOSTICS => crate::desktop_shell::tray_action(app, crate::desktop_shell::MenuAction::ExportDiagnostics),
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
    let state = app.state::<AppState>();
    let always_on_top = state.preferences.recover_lock().always_on_top;
    let companion_open = state.companion_presentation.recover_lock().preparing()
        || app.get_webview_window("companion").is_some_and(|w| w.is_visible().unwrap_or(false));
    let passthrough = state.ignore_mouse_events.load(std::sync::atomic::Ordering::Relaxed);
    let autostart = app.autolaunch().is_enabled().unwrap_or(false);

    let show_companion = MenuItem::with_id(app, MENU_SHOW_COMPANION, if companion_open { "隐藏桌面角色" } else { "显示桌面角色" }, true, None::<&str>)?;
    let open_chat = MenuItem::with_id(app, MENU_OPEN_CHAT, "打开聊天", true, None::<&str>)?;
    let open_atelier = MenuItem::with_id(app, MENU_OPEN_ATELIER, "打开绘图画室", true, None::<&str>)?;
    let companion_settings = MenuItem::with_id(app, MENU_COMPANION_SETTINGS, "切换桌面角色与设置", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let toggle_top = MenuItem::with_id(
        app,
        MENU_TOGGLE_ALWAYS_ON_TOP,
        if always_on_top { "取消置顶桌面角色" } else { "置顶桌面角色" },
        true,
        None::<&str>,
    )?;
    let toggle_passthrough = CheckMenuItem::with_id(
        app,
        MENU_TOGGLE_PASSTHROUGH,
        "锁定整身鼠标穿透（空白自动穿透）",
        true,
        passthrough,
        None::<&str>,
    )?;
    let toggle_autostart = CheckMenuItem::with_id(app, MENU_TOGGLE_AUTOSTART, "开机启动", true, autostart, None::<&str>)?;
    let open_workspace = MenuItem::with_id(app, MENU_OPEN_WORKSPACE, "打开 AI 工作区", true, None::<&str>)?;
    let open_runtime = MenuItem::with_id(app, MENU_OPEN_RUNTIME, "打开运行时目录", true, None::<&str>)?;
    let open_log = MenuItem::with_id(app, MENU_OPEN_LOG, "查看日志文件", true, None::<&str>)?;
    let check_updates = MenuItem::with_id(app, MENU_CHECK_UPDATES, "检查更新", true, None::<&str>)?;
    let export_diagnostics = MenuItem::with_id(app, MENU_EXPORT_DIAGNOSTICS, "导出诊断包", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "退出绘遇", true, None::<&str>)?;

    MenuBuilder::new(app)
        .item(&show_companion)
        .item(&open_chat)
        .item(&open_atelier)
        .item(&companion_settings)
        .item(&separator)
        .item(&toggle_top)
        .item(&toggle_passthrough)
        .item(&toggle_autostart)
        .item(&open_workspace)
        .item(&open_runtime)
        .item(&open_log)
        .item(&separator)
        .item(&check_updates)
        .item(&export_diagnostics)
        .item(&quit)
        .build()
}
