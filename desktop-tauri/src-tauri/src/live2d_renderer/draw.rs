use crate::mutex::RecoverMutex;
use super::*;

impl RenderContext {
    pub(super) fn render_frame(
        &mut self,
        state: &Live2DOverlayState,
        hwnd: HWND,
        rect: OverlayRect,
        cursor_near: bool,
    ) -> Result<bool, String> {
        if rect.width == 0 || rect.height == 0 {
            return Ok(false);
        }
        if self.model.is_none() || self.renderer.is_none() {
            return Ok(false);
        }
        if self.surface.is_none() {
            self.ensure_surface(hwnd)?;
            self.configure_surface(rect.width, rect.height);
        }
        if self.last_rect.width != rect.width || self.last_rect.height != rect.height {
            self.configure_surface(rect.width, rect.height);
            self.last_rect = rect;
        }
        let surface = self.surface.as_ref().ok_or("no surface")?;
        let frame = match surface.get_current_texture() {
            Ok(frame) => {
                if self.surface_failures != 0 {
                    self.surface_failures = 0;
                    state.surface_failures.store(0, Ordering::Relaxed);
                }
                frame
            }
            Err(wgpu::SurfaceError::Outdated | wgpu::SurfaceError::Lost) => {
                self.configure_surface(rect.width, rect.height);
                self.surface_failures += 1;
                state
                    .surface_failures
                    .store(self.surface_failures, Ordering::Relaxed);
                if self.surface_failures < SURFACE_FAILURE_LIMIT {
                    return Ok(false);
                }
                // swapchain 卡死：就地丢弃 surface 重建（device 未变，模型纹理
                // 仍有效，只重建 surface + renderer）。此分支没有持有
                // SurfaceTexture，可以安全丢弃。
                eprintln!(
                    "[live2d] surface stuck after {} frames (recovery #{})",
                    self.surface_failures,
                    self.surface_recoveries + 1
                );
                self.reset_surface();
                state.surface_failures.store(0, Ordering::Relaxed);
                state
                    .surface_recoveries
                    .store(self.surface_recoveries, Ordering::Relaxed);
                if self.surface_recoveries >= SURFACE_RECOVERY_LIMIT {
                    return Err(format!(
                        "surface 连续 {} 次重建后仍不可用",
                        self.surface_recoveries
                    ));
                }
                return Ok(false);
            }
            Err(wgpu::SurfaceError::Timeout) => return Ok(false),
            Err(wgpu::SurfaceError::OutOfMemory) => {
                return Err("surface out of memory".to_string());
            }
            Err(e) => return Err(format!("surface error: {e}")),
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let bounds = self.fit_bounds.ok_or("model framing not initialized")?;
        // Full-HD is the offscreen pixel budget. Large physical windows
        // already display fine edges at native resolution.
        static SUPERSAMPLE: std::sync::OnceLock<Option<bool>> = std::sync::OnceLock::new();
        let override_ssaa = SUPERSAMPLE.get_or_init(|| std::env::var("L2D_SUPERSAMPLE").ok().map(|value| value != "0"));
        let budget_allows = u64::from(rect.width) * u64::from(rect.height) <= 1920 * 1080 / 4;
        let max_side = self.device.limits().max_texture_dimension_2d;
        let supersample = override_ssaa.unwrap_or(budget_allows)
            && rect.width.max(rect.height) <= max_side / 2;
        let disp_scale = if supersample { 2.0 } else { 1.0 };
        let (rw, rh) = (rect.width as f32 * disp_scale, rect.height as f32 * disp_scale);
        let framing = *state.framing.recover_lock();
        let transform = framing.transform(bounds, rw, rh);
        let (min_x, min_y) = transform.canvas_to_screen(bounds.0[0], bounds.0[1], rw, rh);
        let (max_x, max_y) = transform.canvas_to_screen(bounds.1[0], bounds.1[1], rw, rh);
        let bx = ((min_x.min(max_x)).floor().max(0.0) / disp_scale) as i32;
        let by = ((min_y.min(max_y)).floor().max(0.0) / disp_scale) as i32;
        let bw = (((max_x - min_x).abs().ceil() as f32) / disp_scale) as u32;
        let bh = (((max_y - min_y).abs().ceil() as f32) / disp_scale) as u32;
        // 诊断边界钳制在 overlay 内；输入事件由上层 WebView 转发，不再用它
        // 裁剪窗口可见区域。
        let clamp_x = (rect.x + bx).clamp(rect.x, rect.x + rect.width as i32);
        let clamp_y = (rect.y + by).clamp(rect.y, rect.y + rect.height as i32);
        let clamp_w = bw.min((rect.x + rect.width as i32 - clamp_x).max(1) as u32);
        let clamp_h = bh.min((rect.y + rect.height as i32 - clamp_y).max(1) as u32);
        *state.model_bounds.recover_lock() = Some(OverlayRect {
            x: clamp_x,
            y: clamp_y,
            width: clamp_w,
            height: clamp_h,
        });
        let model = self.model.as_ref().ok_or("no model")?;
        let renderer = self.renderer.as_mut().ok_or("no renderer")?;
        let capture = self.alpha_readback.get_or_insert_with(|| alpha_mask::MaskReadback::new(&self.device));
        if let Some(mask) = capture.collect(rect, framing) {
            *state.alpha_mask.write().unwrap() = Some(mask);
        }
        let interval = if self.active_motion.as_ref().is_some_and(|motion| motion.phase != MotionPhase::Idle) {
            Duration::from_millis(100)
        } else {
            Duration::from_millis(250)
        };
        let needs_mask = state.alpha_mask.read().unwrap().is_none();
        let captured = capture.capture_target(renderer, rect, self.surface_format, framing, interval, needs_mask, cursor_near);
        let mut encoder = renderer.draw_frame(
            model,
            &transform,
            &self.textures,
            captured.map_or(&view, |target| &target.view),
            rect.width,
            rect.height,
            false,
            None,
            supersample,
        );
        let sampling = captured.is_some();
        if let Some(target) = captured {
            renderer.blit_frame(&mut encoder, &target.blit_bind_group, &view);
            capture.encode(&mut encoder);
        }
        let _ = self.queue.submit(std::iter::once(encoder.finish()));
        if sampling { capture.map(); }
        frame.present();
        Ok(true)
    }

    /// Select the authored interaction only where the presented model is painted.
    pub(super) fn hit_test(&self, state: &Live2DOverlayState, nx: f32, ny: f32) -> Vec<String> {
        let rect = *state.rect.recover_lock();
        if !state.visible.load(Ordering::Acquire) || !(0.0..1.0).contains(&nx) || !(0.0..1.0).contains(&ny) {
            return vec![];
        }
        let framing = *state.framing.recover_lock();
        let (width, height) = (rect.width as f32, rect.height as f32);
        let (x, y) = (nx * width, ny * height);
        if !state.alpha_mask.read().unwrap().as_ref().is_some_and(|mask| mask.hit(rect, framing, x as i32, y as i32)) {
            return vec![];
        }
        let (Some(model), Some(bounds)) = (self.model.as_ref(), self.fit_bounds) else { return vec![]; };
        // Uniform supersampling cancels out when converting normalized input
        // to model coordinates, so this always uses the physical display size.
        let transform = framing.transform(bounds, width, height);
        let (canvas_x, canvas_y) = transform.screen_to_canvas(x, y, width, height);
        self.hit_area_names.iter().filter(|id| model.hit_test(id, canvas_x, canvas_y)).cloned().collect()
    }
}
