use crate::mutex::RecoverMutex;
use super::*;

pub(crate) fn apply_frame(state: &Arc<Live2DOverlayState>, local_rect: OverlayRect, visible: bool, opacity: Option<u32>, companion: Option<isize>) -> Result<(), String> {
    // A late layout update after Destroy may carry visible=true. It must not
    // reveal an empty overlay or wake the idle command loop at the active FPS.
    let visible = visible && state.model_ready.load(Ordering::SeqCst);
    let Some(hwnd) = state.hwnd.recover_lock().clone().map(|h| h as HWND) else {
        return Err("overlay window not ready".to_string());
    };
    let companion_hwnd = companion.map(|handle| handle as HWND).unwrap_or(std::ptr::null_mut());
    *state.companion_hwnd.recover_lock() = (!companion_hwnd.is_null())
        .then_some(companion_hwnd as isize);
    let (rect, companion_offset) = if companion_hwnd.is_null() {
        (local_rect, None)
    } else {
        if let Some(point) = companion_origin(companion_hwnd) {
            (
                followed_overlay_rect(
                    local_rect,
                    point.x,
                    point.y,
                    (local_rect.x, local_rect.y),
                ),
                Some((local_rect.x, local_rect.y)),
            )
        } else {
            (local_rect, None)
        }
    };
    *state.companion_offset.recover_lock() = companion_offset;
    {
        let mut previous = state.rect.recover_lock();
        if (previous.width, previous.height) != (rect.width, rect.height) {
            *state.alpha_mask.recover_write() = None;
        }
        *previous = rect;
    }
    state.visible.store(visible, Ordering::SeqCst);
    if !visible {
        *state.model_bounds.recover_lock() = None;
        *state.alpha_mask.recover_write() = None;
        state.first_frame_ready.store(false, Ordering::Release);
    }
    let alpha = opacity.unwrap_or(255).min(255);
    state.opacity.store(alpha, Ordering::SeqCst);
    // Per-pixel alpha is supplied by the premultiplied DComp surface. A global
    // frame alpha would require multiplying every renderer output, which is
    // outside the allowed overlay files; retain the value for API/state
    // compatibility but intentionally do not apply it with layered-window APIs.
    if visible {
        place_overlay(state, hwnd, companion_hwnd, rect);
    } else {
        unsafe { ShowWindow(hwnd, SW_HIDE); }
    }
    Ok(())
}

pub(super) fn place_overlay(state: &Live2DOverlayState, hwnd: HWND, companion: HWND, rect: OverlayRect) {
    let on_desktop = state.revealed.load(Ordering::Acquire) && state.first_frame_ready.load(Ordering::Acquire);
    // DirectComposition can present while the window is parked outside the
    // virtual desktop. Move it to the pet's client area only with a real frame.
    let (x, y) = if on_desktop { (rect.x, rect.y) } else { (-32_000, -32_000) };
    unsafe {
        SetWindowPos(hwnd, companion, x, y, rect.width as i32, rect.height as i32, SWP_NOACTIVATE | SWP_SHOWWINDOW);
    }
}

pub(crate) fn set_revealed(state: &Live2DOverlayState, revealed: bool) {
    state.revealed.store(revealed, Ordering::Release);
    let hwnd = *state.hwnd.recover_lock();
    let Some(hwnd) = hwnd.map(|value| value as HWND) else { return; };
    if revealed && state.visible.load(Ordering::Acquire) && state.first_frame_ready.load(Ordering::Acquire) {
        let companion = state.companion_hwnd.recover_lock().unwrap_or(0) as HWND;
        let rect = *state.rect.recover_lock();
        place_overlay(state, hwnd, companion, rect);
    } else if !revealed {
        unsafe { ShowWindow(hwnd, SW_HIDE); }
    }
}

/// 发送意图命令并等待渲染线程接收（IPC 同步命令的通道建立）。
pub(crate) fn send_command(state: &Arc<Live2DOverlayState>, cmd: OverlayCommand) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if state.shutdown.load(Ordering::Acquire) {
            return Err("renderer is shutting down".into());
        }
        let tx = state.cmd_tx.recover_lock().clone();
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
    let display_hz = state.display_hz.load(Ordering::Relaxed);
    serde_json::json!({
        "active": true,
        "rect": *state.rect.recover_lock(),
        "visible": state.visible.load(Ordering::SeqCst),
        "frameCount": state.frame_count.load(Ordering::SeqCst),
        "targetFps": state.target_fps.load(Ordering::Relaxed),
        "displayRefreshHz": display_hz,
        "renderSuspended": state.render_suspended.load(Ordering::Relaxed),
        "ready": state.model_ready.load(Ordering::SeqCst),
        "windowReady": state.window_ready.load(Ordering::SeqCst),
        "rendererAttached": state.renderer_attached.load(Ordering::SeqCst),
        "starting": state.starting.load(Ordering::SeqCst),
        "character": state.character.recover_lock().clone(),
        "modelBounds": *state.model_bounds.recover_lock(),
        "mouthLevel": f32::from_bits(state.last_mouth_level.load(Ordering::SeqCst)),
        "mouthMappedValue": f32::from_bits(state.last_mapped_mouth_value.load(Ordering::SeqCst)),
        "surfaceFailures": state.surface_failures.load(Ordering::Relaxed),
        "surfaceRecoveries": state.surface_recoveries.load(Ordering::Relaxed),
        "renderErrors": RENDER_ERROR_COUNT.load(Ordering::Relaxed),
    })
}
