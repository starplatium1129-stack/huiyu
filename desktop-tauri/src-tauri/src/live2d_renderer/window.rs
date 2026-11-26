use crate::mutex::RecoverMutex;
use super::*;
use windows_sys::Win32::System::RemoteDesktop::{
    WTSRegisterSessionNotification, WTSUnRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    GetCursorPos, GetWindowLongPtrW, PBT_APMRESUMEAUTOMATIC, PBT_APMRESUMESUSPEND,
    PBT_APMSUSPEND, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK,
    WTS_SESSION_UNLOCK,
};

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
            -32_000,
            -32_000,
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
        // Keep the DirectComposition target offscreen until its first present.
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
            windows_sys::Win32::UI::WindowsAndMessaging::WM_NCHITTEST => {
                return windows_sys::Win32::UI::WindowsAndMessaging::HTTRANSPARENT as LRESULT;
            }
            WM_DESTROY => {
                PostQuitMessage(0);
                return 0;
            }
            WM_WTSSESSION_CHANGE | WM_POWERBROADCAST => {
                let state = GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Live2DOverlayState;
                if let Some(state) = state.as_ref() {
                    match (msg, wparam as u32) {
                        (WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK | WTS_SESSION_UNLOCK) => {
                            state.session_locked.store(wparam as u32 == WTS_SESSION_LOCK, Ordering::Release);
                        }
                        (WM_POWERBROADCAST, PBT_APMSUSPEND | PBT_APMRESUMEAUTOMATIC | PBT_APMRESUMESUSPEND) => {
                            state.system_suspended.store(wparam as u32 == PBT_APMSUSPEND, Ordering::Release);
                        }
                        _ => {}
                    }
                }
                if msg == WM_POWERBROADCAST { return 1; }
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
    let session_events = unsafe { WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION) } != 0;
    unsafe {
        SetWindowLongPtrW(
            hwnd,
            GWLP_USERDATA,
            &*state as *const Live2DOverlayState as isize,
        );
    }
    *state.hwnd.recover_lock() = Some(hwnd as isize);

    let (tx, rx): (Sender<OverlayCommand>, Receiver<OverlayCommand>) = channel();
    *state.cmd_tx.recover_lock() = Some(tx);

    // Merely attaching the overlay must not allocate a GPU device. Destroy returns
    // to this state while leaving the lightweight window/command loop reusable.
    state.renderer_attached.store(true, Ordering::SeqCst);
    state.window_ready.store(true, Ordering::SeqCst);
    state.starting.store(false, Ordering::SeqCst);

    state.fps_limit.store(frame_pacing::initial_fps(std::env::var("L2D_TARGET_FPS").ok().as_deref()), Ordering::Relaxed);

    let mut ctx = if environment.prewarm && !state.shutdown.load(Ordering::Acquire) {
        RenderContext::new().and_then(|mut ctx| {
            ctx.ensure_surface(hwnd)?;
            Ok(ctx)
        }).map_err(|error| eprintln!("[live2d] prewarm: {error}")).ok()
    } else { None };
    let mut last_frame = Instant::now();
    let mut next_frame = last_frame;
    let mut next_display_check = last_frame;
    let mut follow_until = last_frame;
    let mut pointer_active_until = last_frame;
    let mut previous_pointer = None;
    let mut last_pointer_sample = None;
    let mut next_visibility_check = last_frame;
    let mut desktop_blocked = false;
    let mut paused = false;
    let mut display_hz = frame_pacing::FALLBACK_HZ;
    let mut pointer_margin = 32;
    let mut last_z_order_sync = Instant::now() - Duration::from_secs(1);
    let mut running = true;
    // 线程退出原因：None 表示 WM_QUIT 正常退出（窗口销毁，如进程退出），
    // 此时前端通常已不在；其余错误路径必须带原因广播，前端才能显示重试。
    let mut stopped_reason: Option<String> = None;
    while running && !state.shutdown.load(Ordering::SeqCst) {
        let iteration_started = Instant::now();
        let mut next_tick = None;
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
        while running && !state.shutdown.load(Ordering::Acquire) {
            match rx.try_recv() {
                Ok(cmd) => handle_command(&state, &mut ctx, &environment, hwnd, cmd),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    stopped_reason = Some("renderer command channel disconnected".into());
                    running = false;
                    break;
                }
            }
        }
        if !running || state.shutdown.load(Ordering::Acquire) {
            break;
        }
        // apply_frame runs on the IPC thread; close the narrow race where it read
        // model_ready just before Destroy and made the now-empty window visible.
        if ctx.is_none() && state.visible.swap(false, Ordering::SeqCst) {
            unsafe { ShowWindow(hwnd, SW_HIDE); }
        }
        // 每帧 poll 一次以驱动 wgpu 的 device lost 回调（非阻塞，开销极小）。
        // 不 poll 就永远发现不了 GPU reset / TDR / 休眠唤醒后的设备失效：原实现
        // 会在已作废的资源上继续 submit + present，画面变成满屏雪花，且因为
        // surface 仍能拿到帧（只是内容作废）而毫无征兆，只能重启进程恢复。
        if running {
            if let Some(ctx) = ctx.as_ref() {
                let _ = ctx.device.poll(wgpu::PollType::Poll);
            }
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
        if let Some(renderer) = ctx.as_mut().filter(|_| running && state.visible.load(Ordering::SeqCst)) {
            let mut rect = *state.rect.recover_lock();
            let companion = *state.companion_hwnd.recover_lock();
            if iteration_started >= next_display_check {
                // The companion selects the monitor even while the overlay is parked offscreen.
                let anchor = companion.map_or(hwnd, |handle| handle as HWND);
                display_hz = frame_pacing::display_refresh_hz(anchor);
                pointer_margin = unsafe { windows_sys::Win32::UI::HiDpi::GetDpiForWindow(anchor) }
                    .max(96).div_ceil(3);
                state.display_hz.store(display_hz, Ordering::Relaxed);
                next_display_check = iteration_started + Duration::from_secs(1);
            }
            if let (Some(companion), Some(offset)) = (companion, *state.companion_offset.recover_lock()) {
                let companion = companion as HWND;
                if let Some(point) = companion_origin(companion) {
                    let followed = followed_overlay_rect(
                        rect,
                        point.x,
                        point.y,
                        offset,
                    );
                    let moved = followed.x != rect.x || followed.y != rect.y;
                    let sync_z_order = last_z_order_sync.elapsed() >= Duration::from_millis(250);
                    if (moved || sync_z_order) && state.revealed.load(Ordering::Acquire) && state.first_frame_ready.load(Ordering::Acquire) {
                        let mut flags = SWP_NOACTIVATE | SWP_NOSIZE;
                        if !sync_z_order { flags |= windows_sys::Win32::UI::WindowsAndMessaging::SWP_NOZORDER; }
                        unsafe {
                            SetWindowPos(
                                hwnd,
                                companion,
                                followed.x,
                                followed.y,
                                0,
                                0,
                                flags,
                            );
                        }
                        if sync_z_order { last_z_order_sync = iteration_started; }
                    }
                    if moved {
                        *state.rect.recover_lock() = followed;
                        rect = followed;
                        follow_until = iteration_started + Duration::from_millis(120);
                    }
                }
            }
            if iteration_started >= next_visibility_check {
                desktop_blocked = frame_pacing::desktop_blocks_present()
                    || (state.revealed.load(Ordering::Acquire)
                        && state.first_frame_ready.load(Ordering::Acquire)
                        && frame_pacing::fully_covered(hwnd, companion.map_or(std::ptr::null_mut(), |handle| handle as HWND), rect));
                next_visibility_check = iteration_started + Duration::from_millis(250);
            }
            let blocked = desktop_blocked || state.session_locked.load(Ordering::Acquire)
                || state.system_suspended.load(Ordering::Acquire);
            state.render_suspended.store(blocked, Ordering::Relaxed);
            if blocked {
                state.target_fps.store(0, Ordering::Relaxed);
                paused = true;
                clear_pointer_feedback(&state, &mut last_pointer_sample);
                if let Some(cmd) = frame_pacing::wait(&rx, None) {
                    handle_command(&state, &mut ctx, &environment, hwnd, cmd);
                }
                continue;
            }
            if paused {
                // Keep motion time frozen while the desktop could not show the
                // frame. Do not give Cubism the accumulated sleep interval.
                next_frame = iteration_started;
                last_frame = iteration_started;
                paused = false;
            }
            let pointer = cursor_position();
            let cursor_near = pointer.is_some_and(|(x, y)| near_rect(rect, x, y, pointer_margin));
            if cursor_near && previous_pointer != pointer {
                pointer_active_until = iteration_started + Duration::from_millis(350);
            }
            previous_pointer = pointer;
            // Keep the last presented image attached to the moving input window
            // at display cadence, even if model updates are capped to save power.
            let fps_limit = state.fps_limit.load(Ordering::Relaxed);
            let active = iteration_started < follow_until || iteration_started < pointer_active_until
                || renderer.mouth_level > 0.01 || renderer.overlay_settler.is_some()
                || renderer.active_motion.as_ref().is_some_and(|motion| motion.phase != MotionPhase::Idle)
                || !state.first_frame_ready.load(Ordering::Acquire);
            let model_hz = frame_pacing::model_fps(fps_limit, display_hz, active);
            if model_hz > state.target_fps.swap(model_hz, Ordering::Relaxed) {
                next_frame = next_frame.min(iteration_started);
            }
            let period = frame_pacing::interval(model_hz);
            let now = Instant::now();
            if now >= next_frame {
                next_frame += period;
                if next_frame <= now { next_frame = now + period; }
                let dt = (now - last_frame).as_secs_f32().min(0.1);
                last_frame = now;
                if companion.is_some() {
                    update_native_gaze(renderer, rect, pointer, dt);
                }
                renderer.step(dt);
                renderer.advance_motion(dt);
                match renderer.render_frame(&state, hwnd, rect, cursor_near) {
                    Ok(true) => {
                        state.frame_count.fetch_add(1, Ordering::Relaxed);
                        if fps_limit == 0 && model_hz == display_hz && state.revealed.load(Ordering::Acquire) {
                            // Acquire wakes on the display's actual vblank. Allow it to
                            // clock normal frames; bound rapid returns if DWM is occluded.
                            next_frame = iteration_started + period.mul_f32(0.75);
                        }
                        if state.visible.load(Ordering::Acquire) && !state.first_frame_ready.load(Ordering::Acquire)
                            && state.alpha_mask.recover_read().is_some()
                            && !state.first_frame_ready.swap(true, Ordering::AcqRel) {
                            if state.revealed.load(Ordering::Acquire) {
                                let companion = state.companion_hwnd.recover_lock().unwrap_or(0) as HWND;
                                frame::place_overlay(&state, hwnd, companion, rect);
                            }
                            if let Some(events) = app { let _ = events.emit("aics:live2d:first-frame", ()); }
                        }
                    }
                    Ok(false) => {}
                    Err(e) => {
                        eprintln!("[live2d] render frame: {e}");
                        stopped_reason = Some(format!("render frame failed: {e}"));
                        running = false;
                    }
                }
            }
            next_tick = Some(if now < follow_until {
                next_frame.min(iteration_started + frame_pacing::interval(display_hz))
            } else { next_frame });
            update_pointer_feedback(&state, rect, pointer, &mut last_pointer_sample);
        } else {
            state.target_fps.store(0, Ordering::Relaxed);
            state.render_suspended.store(false, Ordering::Relaxed);
            paused = true;
            clear_pointer_feedback(&state, &mut last_pointer_sample);
        }
        if let Some(cmd) = if running { frame_pacing::wait(&rx, next_tick) } else { None } {
            handle_command(&state, &mut ctx, &environment, hwnd, cmd);
        }
    }

    // The surface borrows HWND: drop all GPU/model resources before destroying it.
    drop(ctx);
    unsafe {
        if session_events { WTSUnRegisterSessionNotification(hwnd); }
        DestroyWindow(hwnd);
    }
    reset_runtime_state(&state);
    emit_stopped(app, stopped_reason.as_deref().unwrap_or("renderer shutdown"));
}

type SentPointerSample = (PointerHitSample, crate::live2d_framing::StageFraming, Instant);

fn clear_pointer_feedback(state: &Live2DOverlayState, last: &mut Option<SentPointerSample>) {
    if last.take().is_some() {
        if let Some(publish) = state.pointer_feedback.get() { publish(None); }
    }
}

fn update_pointer_feedback(
    state: &Live2DOverlayState,
    rect: OverlayRect,
    point: Option<(i32, i32)>,
    last: &mut Option<SentPointerSample>,
) {
    let Some(publish) = state.pointer_feedback.get() else { return; };
    let Some((x, y)) = point.filter(|&(x, y)| {
        rect.contains(x, y) && state.revealed.load(Ordering::Acquire)
            && state.first_frame_ready.load(Ordering::Acquire)
    }) else {
        clear_pointer_feedback(state, last);
        return;
    };
    let Some(framing) = state.framing.lock().ok().map(|value| *value) else {
        clear_pointer_feedback(state, last);
        return;
    };
    // Reuse a tile for nearby points and avoid polling-aligned pipe traffic
    // at high refresh rates. A changed layout bypasses the cache immediately.
    if last.as_ref().is_some_and(|(sample, recorded_framing, sent)| {
        framing == *recorded_framing
            && (sent.elapsed() < Duration::from_millis(16)
                || (sample.covers(rect, x, y) && sent.elapsed() < Duration::from_millis(125)))
    }) {
        return;
    }
    let sample = state.alpha_mask.recover_read().as_ref()
        .and_then(|mask| mask.pointer_sample(rect, framing, x, y));
    if let Some(sample) = sample {
        publish(Some(sample.clone()));
        *last = Some((sample, framing, Instant::now()));
    } else {
        clear_pointer_feedback(state, last);
    }
}

fn cursor_position() -> Option<(i32, i32)> {
    let mut point = POINT { x: 0, y: 0 };
    (unsafe { GetCursorPos(&mut point) } != 0).then_some((point.x, point.y))
}

fn near_rect(rect: OverlayRect, x: i32, y: i32, margin: u32) -> bool {
    if rect.width == 0 || rect.height == 0 { return false; }
    let local_x = i64::from(x) - i64::from(rect.x);
    let local_y = i64::from(y) - i64::from(rect.y);
    let margin = i64::from(margin);
    (-margin..i64::from(rect.width) + margin).contains(&local_x)
        && (-margin..i64::from(rect.height) + margin).contains(&local_y)
}

fn update_native_gaze(ctx: &mut RenderContext, rect: OverlayRect, point: Option<(i32, i32)>, dt: f32) {
    let (target, response) = match point {
        Some((x, y)) if rect.width > 0 && rect.height > 0 => {
            let limit = if rect.contains(x, y) { 1.0 } else { 0.82 };
            let local_x = (i64::from(x) - i64::from(rect.x)) as f32 / rect.width as f32;
            let local_y = (i64::from(y) - i64::from(rect.y)) as f32 / rect.height as f32;
            (((local_x * 2.0 - 1.0).clamp(-limit, limit), (1.0 - local_y * 2.0).clamp(-limit, limit)), 12.0)
        }
        _ => ((0.0, 0.0), 6.0),
    };
    let blend = 1.0 - f32::exp(-response * dt);
    let smooth = |value: f32, target: f32| {
        if (target - value).abs() <= 0.002 { target } else { value + (target - value) * blend }
    };
    ctx.gaze = (smooth(ctx.gaze.0, target.0), smooth(ctx.gaze.1, target.1));
}
