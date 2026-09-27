use super::*;

pub(super) fn handle_command(
    state: &Arc<Live2DOverlayState>,
    context: &mut Option<RenderContext>,
    assets_root: &std::path::Path,
    local_root: Option<&std::path::Path>,
    app: Option<&RendererEvents>,
    hwnd: HWND,
    cmd: OverlayCommand,
) {
    match cmd {
        OverlayCommand::Shutdown => state.shutdown.store(true, Ordering::SeqCst),
        OverlayCommand::SetMaxFps(fps) => state.target_fps.store(fps.clamp(1, 1000), Ordering::SeqCst),
        OverlayCommand::Destroy { reply } => {
            clear_model_state(state);
            state.visible.store(false, Ordering::SeqCst);
            unsafe { ShowWindow(hwnd, SW_HIDE); }
            release_context(context);
            state.surface_failures.store(0, Ordering::Relaxed);
            state.surface_recoveries.store(0, Ordering::Relaxed);
            // Keep HWND and command channel, but release the device and its pools.
            // A subsequent SetCharacter recreates the GPU context on demand.
            let _ = reply.send(());
        }
        cmd => {
            if context.is_none() && matches!(&cmd, OverlayCommand::SetCharacter { .. }) {
                match RenderContext::new() {
                    Ok(ctx) => *context = Some(ctx),
                    Err(error) => { reply_without_model(cmd, error); return; }
                }
            }
            if let Some(ctx) = context.as_mut() {
                if !handle_model_command(state, ctx, assets_root, local_root, app, hwnd, cmd) {
                    release_context(context);
                }
            } else {
                reply_without_model(cmd, "model not loaded".into());
            }
        }
    }
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
        | OverlayCommand::Snapshot { reply, .. } => { let _ = reply.send(Err(error)); }
        OverlayCommand::HitTest { reply, .. } => { let _ = reply.send(Ok(Vec::new())); }
        // Frame inputs arriving after unload are stale and must not allocate a device.
        _ => {}
    }
}

/// False means a failed load: even a partially constructed GPU context is discarded.
fn handle_model_command(
    state: &Arc<Live2DOverlayState>,
    ctx: &mut RenderContext,
    assets_root: &std::path::Path,
    local_root: Option<&std::path::Path>,
    app: Option<&RendererEvents>,
    hwnd: HWND,
    cmd: OverlayCommand,
) -> bool {
    match cmd {
        OverlayCommand::SetCharacter { character, texture_scale, adapter, reply } => {
            clear_model_state(state);
            ctx.mouth_level = 0.0;
            state.visible.store(false, Ordering::SeqCst);
            unsafe {
                ShowWindow(hwnd, SW_HIDE);
            }
            let result = (|| {
                ctx.ensure_surface(hwnd)?;
                ctx.load_model(assets_root, &character, texture_scale, adapter, local_root)?;
                ctx.start_initial_motion(app)
            })();
            // Also release staging after a partially failed load.
            if let Some(renderer) = ctx.renderer.as_mut() {
                renderer.release_texture_uploads();
            }
            if result.is_ok() {
                *state.character.lock().unwrap() = Some(character.clone());
                state.model_ready.store(true, Ordering::SeqCst);
                if !ctx.ready_emitted {
                    ctx.ready_emitted = true;
                    if let Some(app) = app {
                        let _ = app.emit("aics:live2d:ready", ());
                    }
                }
            }
            let loaded = result.is_ok();
            let _ = reply.send(result);
            return loaded;
        }
        OverlayCommand::PlayMotion {
            group,
            index,
            priority,
            reply,
        } => {
            let result = (|| -> Result<i32, String> {
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
            match &result {
                Ok(index) => {
                    RenderContext::emit_motion_started(app, &group, *index);
                }
                Err(reason) => {
                    if let Some(app) = app {
                        let _ = app.emit(
                            "aics:live2d:motion-failed",
                            serde_json::json!({ "group": group, "index": index, "reason": reason }),
                        );
                    }
                }
            }
            let _ = reply.send(result.map(|_| ()));
        }
        OverlayCommand::SetExpression { name, reply } => {
            let result = (|| -> Result<(), String> {
                let model = ctx.model.as_mut().ok_or("model not loaded")?;
                model
                    .start_expression(&name, model::PRIORITY_FORCE)
                    .ok_or_else(|| format!("expression {name} not found"))?;
                Ok(())
            })();
            let _ = reply.send(result);
        }
        OverlayCommand::SetMouthLevel(level) => {
            let normalized = level.clamp(0.0, 1.0);
            let mapped = ctx.profile.as_ref()
                .and_then(|profile| profile.mouth_value(normalized).map(|(_, value)| value))
                .unwrap_or(0.0);
            ctx.mouth_level = normalized;
            state
                .last_mouth_level
                .store(normalized.to_bits(), Ordering::SeqCst);
            state
                .last_mapped_mouth_value
                .store(mapped.to_bits(), Ordering::SeqCst);
        }
        OverlayCommand::SetEmotion { name, intensity } => {
            ctx.emotion = Some((name, intensity.clamp(0.0, 1.0)));
        }
        OverlayCommand::SetGaze(x, y) => {
            ctx.gaze = (x.clamp(-1.0, 1.0), y.clamp(-1.0, 1.0));
        }
        OverlayCommand::HitTestAsync { x, y } => {
            let rect = *state.rect.lock().unwrap();
            let areas = ctx.hit_test(rect, *state.framing.lock().unwrap(), x, y);
            *state.hit_test_result.lock().unwrap() = Some(areas.clone());
            if let Some(app) = app {
                let _ = app.emit("aics:live2d:hit-test", areas);
            }
        }
        OverlayCommand::HitTest { x, y, reply } => {
            let rect = *state.rect.lock().unwrap();
            let areas = ctx.hit_test(rect, *state.framing.lock().unwrap(), x, y);
            *state.hit_test_result.lock().unwrap() = Some(areas.clone());
            let _ = reply.send(Ok(areas));
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
            let _ = reply.send(result);
        }
        OverlayCommand::Shutdown | OverlayCommand::SetMaxFps(_) | OverlayCommand::Destroy { .. } => unreachable!(),
    }
    true
}
