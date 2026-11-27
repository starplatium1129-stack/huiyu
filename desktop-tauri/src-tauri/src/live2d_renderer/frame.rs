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
    // Route Win32 SetWindowPos/ShowWindow to the HWND-owning overlay thread so
    // non-owner threads never hold locks across synchronous cross-thread sends.
    if send_command(state, OverlayCommand::SyncPlacement { check_order: false }).is_err() && !visible {
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::ShowWindowAsync(hwnd, SW_HIDE);
        }
    }
    Ok(())
}

pub(super) fn place_overlay(
    state: &Live2DOverlayState, hwnd: HWND, companion: HWND, mut rect: OverlayRect, check_order: bool,
) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindow, GW_HWNDPREV, SWP_NOMOVE, SWP_NOZORDER,
    };
    let mut previous = state.placement.recover_lock();
    if !state.visible.load(Ordering::Acquire) {
        return;
    }
    let on_desktop = state.revealed.load(Ordering::Acquire) && state.first_frame_ready.load(Ordering::Acquire);
    // DirectComposition presents while parked. Reveal the visual only with a real frame.
    if !on_desktop { (rect.x, rect.y) = (-32_000, -32_000); }
    let moved = previous.is_none_or(|(_, old)| (old.x, old.y) != (rect.x, rect.y));
    let resized = previous.is_none_or(|(_, old)| (old.width, old.height) != (rect.width, rect.height));
    let reorder = previous.is_none_or(|(old, _)| old != companion as isize)
        || (check_order && !companion.is_null() && unsafe { GetWindow(hwnd, GW_HWNDPREV) } != companion);
    if !(moved || resized || reorder) { return; }
    let mut flags = SWP_NOACTIVATE;
    if !moved { flags |= SWP_NOMOVE; }
    if !resized { flags |= SWP_NOSIZE; }
    if !reorder { flags |= SWP_NOZORDER; }
    if previous.is_none() { flags |= SWP_SHOWWINDOW; }
    let placed = unsafe {
        SetWindowPos(hwnd, companion, rect.x, rect.y, rect.width as i32, rect.height as i32, flags)
    };
    if placed != 0 {
        *previous = Some((companion as isize, rect));
    }
}

pub(super) fn hide_overlay(state: &Live2DOverlayState, hwnd: HWND) {
    let mut placement = state.placement.recover_lock();
    if placement.take().is_some() || unsafe { windows_sys::Win32::UI::WindowsAndMessaging::IsWindowVisible(hwnd) } != 0 {
        unsafe { ShowWindow(hwnd, SW_HIDE); }
    }
}

pub(crate) fn set_revealed(state: &Live2DOverlayState, revealed: bool) {
    state.revealed.store(revealed, Ordering::Release);
    if !revealed {
        state.visible.store(false, Ordering::Release);
    }
    let hwnd = *state.hwnd.recover_lock();
    let Some(hwnd) = hwnd.map(|value| value as HWND) else { return; };
    let dispatched = !state.shutdown.load(Ordering::Acquire)
        && state.cmd_tx.recover_lock().as_ref().is_some_and(|tx| {
            tx.send(OverlayCommand::SyncPlacement { check_order: revealed }).is_ok()
        });
    if !dispatched && !revealed {
        unsafe {
            windows_sys::Win32::UI::WindowsAndMessaging::ShowWindowAsync(hwnd, SW_HIDE);
        }
    }
}

/// 发送意图命令并等待渲染线程接收（IPC 同步命令的通道建立）。
pub(crate) fn send_command(state: &Arc<Live2DOverlayState>, cmd: OverlayCommand) -> Result<(), String> {
    if state.shutdown.load(Ordering::Acquire) {
        return Err("renderer is shutting down".into());
    }
    state.cmd_tx.recover_lock().as_ref().ok_or("renderer not attached")?
        .send(cmd).map_err(|_| "renderer thread disconnected".into())
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
