use super::*;

pub(super) fn handle_command(
    state: &Arc<Live2DOverlayState>,
    ctx: &mut RenderContext,
    assets_root: &std::path::Path,
    local_root: Option<&std::path::Path>,
    app: Option<&RendererEvents>,
    hwnd: HWND,
    cmd: OverlayCommand,
) {
    match cmd {
        OverlayCommand::Shutdown => { state.shutdown.store(true, Ordering::SeqCst); },
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
            let _ = reply.send(result);
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
        OverlayCommand::SetMaxFps(fps) => {
            state.target_fps.store(fps.clamp(1, 1000), Ordering::SeqCst);
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
        OverlayCommand::Destroy { reply } => {
            if let Some(renderer) = ctx.renderer.as_mut() {
                renderer.release_model_resources();
            }
            ctx.model = None;
            ctx.textures.clear();
            ctx.character = None;
            ctx.profile = None;
            ctx.overlay_settler = None;
            ctx.hit_area_names.clear();
            ctx.motion_counts.clear();
            ctx.motion_durations.clear();
            ctx.motion_last_indices.clear();
            ctx.active_motion = None;
            ctx.mouth_level = 0.0;
            // destroy 契约：只清模型级状态，保留渲染线程与窗口（长期复用）。
            // 前端 destroy 后仍可 setCharacter 重新加载；线程退出路径
            // （窗口销毁/通道断开/致命错误）才广播 aics:live2d:stopped。
            clear_model_state(state);
            state.visible.store(false, Ordering::SeqCst);
            unsafe { ShowWindow(hwnd, SW_HIDE); }
            let _ = reply.send(());
        }
    }
}
