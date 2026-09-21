#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod bridge;
mod credentials;
mod gateway;
mod live2d_overlay;
mod logger;
mod main_shared;
mod paths;
mod shim;
mod state;
mod tray;
mod updater_cmd;
mod watchers;
mod window_state;
mod window_presentation;
mod chat_dock;
mod live2d_framing;

use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Listener, Manager};

use crate::state::AppState;

pub fn now_iso() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    format!("{:?}", now.as_secs())
}

/// 网关健康监控：5s 轮询，连续 3 次失败或子进程退出 → 指数退避重启（2^n 秒封顶 30s）
fn start_gateway_monitor(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut failures = 0u32;
        let mut restart_attempt = 0u32;
        loop {
            tokio::time::sleep(Duration::from_secs(5)).await;
            let state = app.state::<AppState>();
            let Some(supervisor) = app.try_state::<gateway::GatewaySupervisor>() else {
                continue;
            };
            let healthy = supervisor.is_healthy();
            if healthy {
                failures = 0;
                restart_attempt = 0;
                continue;
            }
            failures += 1;
            if failures < 3 {
                continue;
            }
            // 子进程已退出（owned 但不在运行）或 3 次探测失败 → 重启
            let delay = Duration::from_secs((2u64.saturating_pow(restart_attempt.min(5))).min(30));
            restart_attempt += 1;
            failures = 0;
            state.warn(&format!("gateway unhealthy, restarting in {delay:?}"));
            tokio::time::sleep(delay).await;
            match supervisor.start().await {
                Ok(url) => {
                    if let Err(error) = main_shared::authorize_gateway_origin(&app, &url) {
                        state.error(&format!("gateway capability rejected: {error}"));
                        continue;
                    }
                    *state.gateway_url.lock().unwrap() = url.clone();
                    let _ = app.emit("aics:gateway-url", url.clone());
                    state.info(&format!("gateway restarted at {url}"));
                    // 页面重新加载
                    if let Some(w) = app.get_webview_window("companion") {
                        let companion_url = format!("{}/companion", url.trim_end_matches('/'));
                        if let Ok(parsed) = companion_url.parse() {
                            let _ = w.navigate(parsed);
                        }
                    } else {
                        let visible = !std::env::args().any(|arg| arg == "--hidden");
                        if let Err(error) = main_shared::create_companion_window(&app, &url, shim::COMPANION_SHIM_JS, visible) {
                            state.error(&format!("companion recovery failed: {error}"));
                        }
                    }
                    if let Some(w) = app.get_webview_window("companion-chat") {
                        let chat_url = format!("{}/companion-chat", url.trim_end_matches('/'));
                        if let Ok(parsed) = chat_url.parse() {
                            let _ = w.navigate(parsed);
                        }
                    }
                    if let Some(w) = app.get_webview_window("atelier") {
                        let _ = w.navigate(url.parse().unwrap());
                    }
                }
                Err(e) => state.error(&format!("gateway restart failed: {e}")),
            }
        }
    });
}

fn register_shortcuts(app: &AppHandle) {
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let handler = |app: &AppHandle, shortcut: &tauri_plugin_global_shortcut::Shortcut, event: tauri_plugin_global_shortcut::ShortcutEvent| {
        use tauri_plugin_global_shortcut::ShortcutState;
        if event.state() != ShortcutState::Pressed {
            return;
        }
        // 实测 into_string() 输出 shift+control+KeyP，宽松匹配
        let key = shortcut.to_string();
        if key.contains("KeyP") {
            let state = app.state::<AppState>();
            let next = !state.ignore_mouse_events.load(Ordering::Relaxed);
            bridge::set_ignore_mouse_events(app, next);
        } else if key.contains("Space") {
            main_shared::toggle_companion_visibility(app);
        } else if key.contains("KeyA") {
            let url = app.state::<AppState>().gateway_url.lock().unwrap().clone();
            main_shared::open_atelier(app, &url, None);
        } else if key.contains("KeyX") {
            // Ctrl+Shift+X：开/关聊天窗（避开与浏览器 DevTools 冲突的 Ctrl+Shift+C）
            let url = app.state::<AppState>().gateway_url.lock().unwrap().clone();
            main_shared::toggle_companion_chat(app, &url);
        }
    };
    let _ = app.global_shortcut().on_shortcuts(
        ["ctrl+shift+p", "ctrl+shift+space", "ctrl+shift+a", "ctrl+shift+x"],
        handler,
    );
}



fn main() {
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
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let state = app.state::<AppState>();
            for arg in argv {
                if arg.starts_with("aics://") {
                    let target = arg.trim_start_matches("aics://").trim_start_matches('/').to_string();
                    let path = main_shared::normalize_atelier_path(Some(&format!("/{target}")));
                    state.info(&format!("deep link: {arg} -> {path}"));
                    let url = state.gateway_url.lock().unwrap().clone();
                    main_shared::open_atelier(app, &url, Some(&path));
                    return;
                }
            }
            main_shared::show_companion(app, true);
        }))
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
            credentials::chat_credential_read,
            credentials::chat_credential_write,
            bridge::get_state,
            bridge::hide,
            bridge::quit,
            bridge::set_ignore_mouse_events_cmd,
            bridge::toggle_ignore_mouse_events,
            bridge::toggle_always_on_top,
            bridge::set_live2d_enabled,
            bridge::get_settings,
            bridge::set_autostart,
            bridge::is_packaged,
            bridge::get_workspace,
            bridge::set_workspace,
            bridge::notify,
            bridge::open_atelier,
            bridge::open_companion_chat,
            bridge::toggle_companion_chat,
            bridge::hide_companion_chat,
            chat_dock::set_chat_docked,
            chat_dock::get_chat_docked,
            bridge::chat_relay,
            bridge::window_minimize,
            bridge::window_maximize_toggle,
            bridge::window_close,
            bridge::get_window_state,
            window_presentation::window_zoom_get,
            window_presentation::window_zoom_set,
            bridge::set_progress,
            bridge::open_workspace,
            bridge::open_runtime,
            bridge::open_log,
            bridge::pick_files,
            bridge::save_image,
            updater_cmd::desktop_update_check,
            updater_cmd::desktop_update_install,
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
            live2d_overlay::aics_live2d_get_state,
            ];
            move |invoke: tauri::ipc::Invoke| {
                let view = invoke.message.webview();
                let trusted = view.url().map(|url| main_shared::is_gateway_origin(view.app_handle(), &url)).unwrap_or(false);
                if !trusted {
                    invoke.resolver.reject("IPC requires the current authenticated gateway origin");
                    return true;
                }
                handler(invoke)
            }
        })
        .setup(|app| {
            let state = AppState::new(paths::resolve_paths(app.handle()));
            app.manage(state);
            let state = app.state::<AppState>();

            if std::env::var("LIVE2D_SELFTEST").is_ok() {
                let assets = app.state::<AppState>().paths.assets_root.clone();
                match live2d_overlay::selftest(assets) {
                    Ok(()) => std::process::exit(0),
                    Err(e) => {
                        eprintln!("LIVE2D_SELFTEST_FAIL: {e}");
                        std::process::exit(1);
                    }
                }
            }

            state.info("Companion starting (tauri shell)");

            // GitHub Releases 更新检查不依赖本地网关；失败静默，不影响离线启动。
            updater_cmd::spawn_startup_check(app.handle().clone());

            // 深链注册（dev 模式插件不会自动写注册表，需显式注册）
            {
                use tauri_plugin_deep_link::{DeepLinkExt, OpenUrlEvent};
                let _ = app.deep_link().register("aics");
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event: OpenUrlEvent| {
                    let state = handle.state::<AppState>();
                    for url in event.urls() {
                        let url = url.to_string();
                        let target = url
                            .trim_start_matches("aics://")
                            .trim_start_matches('/')
                            .trim_end_matches('/')
                            .to_string();
                        let path = main_shared::normalize_atelier_path(Some(&format!("/{target}")));
                        state.info(&format!("deep link: {url} -> {path}"));
                        let gateway = state.gateway_url.lock().unwrap().clone();
                        main_shared::open_atelier(&handle, &gateway, Some(&path));
                    }
                });
            }

            // 数据迁移（Electron → Tauri，幂等）
            let migrated = paths::migrate_electron_data(&state.paths.config_root, &state.paths.runtime_root);
            if !migrated.is_empty() {
                state.info(&format!("migrated electron data: {}", migrated.join(", ")));
            }

            // 工作区回填：迁移后重新读取
            if state.workspace_root.lock().unwrap().is_empty() {
                let loaded = window_state::load_ai_workspace(&state.paths.ai_workspace_file);
                if !loaded.is_empty() {
                    *state.workspace_root.lock().unwrap() = loaded;
                }
            }

            let is_packaged = app.package_info().version.major > 0 && !cfg!(debug_assertions);
            let configured_port = std::env::var("PORT")
                .ok()
                .and_then(|v| v.parse::<u16>().ok())
                .filter(|p| (1024..=65_535).contains(p))
                .unwrap_or_else(|| window_state::load_desktop_gateway_port(&state.paths.gateway_port_file, 3000));

            let log_path = state.paths.desktop_log.clone();
            let sidecar_node = state.paths.sidecar_node.clone();
            state.info(&format!(
                "gateway paths: packaged={is_packaged} script={} cwd={} node={}",
                state.paths.gateway_script.display(),
                state.paths.gateway_cwd.display(),
                sidecar_node.as_ref().map(|p| p.display().to_string()).unwrap_or_else(|| "system-node".into())
            ));
            let supervisor = gateway::GatewaySupervisorBuilder::new(
                state.paths.gateway_script.clone(),
                state.paths.gateway_cwd.clone(),
            )
            .port(configured_port)
            .node_path(sidecar_node)
            .env(main_shared::gateway_env(&state.paths, is_packaged, Some(&state.workspace_root.lock().unwrap())))
            .on_output(move |stream, text| {
                let log = logger::FileLogger::new(&log_path);
                log.debug(&format!("[gateway:{stream}] {}", text.trim()));
            })
            .build();
            app.manage(supervisor);

            // 网关启动（与窗口并行）
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let s = handle.state::<AppState>();
                let supervisor = handle.state::<gateway::GatewaySupervisor>();
                match supervisor.start().await {
                    Ok(url) => {
                        if let Err(error) = main_shared::authorize_gateway_origin(&handle, &url) {
                            s.error(&format!("gateway capability rejected: {error}"));
                            return;
                        }
                        *s.gateway_url.lock().unwrap() = url.clone();
                        window_state::save_desktop_gateway_port(&s.paths.gateway_port_file, supervisor.port());
                        s.info(&format!("Gateway {} at {url}", if supervisor.owns_gateway() { "started" } else { "attached" }));
                        let _ = handle.emit("aics:gateway-ready", url);
                    }
                    Err(e) => {
                        s.error(&format!("Gateway start failed: {e}"));
                        use tauri_plugin_dialog::DialogExt;
                        handle.dialog().message(format!(
                            "本地网关未能启动，桌宠和画室暂时无法打开。请重新安装修复版；后台会继续尝试恢复。\n\n诊断日志：{}\n\n{}",
                            s.paths.desktop_log.display(), e
                        )).title("绘遇 · 启动未完成").show(|_| {});
                    }
                }
            });

            let handle = app.handle().clone();
            let shim = shim::COMPANION_SHIM_JS;
            let show_on_start = !std::env::args().any(|arg| arg == "--hidden");
            tauri::async_runtime::spawn(async move {
                let start = Instant::now();
                loop {
                    tokio::time::sleep(Duration::from_millis(200)).await;
                    let ready = !handle.state::<AppState>().gateway_url.lock().unwrap().is_empty();
                    if ready || start.elapsed() > Duration::from_secs(40) {
                        break;
                    }
                }
                let url = handle.state::<AppState>().gateway_url.lock().unwrap().clone();
                if url.is_empty() {
                    return;
                }
                if let Err(e) = main_shared::create_companion_window(&handle, &url, shim, show_on_start) {
                    eprintln!("companion window: {e}");
                }
            });

            // 事件桥：托盘/快捷键 → 命令
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let h = handle.clone();
                h.listen("aics:tray-left-click", {
                    let inner = h.clone();
                    move |_| main_shared::show_companion(&inner, true)
                });
                let h2 = handle.clone();
                h2.listen("aics:show-companion", {
                    let inner = h2.clone();
                    move |_| main_shared::show_companion(&inner, true)
                });
                let h3 = handle.clone();
                h3.listen("aics:open-atelier", {
                    let inner = h3.clone();
                    move |_| {
                        let state = inner.state::<AppState>();
                        let url = state.gateway_url.lock().unwrap().clone();
                        main_shared::open_atelier(&inner, &url, None);
                    }
                });
                let h5 = handle.clone();
                h5.listen("aics:open-chat", {
                    let inner = h5.clone();
                    move |_| {
                        let state = inner.state::<AppState>();
                        let url = state.gateway_url.lock().unwrap().clone();
                        main_shared::open_companion_chat(&inner, &url);
                    }
                });
                let h4 = handle.clone();
                h4.listen("aics:shim-diagnose", {
                    let inner = h4.clone();
                    move |event| {
                        let state = inner.state::<AppState>();
                        state.warn(&format!("[shim] {}", event.payload().to_string()));
                    }
                });
                loop { tokio::time::sleep(Duration::from_secs(3600)).await; }
            });

            // 窗口状态持久化
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let h = handle.clone();
                h.listen("aics:save-bounds", {
                    let inner = h.clone();
                    move |_| main_shared::persist_window_bounds(&inner)
                });
                loop { tokio::time::sleep(Duration::from_secs(3600)).await; }
            });

            let _ = tray::create_tray(app.handle());
            register_shortcuts(app.handle());
            let handle = app.handle().clone();
            watchers::start_global_mouse_watch(handle.clone());
            watchers::start_clipboard_watch(handle.clone());
            watchers::start_power_watch(handle.clone());
            watchers::start_display_watch(handle.clone());
            watchers::start_hidden_degrade(handle.clone());
            start_gateway_monitor(handle);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // 窗口事件（move/resize → 防抖保存；atelier 关闭 → 隐藏）
    app.run(|app_handle, event| {
        use tauri::RunEvent;
        match event {
            RunEvent::ExitRequested { api, .. } => {
                // 托盘常驻：所有窗口关闭不退出（对应 Electron 版
                // "keep the tray process alive"）；显式退出（托盘菜单/quit 命令）
                // 会先置 quitting 标志。
                let state = app_handle.state::<AppState>();
                if !state.quitting.load(Ordering::Relaxed) {
                    api.prevent_exit();
                } else if let Some(supervisor) = app_handle.try_state::<gateway::GatewaySupervisor>() {
                    // 显式退出：先停掉自有的 sidecar 网关，避免 node 孤儿进程
                    // 继续占用端口（Drop 不触发，实测见 gateway.rs stop_sync 注释）
                    supervisor.stop_sync();
                }
            }
            RunEvent::WindowEvent { label, event: win_event, .. } => match win_event {
                tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_) => {
                    if label == "companion" { chat_dock::follow(app_handle); }
                    let _ = app_handle.emit("aics:save-bounds", ());
                    if label == "atelier" {
                        if let Some(window) = app_handle.get_webview_window("atelier") {
                            let _ = window.emit("aics:maximized", window.is_maximized().unwrap_or(false));
                        }
                    }
                }
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if label == "atelier" {
                        api.prevent_close();
                        if let Some(w) = app_handle.get_webview_window("atelier") {
                            let _ = w.hide();
                        }
                    } else if label == "companion" || label == "companion-chat" {
                        api.prevent_close();
                        if let Some(w) = app_handle.get_webview_window(&label) {
                            let _ = w.hide();
                        }
                    }
                }
                _ => {}
            },
            _ => {}
        }
    });
}
