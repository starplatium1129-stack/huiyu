use super::*;

pub(crate) fn apply_frame(state: &Arc<Live2DOverlayState>, local_rect: OverlayRect, visible: bool, opacity: Option<u32>, companion: Option<isize>) -> Result<(), String> {
    let Some(hwnd) = state.hwnd.lock().unwrap().clone().map(|h| h as HWND) else {
        return Err("overlay window not ready".to_string());
    };
    let companion_hwnd = companion.map(|handle| handle as HWND).unwrap_or(std::ptr::null_mut());
    *state.companion_hwnd.lock().unwrap() = (!companion_hwnd.is_null())
        .then_some(companion_hwnd as isize);
    let (rect, companion_offset) = if companion_hwnd.is_null() {
        (local_rect, None)
    } else {
        let mut companion_rect = unsafe { std::mem::zeroed::<RECT>() };
        if unsafe { GetWindowRect(companion_hwnd, &mut companion_rect) } != 0 {
            (
                followed_overlay_rect(
                    local_rect,
                    companion_rect.left,
                    companion_rect.top,
                    (local_rect.x, local_rect.y),
                ),
                Some((local_rect.x, local_rect.y)),
            )
        } else {
            (local_rect, None)
        }
    };
    *state.companion_offset.lock().unwrap() = companion_offset;
    *state.rect.lock().unwrap() = rect;
    state.visible.store(visible, Ordering::SeqCst);
    if !visible {
        *state.model_bounds.lock().unwrap() = None;
    }
    let alpha = opacity.unwrap_or(255).min(255);
    state.opacity.store(alpha, Ordering::SeqCst);
    // Per-pixel alpha is supplied by the premultiplied DComp surface. A global
    // frame alpha would require multiplying every renderer output, which is
    // outside the allowed overlay files; retain the value for API/state
    // compatibility but intentionally do not apply it with layered-window APIs.
    unsafe {
        if visible {
            // 首次 ShowWindow 会改变 top-level z-order；必须先显示，再把 overlay
            // 放到 Companion 之后，否则透明模型窗口仍会吞掉 WebView 点击。
            ShowWindow(hwnd, SW_SHOWNA);
            SetWindowPos(
                hwnd,
                companion_hwnd,
                rect.x,
                rect.y,
                rect.width as i32,
                rect.height as i32,
                SWP_NOACTIVATE,
            );
        } else {
            ShowWindow(hwnd, SW_HIDE);
        }
    }
    Ok(())
}

/// 发送意图命令并等待渲染线程接收（IPC 同步命令的通道建立）。
pub(crate) fn send_command(state: &Arc<Live2DOverlayState>, cmd: OverlayCommand) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let tx = state.cmd_tx.lock().unwrap().clone();
        if let Some(tx) = tx {
            tx.send(cmd)
                .map_err(|_| "renderer thread disconnected".to_string())?;
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err("renderer not attached".to_string());
        }
        thread::sleep(Duration::from_millis(20));
    }
}


pub(crate) fn state_snapshot(state: &Live2DOverlayState) -> serde_json::Value {
    serde_json::json!({
        "active": true,
        "rect": *state.rect.lock().unwrap(),
        "visible": state.visible.load(Ordering::SeqCst),
        "frameCount": state.frame_count.load(Ordering::SeqCst),
        "targetFps": state.target_fps.load(Ordering::SeqCst),
        "ready": state.model_ready.load(Ordering::SeqCst),
        "windowReady": state.window_ready.load(Ordering::SeqCst),
        "rendererAttached": state.renderer_attached.load(Ordering::SeqCst),
        "starting": state.starting.load(Ordering::SeqCst),
        "character": state.character.lock().unwrap().clone(),
        "modelBounds": *state.model_bounds.lock().unwrap(),
        "mouthLevel": f32::from_bits(state.last_mouth_level.load(Ordering::SeqCst)),
        "mouthMappedValue": f32::from_bits(state.last_mapped_mouth_value.load(Ordering::SeqCst)),
        "surfaceFailures": state.surface_failures.load(Ordering::Relaxed),
        "surfaceRecoveries": state.surface_recoveries.load(Ordering::Relaxed),
        "renderErrors": RENDER_ERROR_COUNT.load(Ordering::Relaxed),
    })
}
