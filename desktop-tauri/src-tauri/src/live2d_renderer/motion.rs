use super::*;

impl RenderContext {
    /// 每帧意图应用（口型/情绪/凝视）+ 模型 update。
    pub(super) fn step(&mut self, dt: f32) {
        let Some(model) = self.model.as_mut() else {
            return;
        };
        model.update(dt);
        // 覆写参数必须在 UpdateMotion 之后：动作曲线每帧写回参数，
        // 先写会被动作覆盖（实测 TapHead 播放中口型始终为动作姿态）。
        if let (Some(profile), Some((name, intensity))) = (self.profile.as_ref(), self.emotion.clone()) {
            profile.apply_emotion(model, &name, intensity);
        }
        if let Some((param, value)) = self.profile.as_ref().and_then(|profile| profile.mouth_value(self.mouth_level)) {
            if model.parameter_index(param).is_some() {
                model.set_parameter(param, value, 0.7);
            }
        }
        let (gx, gy) = self.gaze;
        if gx != 0.0 || gy != 0.0 {
            let focus = self.profile.as_ref().map(|profile| profile.focus.as_slice()).unwrap_or_default();
            for (id, value, weight) in [
                ("ParamAngleX", 30.0 * gx, 0.6), ("ParamAngleY", 30.0 * gy, 0.6),
                ("ParamEyeBallX", gx, 0.8), ("ParamEyeBallY", gy, 0.8),
            ] {
                if focus.iter().any(|candidate| candidate == id) {
                    model.set_parameter(id, value, weight);
                }
            }
        }
        // 覆盖式眨眼（2026-08-16 眼睛灰修复）：作者 Idle 眼曲线长期闭/半闭
        // 且左右眼不同步，native 无覆写时眼睛灰暗无神。与浏览器 blinkScheduler
        // 对齐：双眼每帧写同一值（1=睁、0=闭，weight 1 压过动作曲线）；
        // 登场（Start 组）期间暂停——作者登场眼曲线左右同步且含开场闭眼，
        // 原样呈现（对齐前端 entranceUntil 逻辑）。
        let in_entrance = matches!(&self.active_motion, Some(m) if m.phase == MotionPhase::Entrance);
        if !in_entrance {
            let blink_value = self.blink.update(dt);
            for id in self.profile.as_ref().map(|profile| profile.blink.as_slice()).unwrap_or_default() {
                if model.parameter_index(id).is_some() {
                    model.set_parameter(id, blink_value, 1.0);
                }
            }
        }
        // 叠层参数每帧守卫（2026-08-16 静止发灰修复）：Idle 动作 Idle_6 把
        // Param36/37 拉出隐藏态（到 5+），静止时叠层显示 → 眼睛/全身发灰；
        // 点击互动（Tap 动作/复位）拉回隐藏态 → 恢复，回 Idle 又灰。非互动
        // 非登场期间每帧强制写回隐藏态（0/-1 分组，与 reset_overlay_params
        // 同表）——叠层只允许在互动/登场动作播放时显示。
        // 2026-08-23 换装闪回修复：动作结束后的回落改为 smoothstep 缓动
        // （step_overlay_settle），回落期间跳过硬性守卫；回落结束恢复守卫。
        // 原单帧硬写会让换装部件一帧内消失/回穿（桌宠实机"闪一下"）。
        let interaction_playing = matches!(
            &self.active_motion,
            Some(m) if m.phase == MotionPhase::Interaction || m.phase == MotionPhase::Entrance
        );
        if !interaction_playing {
            let settling = self.overlay_settler.as_mut().is_some_and(|settler| settler.step(model, dt));
            if !settling {
                self.overlay_settler = None;
                if let Some(config) = self.profile.as_ref().and_then(|profile| profile.overlay_settle.as_ref()) {
                    apply_overlay_defaults(model, config);
                }
            }
        }
    }

    pub(super) fn next_motion_index(&mut self, group: &str, requested: Option<i64>) -> Result<i32, String> {
        let count = self.motion_counts.get(group).copied().unwrap_or(0);
        if count == 0 {
            return Err(format!("motion group {group} not found"));
        }
        if let Some(index) = requested {
            if index < 0 || index as usize >= count {
                return Err(format!("motion {group}[{index}] not found"));
            }
            return Ok(index as i32);
        }

        // A small deterministic PRNG keeps selection varied without depending on
        // a shared global RNG from the render thread. Avoid repeating the same
        // variant when a group has more than one authored motion.
        let mut seed = self.motion_seed;
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        self.motion_seed = seed;
        let mut index = (seed % count as u64) as usize;
        if count > 1 && self.motion_last_indices.get(group) == Some(&index) {
            index = (index + 1) % count;
        }
        self.motion_last_indices.insert(group.to_string(), index);
        Ok(index as i32)
    }

    pub(super) fn start_motion(
        &mut self,
        group: &str,
        requested: Option<i64>,
        priority: i32,
        phase: MotionPhase,
    ) -> Result<i32, String> {
        let index = self.next_motion_index(group, requested)?;
        let model = self.model.as_mut().ok_or("model not loaded")?;
        let handle = model
            .start_motion(group, index, priority)
            .ok_or_else(|| format!("motion {group}[{index}] not found"))?;
        let remaining_seconds = if phase == MotionPhase::Idle {
            Some(
                self.motion_durations
                    .get(group)
                    .and_then(|durations| durations.get(index as usize))
                    .copied()
                    .unwrap_or(5.0),
            )
        } else {
            None
        };
        self.active_motion = Some(ActiveMotion {
            handle,
            phase,
            group: group.to_string(),
            index,
            remaining_seconds,
        });
        Ok(index)
    }

    pub(super) fn emit_motion_started(app: Option<&RendererEvents>, group: &str, index: i32) {
        if let Some(app) = app {
            let _ = app.emit(
                "aics:live2d:motion-started",
                serde_json::json!({ "group": group, "index": index }),
            );
        }
    }

    pub(super) fn start_idle_motion(&mut self, app: Option<&RendererEvents>) {
        if !self.motion_counts.contains_key("Idle") {
            return;
        }
        match self.start_motion("Idle", None, model::PRIORITY_IDLE, MotionPhase::Idle) {
            Ok(index) => Self::emit_motion_started(app, "Idle", index),
            Err(error) => eprintln!("[live2d] idle motion failed: {error}"),
        }
    }

    pub(super) fn start_initial_motion(&mut self, app: Option<&RendererEvents>) -> Result<(), String> {
        let entrance_group = self.profile.as_ref().and_then(|profile| profile.entrance_group.clone());
        if let Some(group) = entrance_group.filter(|group| self.motion_counts.contains_key(group)) {
            let index = self.start_motion(&group, None, model::PRIORITY_NORMAL, MotionPhase::Entrance)?;
            Self::emit_motion_started(app, &group, index);
        } else {
            if let Some(app) = app {
                let _ = app.emit("aics:live2d:entrance-finished", ());
            }
            self.start_idle_motion(app);
        }
        Ok(())
    }

    pub(super) fn advance_motion(&mut self, dt: f32, app: Option<&RendererEvents>) {
        if let Some(active) = self.active_motion.as_mut() {
            if let Some(remaining) = active.remaining_seconds.as_mut() {
                *remaining = (*remaining - dt).max(0.0);
            }
        }
        let Some(active) = self.active_motion.as_ref() else {
            return;
        };
        let finished = active
            .remaining_seconds
            .map(|remaining| remaining <= 0.0)
            .unwrap_or_else(|| {
                self.model
                    .as_ref()
                    .map(|model| model.is_finished(active.handle))
                    .unwrap_or(true)
            });
        if !finished {
            return;
        }
        let phase = active.phase;
        self.active_motion = None;
        if phase == MotionPhase::Entrance {
            if let Some(app) = app {
                let _ = app.emit("aics:live2d:entrance-finished", ());
            }
        }
        // 夏目互动/登场动作结束后回落叠层与换装参数：Tap* 驱动它们而 Idle
        // 不覆盖，不复位则叠层残留（2026-08-15 实机缺陷，见
        // docs/live2d-natsume-overlay-research.md）。回落为 smoothstep 缓动
        // 而非单帧硬写——硬写曾让换装部件一帧内消失回穿（2026-08-23 桌宠
        // 实机"换装闪回"反馈）。回落期间 step() 跳过硬性隐藏守卫，结束后
        // 恢复（防 Idle_6 拉灰）。Idle→Idle 轮换参数本就处于隐藏态，无需回落。
        if matches!(phase, MotionPhase::Interaction | MotionPhase::Entrance) {
            let config = self.profile.as_ref().and_then(|profile| profile.overlay_settle.as_ref());
            if let (Some(model), Some(config)) = (self.model.as_ref(), config) {
                self.overlay_settler = OverlaySettler::begin(model, config);
            }
        }
        self.start_idle_motion(app);
    }
}
