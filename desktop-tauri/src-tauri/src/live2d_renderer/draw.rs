use super::*;

impl RenderContext {
    pub(super) fn render_frame(
        &mut self,
        state: &Live2DOverlayState,
        hwnd: HWND,
        rect: OverlayRect,
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
        // 2x 超采样（对齐浏览器 wl-live2d resolution:2）：模型按两倍渲染尺寸
        // 拟合到离屏目标，再线性降采样回 surface——边缘 SSAA + 纹理细节翻倍。
        // 环境变量 L2D_SUPERSAMPLE=0 可关闭（诊断/低配）。
        let supersample = std::env::var("L2D_SUPERSAMPLE")
            .map(|v| v != "0")
            .unwrap_or(true);
        let (rw, rh) = if supersample {
            (
                (rect.width as f32 * 2.0).max(1.0),
                (rect.height as f32 * 2.0).max(1.0),
            )
        } else {
            (rect.width as f32, rect.height as f32)
        };
        let transform = state.framing.lock().unwrap().transform(bounds, rw, rh);
        let (min_x, min_y) = transform.canvas_to_screen(bounds.0[0], bounds.0[1], rw, rh);
        let (max_x, max_y) = transform.canvas_to_screen(bounds.1[0], bounds.1[1], rw, rh);
        // 诊断边界换算回显示空间（超采样渲染是 rw/rh 上的坐标）。
        let disp_scale = if supersample { 2.0 } else { 1.0 };
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
        *state.model_bounds.lock().unwrap() = Some(OverlayRect {
            x: clamp_x,
            y: clamp_y,
            width: clamp_w,
            height: clamp_h,
        });
        let model = self.model.as_ref().ok_or("no model")?;
        let renderer = self.renderer.as_mut().ok_or("no renderer")?;
        let encoder = renderer.draw_frame(
            model,
            &transform,
            &self.textures,
            &view,
            rect.width,
            rect.height,
            false,
            None,
            supersample,
        );
        let _ = self.queue.submit(std::iter::once(encoder.finish()));
        frame.present();
        Ok(true)
    }

    /// 归一化坐标（0..1，overlay 相对）→ 作者 HitArea 命中。
    /// 超采样开启时渲染空间是 2x 离屏目标，命中映射必须换算到同一空间。
    pub(super) fn hit_test(&self, rect: OverlayRect, framing: crate::live2d_framing::StageFraming, nx: f32, ny: f32) -> Vec<String> {
        let Some(model) = self.model.as_ref() else {
            return vec![];
        };
        if rect.width == 0 || rect.height == 0 {
            return vec![];
        }
        let supersample = std::env::var("L2D_SUPERSAMPLE")
            .map(|v| v != "0")
            .unwrap_or(true);
        let (rw, rh) = if supersample {
            (rect.width as f32 * 2.0, rect.height as f32 * 2.0)
        } else {
            (rect.width as f32, rect.height as f32)
        };
        let Some(bounds) = self.fit_bounds else { return vec![]; };
        let transform = framing.transform(bounds, rw, rh);
        let (canvas_x, canvas_y) = transform.screen_to_canvas(
            nx * rw,
            ny * rh,
            rw,
            rh,
        );
        // 作者 HitArea id 表：由 setCharacter 时解析 model3.json 缓存。
        // 当前返回命中 id 列表（空 = 未命中或模型未加载）。
        let hit_ids = self.hit_area_ids();
        let mut areas = Vec::new();
        if std::env::var("L2D_DEBUG_HIT").is_ok() {
            eprintln!("[hit] rect={rect:?}");
            eprintln!(
                "[hit] bounds_min={:?} bounds_max={:?} scale={} canvas=({canvas_x:.3},{canvas_y:.3})",
                bounds.0, bounds.1, transform.scale
            );
        }
        for id in &hit_ids {
            if model.hit_test(id, canvas_x, canvas_y) {
                if std::env::var("L2D_DEBUG_HIT").is_ok() {
                    eprintln!("[hit] HIT {id}");
                }
                areas.push(id.clone());
            }
        }
        areas
    }

    /// HitArea 名列表：setCharacter 时从 model3.json HitAreas 动态解析（宁宁/夏目通用），
    /// 空列表 = 模型未加载。
    pub(super) fn hit_area_ids(&self) -> Vec<String> {
        self.hit_area_names.clone()
    }

}
