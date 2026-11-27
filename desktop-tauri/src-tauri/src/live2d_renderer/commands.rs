use crate::mutex::RecoverMutex;
use super::*;

pub(super) fn handle_command(
    state: &Arc<Live2DOverlayState>,
    context: &mut Option<RenderContext>,
    environment: &RendererEnvironment,
    hwnd: HWND,
    cmd: OverlayCommand,
) {
    if state.shutdown.load(Ordering::Acquire) {
        return;
    }
    match cmd {
        OverlayCommand::Shutdown => state.shutdown.store(true, Ordering::SeqCst),
        OverlayCommand::SetMaxFps(fps) => state.fps_limit.store(fps.min(1000), Ordering::Relaxed),
        OverlayCommand::Destroy { reply } => {
            unload_model(state, context, hwnd);
            reply.send(());
        }
        OverlayCommand::ReleaseHidden => {
            if !state.revealed.load(Ordering::Acquire) {
                unload_model(state, context, hwnd);
            }
        }
        OverlayCommand::SyncPlacement { check_order } => {
            if state.visible.load(Ordering::Acquire) && context.is_some() {
                let companion = state.companion_hwnd.recover_lock().unwrap_or(0) as HWND;
                let rect = *state.rect.recover_lock();
                frame::place_overlay(state, hwnd, companion, rect, check_order);
            } else {
                frame::hide_overlay(state, hwnd);
            }
        }
        cmd => {
            if context.is_none() && matches!(&cmd, OverlayCommand::SetCharacter { .. }) {
                match RenderContext::new() {
                    Ok(ctx) => *context = Some(ctx),
                    Err(error) => { reply_without_model(cmd, error); return; }
                }
            }
            if let Some(ctx) = context.as_mut() {
                if !handle_model_command(state, ctx, environment, hwnd, cmd) {
                    release_context(context);
                }
            } else {
                reply_without_model(cmd, "model not loaded".into());
            }
        }
    }
}

fn unload_model(state: &Live2DOverlayState, context: &mut Option<RenderContext>, hwnd: HWND) {
    clear_model_state(state);
    state.visible.store(false, Ordering::Release);
    frame::hide_overlay(state, hwnd);
    // Keep the HWND and command channel. SetCharacter recreates the GPU on demand.
    release_context(context);
    state.surface_failures.store(0, Ordering::Relaxed);
    state.surface_recoveries.store(0, Ordering::Relaxed);
}

fn release_context(context: &mut Option<RenderContext>) {
    if let Some(mut ctx) = context.take() {
        if let Some(renderer) = ctx.renderer.as_mut() {
            renderer.release_model_resources();
        }
        // An intentional unload must not emit a device-lost/stopped event.
        ctx.device.set_device_lost_callback(|_, _| {});
        ctx.device.destroy();
    }
}

fn reply_without_model(cmd: OverlayCommand, error: String) {
    match cmd {
        OverlayCommand::SetCharacter { reply, .. }
        | OverlayCommand::PlayMotion { reply, .. }
        | OverlayCommand::SetExpression { reply, .. }
        | OverlayCommand::Snapshot { reply, .. } => { reply.send(Err(error)); }
        OverlayCommand::HitTest { reply, .. } => { reply.send(Ok(Vec::new())); }
        // Frame inputs arriving after unload are stale and must not allocate a device.
        _ => {}
    }
}

/// False means a failed load: even a partially constructed GPU context is discarded.
fn handle_model_command(
    state: &Arc<Live2DOverlayState>,
    ctx: &mut RenderContext,
    environment: &RendererEnvironment,
    hwnd: HWND,
    cmd: OverlayCommand,
) -> bool {
    match cmd {
        OverlayCommand::SetCharacter { character, texture_scale, adapter, reply } => {
            clear_model_state(state);
            ctx.alpha_readback = None;
            ctx.mouth_level = 0.0;
            state.visible.store(false, Ordering::SeqCst);
            frame::hide_overlay(state, hwnd);
            let result = (|| {
                ctx.ensure_surface(hwnd)?;
                ctx.load_model(environment, &character, texture_scale, adapter)?;
                ctx.start_initial_motion()
            })();
            // Also release staging after a partially failed load.
            if let Some(renderer) = ctx.renderer.as_mut() {
                renderer.release_texture_uploads();
            }
            if result.is_ok() {
                *state.character.recover_lock() = Some(character.clone());
                state.model_ready.store(true, Ordering::SeqCst);
            }
            let loaded = result.is_ok();
            reply.send(result);
            return loaded;
        }
        OverlayCommand::PlayMotion {
            group,
            index,
            priority,
            reply,
        } => {
            let result = (|| -> Result<(), String> {
                // 同一互动组仍在播放时拒绝重复请求：前端据 motion-failed 的
                // reason 显示"动作进行中"，不能用 force 重启打断自己。
                if would_reject_interaction(ctx.active_motion.as_ref(), &group) {
                    let current = ctx
                        .active_motion
                        .as_ref()
                        .map(|active| active.index)
                        .unwrap_or(0);
                    return Err(format!("motion already playing: {group}[{current}]"));
                }
                let priority = match priority.as_deref() {
                    Some("idle") => model::PRIORITY_IDLE,
                    Some("force") => model::PRIORITY_FORCE,
                    Some("normal") => model::PRIORITY_NORMAL,
                    _ => model::PRIORITY_NORMAL,
                };
                ctx.start_motion(&group, index, priority, MotionPhase::Interaction)
            })();
            if let Err(reason) = &result {
                if let Some(app) = environment.events.as_ref() {
                    let _ = app.emit(
                        "aics:live2d:motion-failed",
                        serde_json::json!({ "group": group, "index": index, "reason": reason }),
                    );
                }
            }
            reply.send(result);
        }
        OverlayCommand::SetExpression { name, reply } => {
            let result = (|| -> Result<(), String> {
                let model = ctx.model.as_mut().ok_or("model not loaded")?;
                model
                    .start_expression(&name, model::PRIORITY_FORCE)
                    .ok_or_else(|| format!("expression {name} not found"))?;
                Ok(())
            })();
            reply.send(result);
        }
        OverlayCommand::SetEmotion { name, intensity } => {
            ctx.emotion = Some((name, intensity.clamp(0.0, 1.0)));
        }
        OverlayCommand::HitTest { x, y, reply } => {
            let areas = ctx.hit_test(state, x, y);
            reply.send(Ok(areas));
        }
        OverlayCommand::Snapshot { path, reply } => {
            let result = (|| -> Result<(), String> {
                let model = ctx.model.as_mut().ok_or("model not loaded")?;
                let renderer = ctx.renderer.as_mut().ok_or("renderer not created")?;
                let bounds = model.content_bounds();
                let transform = ViewTransform::fit_content(bounds, 800.0, 800.0, 0.02);
                let pixels = renderer.render_to_image(
                    model,
                    &transform,
                    &ctx.textures,
                    800,
                    800,
                    false,
                    None,
                );
                let img =
                    image::RgbaImage::from_raw(800, 800, pixels).ok_or("snapshot: bad rgba")?;
                img.save(&path).map_err(|e| format!("snapshot save: {e}"))?;
                Ok(())
            })();
            reply.send(result);
        }
        OverlayCommand::Shutdown
        | OverlayCommand::ReleaseHidden
        | OverlayCommand::SyncPlacement { .. }
        | OverlayCommand::SetMaxFps(_)
        | OverlayCommand::Destroy { .. } => unreachable!(),
    }
    true
}
