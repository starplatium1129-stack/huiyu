#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod companion_window;
mod save_image;
mod portable_backup;
mod bootstrap;
mod ui_entry;
mod credentials;
mod gateway;
mod gateway_monitor;
mod diagnostics;
mod mutex;
mod live2d_overlay;
mod live2d_renderer;
mod live2d_process_protocol;
mod live2d_renderer_child;
mod live2d_process;
mod live2d_process_probe;
mod logger;
mod main_shared;
mod paths;
mod state;
mod tray;
mod updater_cmd;
mod watchers;
mod window_state;
mod window_presentation;
mod window_persistence;
#[cfg(windows)]
mod window_icon;
mod chat_dock;
mod live2d_framing;
mod maintenance;
mod maintenance_protocol;
mod resource_assistant;
mod desktop_shell;
mod desktop_shutdown;
mod webview_memory;

use crate::mutex::RecoverMutex;
use std::sync::atomic::Ordering;

use tauri::{Emitter, Manager};

use crate::state::AppState;

fn main() {
    // R12 compares the same renderer in a child process. Dispatch before Tauri
    // plugins so a renderer never owns user storage, the gateway or a tray.
    let child_mode = std::env::args().any(|arg| arg == "--live2d-renderer-child");
    let probe_mode = std::env::args().any(|arg| arg == "--live2d-renderer-probe-host");
    if (child_mode && !live2d_process::child_allowed()) || (probe_mode && !live2d_process::enabled()) {
        eprintln!("Live2D child session is not enabled");
        std::process::exit(2);
    }
    // 进程最早期 DPI awareness：必须在任何窗口创建之前设置，否则 Win32 会
    // 按系统 DPI 缩放窗口坐标。overlay 线程内的设置只覆盖自身创建时机，而
    // Companion WebView 窗口在此前已由 wry 创建；进程级 per-monitor v2 让
    // 所有窗口（含 overlay）统一使用物理像素坐标，避免 125/150% DPI 错位。
    // Tauri/wry 若已设置则幂等；失败静默（overlay 线程仍有回退逻辑）。
    unsafe {
        use windows_sys::Win32::UI::HiDpi::{
            SetProcessDpiAwareness, SetProcessDpiAwarenessContext,
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, PROCESS_PER_MONITOR_DPI_AWARE,
        };
        if SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) == 0 {
            let _ = SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE);
        }
    }
    if child_mode || probe_mode {
        let result = if child_mode { live2d_renderer_child::run() } else { live2d_process_probe::run() };
        if let Err(error) = result { eprintln!("Live2D process: {error}"); std::process::exit(1); }
        return;
    }
    let mut context = tauri::generate_context!();
    let maintenance_namespace = maintenance::namespace().unwrap_or_else(|error| { eprintln!("{error}"); std::process::exit(2); });
    let maintenance_single_instance = ui_entry::isolated_profile().is_none() || maintenance_namespace.is_some();
    if let Some(namespace) = maintenance_namespace { context.config_mut().identifier = namespace; }
    let app = tauri::Builder::default()
        .plugin(if !maintenance_single_instance {
            tauri::plugin::Builder::new("isolated-instance").build()
        } else { tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if maintenance::handle(app, &argv) || maintenance::active(app) { return; }
            let Some(state) = app.try_state::<AppState>() else { return; };
            if state.quitting.load(Ordering::Acquire) { return; }
            if argv.iter().any(|arg| arg == "--resource-assistant") { resource_assistant::open_in_background(app); return; }
            for arg in argv {
                if arg.starts_with("aics://") {
                    let target = arg.trim_start_matches("aics://").trim_start_matches('/').to_string();
                    let path = main_shared::normalize_atelier_path(Some(&format!("/{target}")));
                    state.info("Opening atelier from a desktop deep link");
                    let url = state.gateway_url();
                    main_shared::open_atelier(app, &url, Some(&path));
                    return;
                }
            }
            main_shared::show_companion(app, true);
        }) })
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--hidden"]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler({
            let handler: fn(tauri::ipc::Invoke) -> bool = tauri::generate_handler![
            bridge::desktop_bootstrap,
            maintenance::desktop_maintenance_ack,
            resource_assistant::open_resource_assistant,
            resource_assistant::resource_assistant_status,
            resource_assistant::resource_assistant_pick,
            resource_assistant::resource_assistant_install,
            resource_assistant::resource_assistant_cancel,
            resource_assistant::resource_assistant_finish,
            bridge::desktop_workspace_prepare,
            bridge::desktop_workspace_activate,
            bridge::desktop_workspace_enable_bundled,
            credentials::chat_credential_read,
            credentials::chat_credential_write,
            bridge::get_state,
            bridge::get_startup_mode,
            bridge::set_startup_mode,
            desktop_shell::desktop_shell_preferences,
            desktop_shell::desktop_shell_set_preferences,
            desktop_shell::desktop_shell_autostart,
            desktop_shell::desktop_shell_set_autostart,
            desktop_shell::desktop_shell_companion_state,
            desktop_shell::desktop_shell_toggle_companion,
            desktop_shell::desktop_shell_take_action,
            desktop_shell::taskbar::desktop_shell_task_progress,
            desktop_shell::taskbar::desktop_shell_notify_task,
            bridge::companion_mark_ready,
            companion_window::start_companion_move,
            bridge::companion_set_interactive_regions,
            bridge::companion_set_static_mask,
            bridge::hide,
            bridge::set_ignore_mouse_events_cmd,
            bridge::toggle_always_on_top,
            bridge::set_live2d_enabled,
            bridge::is_packaged,
            bridge::get_workspace,
            bridge::set_workspace,
            bridge::restart_for_setup,
            bridge::pick_workspace,
            bridge::notify,
            bridge::open_atelier,
            bridge::open_companion_chat,
            bridge::hide_companion_chat,
            chat_dock::set_chat_docked,
            chat_dock::get_chat_docked,
            chat_dock::resize_companion_dialogue,
            bridge::chat_relay,
            bridge::window_minimize,
            bridge::window_maximize_toggle,
            bridge::window_close,
            bridge::get_window_state,
            window_presentation::window_zoom_get,
            window_presentation::window_zoom_set,
            bridge::open_workspace,
            save_image::save_image,
            portable_backup::workspace_portable_backup,
            updater_cmd::desktop_update_check,
            updater_cmd::desktop_update_state,
            updater_cmd::desktop_update_install,
            updater_cmd::desktop_update_cancel,
            updater_cmd::desktop_update_reminder,
            updater_cmd::desktop_update_release_page,
            gateway_monitor::desktop_gateway_recovery,
            gateway_monitor::desktop_gateway_retry,
            diagnostics::desktop_export_diagnostics,
            live2d_process::desktop_live2d_isolation,
            live2d_process::desktop_set_live2d_isolation,
            watchers::desktop_get_clipboard_awareness,
            watchers::desktop_set_clipboard_awareness,
            live2d_overlay::aics_live2d_set_character,
            live2d_framing::aics_live2d_set_frame,
            live2d_overlay::aics_live2d_play_motion,
            live2d_overlay::aics_live2d_set_expression,
             live2d_overlay::aics_live2d_set_mouth_level,
             live2d_overlay::aics_live2d_set_max_fps,
             live2d_overlay::aics_live2d_set_emotion,
            live2d_overlay::aics_live2d_set_gaze,
            live2d_overlay::aics_live2d_hit_test,
            live2d_overlay::aics_live2d_destroy,
            ];
            move |invoke: tauri::ipc::Invoke| {
                let view = invoke.message.webview();
                let assistant = resource_assistant::trusted(&view) && resource_assistant::command(invoke.message.command());
                let trusted = matches!(view.label(), "atelier" | "companion" | "companion-chat")
                    && view.url().map(|url| main_shared::is_gateway_origin(view.app_handle(), &url)).unwrap_or(false);
                if !trusted && !assistant {
                    invoke.resolver.reject("IPC requires the current authenticated gateway origin");
                    return true;
                }
                if !assistant && !maintenance::admits(view.app_handle(), invoke.message.command()) {
                    invoke.resolver.reject("DESKTOP_MAINTENANCE: new host operations are frozen");
                    return true;
                }
                handler(invoke)
            }
        })
        .setup(|app| {
            // No existing single-instance host consumed this request. Do not
            // launch a gateway, open user data, or create windows as a fallback.
            if maintenance::is_client() { std::process::exit(3); }
            let paths = paths::resolve_paths(app.handle());
            let host = maintenance::MaintenanceHost::new(paths.config_root.clone(), app.config().identifier.clone(), ui_entry::isolated_profile().is_none()).map_err(std::io::Error::other)?;
            let state = AppState::new(paths);
            app.manage(state);
            app.manage(window_persistence::WindowStateWriter::new());
            let state = app.state::<AppState>();
            live2d_process::initialize(crate::mutex::RecoverMutex::recover_lock(&state.preferences).isolated_live2d_renderer);
            app.manage(host);
            app.manage(resource_assistant::ResourceAssistant::default());
            if (std::env::args().any(|arg| arg == "--resource-assistant") && !state.paths.config_root.join("resource-restart.json").exists()) || resource_assistant::recovery_pending(app.handle()) { resource_assistant::open(app.handle()).map_err(std::io::Error::other)?; }

            state.info("Companion starting (tauri shell)");

            // GitHub Releases 更新检查不依赖本地网关；失败静默，不影响离线启动。
            if ui_entry::isolated_profile().is_none() { updater_cmd::spawn_startup_check(app.handle().clone()); }

            // 深链注册（dev 模式插件不会自动写注册表，需显式注册）
            {
                use tauri_plugin_deep_link::{DeepLinkExt, OpenUrlEvent};
                if ui_entry::isolated_profile().is_none() { let _ = app.deep_link().register("aics"); }
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event: OpenUrlEvent| {
                    let state = handle.state::<AppState>();
                    for url in event.urls() {
                        if maintenance::active(&handle) || state.quitting.load(Ordering::Acquire) { return; }
                        let url = url.to_string();
                        let target = url
                            .trim_start_matches("aics://")
                            .trim_start_matches('/')
                            .trim_end_matches('/')
                            .to_string();
                        let path = main_shared::normalize_atelier_path(Some(&format!("/{target}")));
                        state.info("Opening atelier from a desktop deep link");
                        let gateway = state.gateway_url();
                        main_shared::open_atelier(&handle, &gateway, Some(&path));
                    }
                });
            }

            // 数据迁移（Electron → Tauri，幂等）
            let migrated = if ui_entry::isolated_profile().is_none() {
                paths::migrate_electron_data(&state.paths.config_root, &state.paths.runtime_root)
            } else { Vec::new() };
            if !migrated.is_empty() {
                state.info(&format!("migrated electron data: {}", migrated.join(", ")));
            }

            // 工作区回填：迁移后重新读取
            if state.workspace_root.recover_lock().is_empty() {
                let loaded = window_state::load_ai_workspace(&state.paths.ai_workspace_file);
                if !loaded.is_empty() {
                    *state.workspace_root.recover_lock() = loaded;
                }
            }

            let is_packaged = state.paths.is_packaged;
            let configured_port = std::env::var("PORT")
                .ok()
                .and_then(|v| v.parse::<u16>().ok())
                .filter(|p| (1024..=65_535).contains(p))
                .unwrap_or_else(|| window_state::load_desktop_gateway_port(&state.paths.gateway_port_file, 3000));

            let gateway_log = state.log.clone();
            state.info(&format!(
                "gateway paths: packaged={is_packaged} executable={} cwd={}",
                state.paths.gateway_executable.display(),
                state.paths.gateway_cwd.display()
            ));
            let supervisor = gateway::GatewaySupervisor::new(
                state.paths.gateway_executable.clone(),
                state.paths.gateway_cwd.clone(),
                configured_port,
                {
                    let mut env = main_shared::gateway_env(&state.paths, is_packaged, Some(&state.workspace_root.recover_lock()));
                    // Retain the exact workspace passed to this gateway, including the default/env fallback.
                    if let Some((_, root)) = env.iter().find(|(key, _)| key == "AI_WORKSPACE_ROOT") {
                        *state.workspace_root.recover_lock() = root.clone();
                    }
                    if ui_entry::bundled(app.handle()) { env.push(("AICS_DESKTOP_BUNDLED_UI".into(), "1".into())); }
                    env
                },
                move |stream, text| {
                    gateway_log.debug(&format!("[gateway:{stream}] {}", text.trim()));
                },
            );
            app.manage(supervisor);

            use window_state::StartupMode;
            if matches!(main_shared::normal_startup_mode(app.handle()), Some(StartupMode::Companion | StartupMode::Both))
                && state.preferences.recover_lock().live2d_enabled != Some(false)
            {
                live2d_overlay::prewarm(app.handle());
            }

            // 网关启动（与窗口并行）
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let s = handle.state::<AppState>();
                let supervisor = handle.state::<gateway::GatewaySupervisor>();
                match supervisor.start().await {
                    Ok(url) => {
                        if let Err(error) = main_shared::authorize_gateway_origin(&handle, &url) {
                            s.error(&format!("gateway capability rejected: {error}"));
                            s.gateway_recovery.publish(&handle, gateway_monitor::Phase::Reconnecting, "authorization");
                            return;
                        }
                        window_state::save_desktop_gateway_port(&s.paths.gateway_port_file, supervisor.port());
                        s.info(&format!("Gateway {} at {url}", if supervisor.owns_gateway() { "started" } else { "attached" }));
                        let _ = handle.emit("aics:gateway-ready", &url);
                        s.gateway_recovery.publish(&handle, gateway_monitor::Phase::Ready, "");
                        main_shared::dispatch_startup(&handle, &url);
                    }
                    Err(e) => {
                        s.error(&format!("Gateway start failed: {e}"));
                        s.gateway_recovery.publish(&handle, gateway_monitor::Phase::Reconnecting, "startup");
                        if ui_entry::bundled(&handle) || resource_assistant::recovery_pending(&handle) {
                            return;
                        }
                        use tauri_plugin_dialog::DialogExt;
                        handle.dialog().message(format!(
                            "本地网关未能启动，桌宠和画室暂时无法打开。请重新安装修复版；后台会继续尝试恢复。\n\n诊断日志：{}\n\n{}",
                            s.paths.desktop_log.display(), e
                        )).title("绘遇 · 启动未完成").show(|_| {});
                    }
                }
            });

            desktop_shell::initialize(app.handle());
            let _ = tray::create_tray(app.handle());
            if ui_entry::bundled(app.handle()) { main_shared::dispatch_startup(app.handle(), ""); }
            let handle = app.handle().clone();
            watchers::start_global_mouse_watch(handle.clone());
            watchers::start_system_watch(handle.clone(), ui_entry::isolated_profile().is_none());
            gateway_monitor::start(handle);
            Ok(())
        })
        .build(context)
        .expect("error while building tauri application");

    // 窗口事件（move/resize → 防抖保存；atelier 关闭 → 隐藏）
    app.run(|app_handle, event| {
        use tauri::RunEvent;
        match event {
            RunEvent::ExitRequested { api, code, .. } => {
                // 托盘常驻：所有窗口关闭不退出（对应 Electron 版
                // "keep the tray process alive"）；显式退出（托盘菜单）
                // 会先置 quitting 标志。
                let state = app_handle.state::<AppState>();
                if code == Some(tauri::RESTART_EXIT_CODE) {
                    // Tauri treats its restart exit code as non-preventable.
                    desktop_shutdown::finish_before_restart(app_handle);
                } else if !state.quitting.load(Ordering::Acquire) {
                    api.prevent_exit();
                } else if !desktop_shutdown::finished() {
                    api.prevent_exit();
                    desktop_shutdown::request(app_handle, code.unwrap_or(0), false);
                }
            }
            RunEvent::WindowEvent { label, event: win_event, .. } => match win_event {
                tauri::WindowEvent::Focused(true) => desktop_shell::remember_focus(app_handle, &label),
                change @ (tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)) => {
                    if label == "companion" { chat_dock::follow(app_handle); }
                    // The native move loop owns the position until release. Resizes
                    // still reach the WebView immediately on a per-monitor DPI change.
                    if matches!(change, tauri::WindowEvent::Moved(_)) && label == "companion"
                        && app_handle.state::<AppState>().companion_input.recover_lock().moving { return; }
                    window_persistence::changed(app_handle, &label);
                    if matches!(change, tauri::WindowEvent::Resized(_)) {
                        if let Some(window) = app_handle.get_webview_window(&label) {
                            if label == "atelier" {
                                desktop_shell::publish_maximized(&window);
                            }
                            if matches!(label.as_str(), "atelier" | "companion" | "companion-chat") {
                                webview_memory::refresh(&window);
                            }
                        }
                    }
                }
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if label == "atelier" {
                        window_persistence::closing(app_handle, &label);
                        api.prevent_close();
                        desktop_shell::close_atelier(app_handle);
                    } else if label == "companion" {
                        api.prevent_close();
                        main_shared::hide_companion(app_handle);
                    } else if label == "companion-chat" {
                        api.prevent_close();
                        main_shared::hide_companion_chat(app_handle);
                    }
                }
                _ => {}
            },
            _ => {}
        }
    });
}
