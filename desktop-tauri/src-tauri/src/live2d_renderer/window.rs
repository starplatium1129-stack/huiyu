use super::*;

fn create_overlay_window() -> Option<HWND> {
    unsafe {
        let class_name = "aics_live2d_overlay\0".encode_utf16().collect::<Vec<u16>>();
        let window_title = "aics-live2d-overlay\0".encode_utf16().collect::<Vec<u16>>();
        let hinstance = GetModuleHandleW(std::ptr::null());
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(overlay_wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class_name.as_ptr(),
            hIconSm: std::ptr::null_mut(),
        };
        if RegisterClassExW(&wc) == 0 {
            let err = windows_sys::Win32::Foundation::GetLastError() as i32;
            if err != 1410 {
                // 1410 = ERROR_CLASS_ALREADY_EXISTS
                return None;
            }
        }
        let hwnd = CreateWindowExW(
            (WS_EX_NOREDIRECTIONBITMAP | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT)
                as WINDOW_EX_STYLE,
            class_name.as_ptr(),
            window_title.as_ptr(),
            WS_POPUP as WINDOW_STYLE,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            1,
            1,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            hinstance,
            std::ptr::null(),
        );
        if hwnd.is_null() {
            return None;
        }
        // 必须让窗口进入"已显示"状态，DXGI 才能枚举 surface 格式；
        // 后续由 SetFrame 用 SetWindowPos 定位 + SW_SHOWNA 真正显示。
        ShowWindow(hwnd, SW_SHOWNA);
        Some(hwnd)
    }
}

extern "system" fn overlay_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe {
        match msg {
            WM_DESTROY => {
                PostQuitMessage(0);
                return 0;
            }
            _ => {}
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

/// 渲染线程退出时向前端广播 stopped（带原因）。前端据此显示"渲染已停止"
/// 并可重试；正常 destroy 命令不退出线程，不触发本事件。
fn emit_stopped(app: Option<&RendererEvents>, reason: &str) {
    if let Some(app) = app {
        let _ = app.emit(
            "aics:live2d:stopped",
            serde_json::json!({ "reason": reason }),
        );
    }
}

/// 渲染线程：消息循环（非阻塞）+ 命令处理 + 帧渲染。
pub(crate) fn overlay_window_thread(
    state: Arc<Live2DOverlayState>,
    environment: RendererEnvironment,
) {
    let assets_root = &environment.assets_root;
    let app = environment.events.as_ref();
    // DPI 感知：进程级 per-monitor v2。前端 live2dOverlayLayout 已把 overlay
    // 矩形换算成屏幕物理像素，若进程非 DPI aware，Win32 会按系统 DPI 缩放
    // 窗口坐标导致错位（旧文档记录过 0.57 缩放问题）。Tauri/wry 若已设置
    // 则幂等；per-monitor v2 失败时回退 system-aware。
    unsafe {
        use windows_sys::Win32::UI::HiDpi::{
            SetProcessDpiAwareness, SetProcessDpiAwarenessContext,
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, PROCESS_PER_MONITOR_DPI_AWARE,
        };
        if SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) == 0 {
            let _ = SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE);
        }
    }
    let Some(hwnd) = create_overlay_window() else {
        let reason = "create overlay window failed";
        eprintln!("[live2d] {reason}");
        reset_runtime_state(&state);
        emit_stopped(app, reason);
        return;
    };
    unsafe {
        SetWindowLongPtrW(
            hwnd,
            GWLP_USERDATA,
            &*state as *const Live2DOverlayState as isize,
        );
    }
    *state.hwnd.lock().unwrap() = Some(hwnd as isize);

    let (tx, rx): (Sender<OverlayCommand>, Receiver<OverlayCommand>) = channel();
    *state.cmd_tx.lock().unwrap() = Some(tx);

    let mut ctx = match RenderContext::new() {
        Ok(ctx) => ctx,
        Err(e) => {
            eprintln!("[live2d] render context init failed: {e}");
            unsafe {
                DestroyWindow(hwnd);
            }
            reset_runtime_state(&state);
            emit_stopped(app, &format!("render context init failed: {e}"));
            return;
        }
    };
    state.renderer_attached.store(true, Ordering::SeqCst);
    state.window_ready.store(true, Ordering::SeqCst);
    state.starting.store(false, Ordering::SeqCst);

    // 目标帧率：默认 165（vsync 由 surface present 决定，165Hz 屏即 165fps），
    // 可用 L2D_TARGET_FPS 覆盖；前端也可通过 setMaxFps 动态调整。
    state.target_fps.store(frame_pacing::initial_fps(std::env::var("L2D_TARGET_FPS").ok().as_deref()), Ordering::SeqCst);

    let mut last_frame = Instant::now();
    let mut last_z_order_sync = Instant::now() - Duration::from_secs(1);
    let mut running = true;
    // 线程退出原因：None 表示 WM_QUIT 正常退出（窗口销毁，如进程退出），
    // 此时前端通常已不在；其余错误路径必须带原因广播，前端才能显示重试。
    let mut stopped_reason: Option<String> = None;
    while running && !state.shutdown.load(Ordering::SeqCst) {
        let iteration_started = Instant::now();
        unsafe {
            let mut msg = std::mem::zeroed::<MSG>();
            while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) > 0 {
                if msg.message == 0x0012 {
                    // WM_QUIT
                    running = false;
                }
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        loop {
            match rx.try_recv() {
                Ok(cmd) => handle_command(&state, &mut ctx, assets_root, environment.local_root.as_deref(), app, hwnd, cmd),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    stopped_reason = Some("renderer command channel disconnected".into());
                    running = false;
                    break;
                }
            }
        }
        // 每帧 poll 一次以驱动 wgpu 的 device lost 回调（非阻塞，开销极小）。
        // 不 poll 就永远发现不了 GPU reset / TDR / 休眠唤醒后的设备失效：原实现
        // 会在已作废的资源上继续 submit + present，画面变成满屏雪花，且因为
        // surface 仍能拿到帧（只是内容作废）而毫无征兆，只能重启进程恢复。
        if running {
            let _ = ctx.device.poll(wgpu::PollType::Poll);
            if DEVICE_LOST.swap(false, Ordering::SeqCst) {
                let detail = DEVICE_LOST_DETAIL
                    .lock()
                    .ok()
                    .and_then(|slot| slot.clone())
                    .unwrap_or_else(|| "未知原因".to_string());
                eprintln!("[live2d] device lost: {detail}");
                stopped_reason = Some(format!("GPU 设备丢失：{detail}"));
                break;
            }
        }
        if running && state.visible.load(Ordering::SeqCst) {
            let mut rect = *state.rect.lock().unwrap();
            if let (Some(companion), Some(offset)) = (
                *state.companion_hwnd.lock().unwrap(),
                *state.companion_offset.lock().unwrap(),
            ) {
                let companion = companion as HWND;
                let mut companion_rect = unsafe { std::mem::zeroed::<RECT>() };
                if unsafe { GetWindowRect(companion, &mut companion_rect) } != 0 {
                    let followed = followed_overlay_rect(
                        rect,
                        companion_rect.left,
                        companion_rect.top,
                        offset,
                    );
                    let moved = followed.x != rect.x || followed.y != rect.y;
                    let sync_z_order = last_z_order_sync.elapsed() >= Duration::from_millis(250);
                    if moved || sync_z_order {
                        unsafe {
                            SetWindowPos(
                                hwnd,
                                companion,
                                followed.x,
                                followed.y,
                                0,
                                0,
                                SWP_NOACTIVATE | SWP_NOSIZE,
                            );
                        }
                        if moved {
                            *state.rect.lock().unwrap() = followed;
                            rect = followed;
                        }
                        last_z_order_sync = Instant::now();
                    }
                }
            }
            let now = Instant::now();
            let dt = (now - last_frame).as_secs_f32().min(0.1);
            last_frame = now;
            ctx.step(dt);
            ctx.advance_motion(dt, app);
            match ctx.render_frame(&state, hwnd, rect) {
                Ok(true) => {
                    state.frame_count.fetch_add(1, Ordering::Relaxed);
                }
                Ok(false) => {}
                Err(e) => {
                    eprintln!("[live2d] render frame: {e}");
                    stopped_reason = Some(format!("render frame failed: {e}"));
                    running = false;
                }
            }
        }
        if let Some(cmd) = if running { frame_pacing::wait(&rx, state.visible.load(Ordering::SeqCst), state.target_fps.load(Ordering::Relaxed), iteration_started.elapsed()) } else { None } {
            handle_command(&state, &mut ctx, assets_root, environment.local_root.as_deref(), app, hwnd, cmd);
        }
    }

    // The surface borrows HWND: drop all GPU/model resources before destroying it.
    drop(ctx);
    unsafe { DestroyWindow(hwnd); }
    reset_runtime_state(&state);
    emit_stopped(app, stopped_reason.as_deref().unwrap_or("renderer shutdown"));
}
