//! Frame ordering, passes and supersample target management.
use super::*;

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
        self.resource_stats.frame_creations = 0;
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
        self.ensure_model_cache(model, textures, &drawables);
        self.prewarm_model_resources(&drawables, options.uv_flipped, rw, rh);
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
        let active_channels: Vec<usize> = if no_mask {
            Vec::new()
        } else {
            let cache = self.model_cache.as_ref().expect("model GPU cache");
            cache
                .channels
                .iter()
                .enumerate()
                .filter_map(|(channel_index, channel)| {
                    let active = channel.members.iter().any(|&member| {
                        let Some(d) = drawables.get(member as usize) else {
                            return false;
                        };
                        d.visible
                            && (d.texture_index as usize) < texture_count
                            && only_drawable.map(|only| d.index == only).unwrap_or(true)
                    });
                    active.then_some(channel_index)
                })
                .collect()
        };

        let mut order: Vec<usize> = drawables
            .iter()
            .enumerate()
            .filter_map(|(drawable_index, d)| {
                let only_indices_match = options
                    .only_indices
                    .as_ref()
                    .map(|list| list.iter().any(|&value| value == d.index))
                    .unwrap_or(true);
                let matches = d.visible
                    && (d.texture_index as usize) < texture_count
                    && !d.positions.is_empty()
                    && !d.indices.is_empty()
                    && only_drawable.map(|o| d.index == o).unwrap_or(true)
                    && only_indices_match
                    && options
                        .min_opacity
                        .map(|min| d.opacity >= min)
                        .unwrap_or(true)
                    && (!options.only_unmasked || d.masks.is_empty());
                matches.then_some(drawable_index)
            })
            .collect();
        order.sort_by_key(|&drawable_index| drawables[drawable_index].render_order);
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

        let mut geometry_needed = vec![false; drawables.len()];
        {
            let cache = self.model_cache.as_ref().expect("model GPU cache");
            for &channel_index in &active_channels {
                for &drawable_index in &cache.channels[channel_index].mask_indices {
                    geometry_needed[drawable_index as usize] = true;
                }
            }
            for &drawable_index in &order {
                geometry_needed[drawable_index] = true;
            }
        }
        for (drawable_index, needed) in geometry_needed.iter().copied().enumerate() {
            if needed {
                self.ensure_geometry(&drawables[drawable_index], options.uv_flipped);
            }
        }
        for &channel_index in &active_channels {
            self.ensure_mask_resource(channel_index, rw, rh);
        }

        let mask_uniform_count: usize = {
            let cache = self.model_cache.as_ref().expect("model GPU cache");
            active_channels
                .iter()
                .map(|&channel_index| cache.channels[channel_index].mask_indices.len())
                .sum()
        };
        let mut uniform_values = Vec::with_capacity(mask_uniform_count + order.len());
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
                if masked {
                    cache.channel_for_drawable[drawable_index]
                        .expect("masked drawable has a channel");
                }
            }
        }
        self.ensure_uniform_cache(uniform_values.len());
        let (position_uploads, uniform_upload) =
            self.prepare_dynamic_uploads(&drawables, &geometry_needed, &uniform_values);

        // Mask and main passes share one encoder. This preserves pass order but
        // removes one queue submission and all static resource creation per
        // mask channel.
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("live2d-frame-encoder"),
            });
        if !position_uploads.is_empty() || uniform_upload.is_some() {
            let upload_buffer = self.upload_buffer.as_ref().expect("upload buffer");
            let cache = self.model_cache.as_ref().expect("model GPU cache");
            for &(drawable_index, source_offset, size) in &position_uploads {
                let geometry = cache.geometry[drawable_index]
                    .as_ref()
                    .expect("dynamic geometry");
                encoder.copy_buffer_to_buffer(
                    upload_buffer,
                    source_offset,
                    &geometry.positions,
                    0,
                    size,
                );
            }
            if let Some((source_offset, size)) = uniform_upload {
                let uniform = self.uniform_cache.as_ref().expect("uniform cache");
                encoder.copy_buffer_to_buffer(
                    upload_buffer,
                    source_offset,
                    &uniform.buffer,
                    0,
                    size,
                );
            }
        }
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
                pass.set_vertex_buffer(0, geometry.positions.slice(..));
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

            for &drawable_index in &order {
                let d = &drawables[drawable_index];
                let blend = blend_for(d, options.force_normal_blend);
                let masked = !no_mask && cache.channel_for_drawable[drawable_index].is_some();
                if masked {
                    let channel_index = cache.channel_for_drawable[drawable_index]
                        .expect("masked drawable has a channel");
                    pass.set_pipeline(&self.pipelines.masked[blend as usize]);
                    pass.set_bind_group(
                        1,
                        &cache.channels[channel_index]
                            .gpu
                            .as_ref()
                            .expect("mask GPU resource")
                            .bind_group,
                        &[],
                    );
                } else {
                    pass.set_pipeline(&self.pipelines.standard[blend as usize]);
                    pass.set_bind_group(1, &self.white_mask_bg, &[]);
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
                let geometry = cache.geometry[drawable_index]
                    .as_ref()
                    .expect("main geometry");
                let color_bind = &cache.color_bind_groups[d.texture_index as usize];
                pass.set_bind_group(0, color_bind, &[]);
                pass.set_vertex_buffer(0, geometry.positions.slice(..));
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
        encoder
    }

    /// Lazily create/recreate the 2x supersample offscreen target and its
    /// bind group for the given render size.
    fn ensure_ss_texture(&mut self, width: u32, height: u32) {
        let current = self
            .ss_texture
            .as_ref()
            .map(|(w, h, _, _)| (*w, *h))
            .unwrap_or((0, 0));
        if current == (width, height) {
            return;
        }
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("live2d-ss-target"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: self.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("live2d-ss-bg"),
            layout: &self.tex_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        });
        self.ss_texture = Some((width, height, texture, view));
        self.ss_bg = Some(bind_group);
        self.resource_stats.textures_created += 1;
        self.record_resource_creation();
    }
}

fn blend_for(d: &Drawable, force_normal: bool) -> BlendKind {
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
