//! Model draw ordering and render passes.
use super::*;

mod blit;

impl Renderer {
    /// Render a frame directly into `target_view` and return the encoder. The
    /// caller owns submission and presentation of the returned command buffer.
    ///
    /// With `supersample` the model renders into a 2x offscreen target (SSAA +
    /// crisp texture detail, matching the browser wl-live2d `resolution: 2`
    /// path) and the frame is blitted down into `target_view`.
    pub fn draw_frame(
        &mut self,
        model: &Model,
        transform: &ViewTransform,
        textures: &[Texture],
        target_view: &wgpu::TextureView,
        width: u32,
        height: u32,
        no_mask: bool,
        only_drawable: Option<i32>,
        supersample: bool,
    ) -> wgpu::CommandEncoder {
        self.stats = RenderStats::default();
        let options = RenderOptions::from_env();
        let (rw, rh) = if supersample {
            (
                width.saturating_mul(2).max(1),
                height.saturating_mul(2).max(1),
            )
        } else {
            (width, height)
        };
        if supersample {
            self.ensure_ss_texture(rw, rh);
        }
        let mut drawables = std::mem::take(&mut self.drawables_scratch);
        model.drawables_into(&mut drawables);
        self.ensure_model_cache(model, textures, &drawables, options.uv_flipped);
        let texture_count = self
            .model_cache
            .as_ref()
            .expect("model GPU cache")
            .color_bind_groups
            .len();

        if options.debug_transform {
            let mut max_x = 0f32;
            let mut min_x = 0f32;
            let mut count = 0usize;
            for d in &drawables {
                if !d.visible {
                    continue;
                }
                count += 1;
                for p in &d.positions {
                    max_x = max_x.max(p[0]);
                    min_x = min_x.min(p[0]);
                }
            }
            eprintln!("[dbg] renderer drawables visible={count} x[{min_x:.3},{max_x:.3}]");
        }

        // Mask membership is model-static. Visibility and only-drawable are
        // still evaluated per frame so debug renders preserve old behavior.
        let mut active_channels = std::mem::take(&mut self.active_channels_scratch);
        active_channels.clear();
        if !no_mask {
            let cache = self.model_cache.as_ref().expect("model GPU cache");
            active_channels.extend(cache.channels.iter().enumerate().filter_map(|(index, channel)| {
                channel.members.iter().any(|&member| {
                    drawables.get(member as usize).is_some_and(|d| {
                        d.visible && (d.texture_index as usize) < texture_count
                            && only_drawable.is_none_or(|only| d.index == only)
                    })
                }).then_some(index)
            }));
        }

        let mut order = std::mem::take(&mut self.draw_order_scratch);
        order.clear();
        order.extend(drawables.iter().enumerate().filter_map(|(drawable_index, d)| {
            let only_indices_match = options.only_indices.as_ref()
                .is_none_or(|list| list.contains(&d.index));
            let matches = d.visible
                && (d.texture_index as usize) < texture_count
                && !d.positions.is_empty()
                && !d.indices.is_empty()
                && only_drawable.is_none_or(|only| d.index == only)
                && only_indices_match
                && options.min_opacity.is_none_or(|min| d.opacity >= min)
                && (!options.only_unmasked || d.masks.is_empty());
            matches.then_some(drawable_index)
        }));
        order.sort_unstable_by_key(|&index| (drawables[index].render_order, index));
        if let Some(limit) = options.order_limit {
            order.truncate(limit);
        }
        if options.debug_order {
            let lo = order.len().saturating_sub(8);
            eprintln!(
                "[order] total={} last8={:?}",
                order.len(),
                order
                    .iter()
                    .skip(lo)
                    .map(|&drawable_index| {
                        let d = &drawables[drawable_index];
                        (
                            d.index,
                            d.render_order,
                            d.opacity,
                            d.vertex_count,
                            d.color_blend,
                            d.masks.clone(),
                        )
                    })
                    .collect::<Vec<_>>()
            );
        }

        self.prepare_masks(&active_channels, rw, rh);
        let mut uniform_values = std::mem::take(&mut self.uniform_values_scratch);
        uniform_values.clear();
        for &channel_index in &active_channels {
            let cache = self.model_cache.as_ref().expect("model GPU cache");
            for &drawable_index in &cache.channels[channel_index].mask_indices {
                uniform_values.push(make_uniform(
                    &drawables[drawable_index as usize],
                    transform,
                    false,
                    false,
                    rw,
                    rh,
                    options.x_shift,
                    options.debug_transform,
                ));
            }
        }
        {
            let cache = self.model_cache.as_ref().expect("model GPU cache");
            for &drawable_index in &order {
                let d = &drawables[drawable_index];
                let masked = !no_mask && cache.channel_for_drawable[drawable_index].is_some();
                uniform_values.push(make_uniform(
                    d,
                    transform,
                    masked,
                    masked && d.inverted_mask,
                    rw,
                    rh,
                    options.x_shift,
                    options.debug_transform,
                ));
            }
        }
        self.ensure_uniform_cache(uniform_values.len());
        self.upload_frame(&drawables, &uniform_values);

        // Mask and main passes share one encoder. This preserves pass order but
        // removes one queue submission and all static resource creation per
        // mask channel.
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("live2d-frame-encoder"),
            });
        let cache = self.model_cache.as_ref().expect("model GPU cache");
        let uniform = self.uniform_cache.as_ref().expect("uniform cache");
        let mut uniform_slot = 0usize;
        let mut draw_calls = 0usize;
        let mut total_vertices = 0usize;

        for &channel_index in &active_channels {
            let channel = &cache.channels[channel_index];
            let gpu = channel.gpu.as_ref().expect("mask GPU resource");
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("live2d-mask-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &gpu.view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_pipeline(&self.pipelines.mask);
            pass.set_bind_group(1, &self.white_mask_bg, &[]);
            for &drawable_index in &channel.mask_indices {
                let d = &drawables[drawable_index as usize];
                let geometry = cache.geometry[drawable_index as usize]
                    .as_ref()
                    .expect("mask geometry");
                let color_bind = &cache.color_bind_groups[d.texture_index as usize];
                pass.set_bind_group(0, color_bind, &[]);
                pass.set_bind_group(
                    2,
                    &uniform.bind_group,
                    &[(uniform_slot as u64 * UNIFORM_STRIDE) as u32],
                );
                pass.set_vertex_buffer(0, geometry.position_buffer(&cache.positions));
                pass.set_vertex_buffer(1, geometry.uvs.slice(..));
                pass.set_index_buffer(geometry.indices.slice(..), wgpu::IndexFormat::Uint16);
                pass.draw_indexed(0..d.indices.len() as u32, 0, 0..1);
                uniform_slot += 1;
                draw_calls += 1;
                total_vertices += d.vertex_count;
            }
        }

        {
            let main_view = if supersample {
                self.ss_texture
                    .as_ref()
                    .map(|(_, _, _, view)| view)
                    .expect("supersample target")
            } else {
                target_view
            };
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("live2d-main-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: main_view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });

            let mut last_pipeline = None;
            let mut last_mask = None;
            let mut last_texture = None;
            for &drawable_index in &order {
                let d = &drawables[drawable_index];
                let geometry = cache.geometry[drawable_index].as_ref().expect("main geometry");
                let blend = geometry.blend;
                let channel = if no_mask { None } else { cache.channel_for_drawable[drawable_index] };
                let masked = channel.is_some();
                if last_pipeline != Some((blend, masked)) {
                    let pipelines = if masked { &self.pipelines.masked } else { &self.pipelines.standard };
                    pass.set_pipeline(&pipelines[blend as usize]);
                    last_pipeline = Some((blend, masked));
                }
                if last_mask != Some(channel) {
                    let mask = channel.map_or(&self.white_mask_bg, |index| {
                        &cache.channels[index].gpu.as_ref().expect("mask GPU resource").bind_group
                    });
                    pass.set_bind_group(1, mask, &[]);
                    last_mask = Some(channel);
                }
                if last_texture != Some(d.texture_index) {
                    pass.set_bind_group(0, &cache.color_bind_groups[d.texture_index as usize], &[]);
                    last_texture = Some(d.texture_index);
                }
                pass.set_bind_group(
                    2,
                    &uniform.bind_group,
                    &[(uniform_slot as u64 * UNIFORM_STRIDE) as u32],
                );
                if options.debug_draw91 && d.index == 91 {
                    eprintln!(
                        "[dbg91] idx={} blend={:?} masked={} opacity={:.3} color_blend={} alpha_blend={} multiply={:?} texidx={}",
                        d.index,
                        blend,
                        masked,
                        d.opacity,
                        d.color_blend,
                        d.alpha_blend,
                        d.multiply_color,
                        d.texture_index
                    );
                }
                pass.set_vertex_buffer(0, geometry.position_buffer(&cache.positions));
                pass.set_vertex_buffer(1, geometry.uvs.slice(..));
                pass.set_index_buffer(geometry.indices.slice(..), wgpu::IndexFormat::Uint16);
                pass.draw_indexed(0..d.indices.len() as u32, 0, 0..1);
                uniform_slot += 1;
                draw_calls += 1;
                total_vertices += d.vertex_count;
            }
        }

        if supersample {
            // Downsample the 2x offscreen into the swapchain surface.
            let ss_bg = self.ss_bg.as_ref().expect("supersample bind group");
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("live2d-ss-blit-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target_view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        // 必须是 Clear 而不是 Load：swapchain backbuffer 在配置后、
                        // 尺寸变化后或设备异常期间内容是未定义的，Load 会把上一帧
                        // 残留或显存垃圾原样送到屏幕——就是实机看到的"老电视雪花"。
                        // blit 是全屏三角形 + REPLACE 混合 + write_mask: ALL，正常帧
                        // 下逐像素全通道覆写，Clear 与 Load 的最终像素完全一致，
                        // 只在 blit 绘制被丢弃（资源失效/命令被拒绝）时兜底为透明。
                        // 2026-08-30 桌宠雪花修复。
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
            });
            pass.set_pipeline(&self.ss_pipeline);
            pass.set_bind_group(0, ss_bg, &[]);
            pass.draw(0..3, 0..1);
        }

        self.stats.draw_calls = draw_calls;
        self.stats.mask_textures = active_channels.len();
        self.stats.total_vertices = total_vertices;
        self.drawables_scratch = drawables;
        self.active_channels_scratch = active_channels;
        self.draw_order_scratch = order;
        self.uniform_values_scratch = uniform_values;
        encoder
    }

}

pub(super) fn blend_for(d: &Drawable, force_normal: bool) -> BlendKind {
    if force_normal {
        return BlendKind::Normal;
    }
    match d.color_blend {
        crate::ffi::L2D_COLOR_BLEND_ADD
        | crate::ffi::L2D_COLOR_BLEND_ADD_COMPATIBLE
        | crate::ffi::L2D_COLOR_BLEND_ADD_GLOW => BlendKind::Add,
        crate::ffi::L2D_COLOR_BLEND_MULTIPLY | crate::ffi::L2D_COLOR_BLEND_MULTIPLY_COMPATIBLE => {
            BlendKind::Multiply
        }
        crate::ffi::L2D_COLOR_BLEND_SCREEN => BlendKind::Screen,
        crate::ffi::L2D_COLOR_BLEND_NORMAL => BlendKind::Normal,
        other => {
            eprintln!(
                "[live2d] drawable {} color blend {} unsupported, falling back to Normal",
                d.index,
                crate::model::blend_mode_name(other)
            );
            BlendKind::Normal
        }
    }
}
