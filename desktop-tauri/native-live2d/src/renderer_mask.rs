//! Full-resolution single-channel mask allocation and diagnostic readback.
use super::*;

impl Renderer {
    pub(super) fn ensure_mask_resource(&mut self, channel_index: usize, width: u32, height: u32) {
        let needs_new = self
            .model_cache
            .as_ref()
            .and_then(|cache| cache.channels.get(channel_index))
            .and_then(|channel| channel.gpu.as_ref())
            .map(|gpu| gpu.width != width || gpu.height != height)
            .unwrap_or(true);
        if !needs_new {
            return;
        }
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("live2d-mask"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: MASK_TEXTURE_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
            view_formats: &[],
        });
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("live2d-mask-bg"),
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
        let cache = self.model_cache.as_mut().expect("model GPU cache");
        cache.channels[channel_index].gpu = Some(MaskGpuResources {
            _texture: texture,
            view,
            bind_group,
            width,
            height,
        });
        self.resource_stats.mask_textures_created += 1;
        self.resource_stats.mask_bind_groups_created += 1;
        self.record_resource_creation_n(2);
    }

    /// Render a mask channel to a CPU buffer for debugging.
    pub fn dump_mask_channel(
        &mut self,
        model: &Model,
        transform: &ViewTransform,
        textures: &[Texture],
        width: u32,
        height: u32,
        mask_set: &[i32],
    ) -> Option<Vec<u8>> {
        if mask_set.is_empty() {
            return None;
        }
        let drawables = model.drawables();
        let mut key = mask_set.to_vec();
        key.sort_unstable();
        let options = RenderOptions::from_env();
        self.ensure_model_cache(model, textures, &drawables);
        self.prewarm_model_resources(&drawables, options.uv_flipped, width, height);
        let selected: Vec<usize> = drawables
            .iter()
            .enumerate()
            .filter_map(|(drawable_index, d)| key.contains(&d.index).then_some(drawable_index))
            .collect();
        for &drawable_index in &selected {
            self.ensure_geometry(&drawables[drawable_index], options.uv_flipped);
        }
        let mut geometry_needed = vec![false; drawables.len()];
        for &drawable_index in &selected {
            geometry_needed[drawable_index] = true;
        }
        let uniform_values: Vec<Uniforms> = selected
            .iter()
            .map(|&drawable_index| {
                make_uniform(
                    &drawables[drawable_index],
                    transform,
                    false,
                    false,
                    width,
                    height,
                    0.0,
                    false,
                )
            })
            .collect();
        self.ensure_uniform_cache(uniform_values.len());
        let (position_uploads, uniform_upload) =
            self.prepare_dynamic_uploads(&drawables, &geometry_needed, &uniform_values);

        let mask_tex = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("live2d-mask-dump"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: MASK_TEXTURE_FORMAT,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let mask_view = mask_tex.create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("live2d-mask-dump-encoder"),
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
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("live2d-mask-dump-pass"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &mask_view,
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
            let cache = self.model_cache.as_ref().expect("model GPU cache");
            let uniform = self.uniform_cache.as_ref().expect("uniform cache");
            for (slot, &drawable_index) in selected.iter().enumerate() {
                let d = &drawables[drawable_index];
                let geometry = cache.geometry[drawable_index]
                    .as_ref()
                    .expect("mask geometry");
                let bind = &cache.color_bind_groups[d.texture_index as usize];
                pass.set_bind_group(0, bind, &[]);
                pass.set_bind_group(
                    2,
                    &uniform.bind_group,
                    &[(slot as u64 * UNIFORM_STRIDE) as u32],
                );
                pass.set_vertex_buffer(0, geometry.positions.slice(..));
                pass.set_vertex_buffer(1, geometry.uvs.slice(..));
                pass.set_index_buffer(geometry.indices.slice(..), wgpu::IndexFormat::Uint16);
                pass.draw_indexed(0..d.indices.len() as u32, 0, 0..1);
            }
        }

        let row_size = width;
        let padded_row = row_size.div_ceil(256) * 256;
        let readback = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("live2d-mask-dump-readback"),
            size: (padded_row as u64) * (height as u64),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &mask_tex,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &readback,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_row),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit(std::iter::once(encoder.finish()));
        let slice = readback.slice(..);
        let (tx, rx) = std::sync::mpsc::channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = tx.send(result);
        });
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .expect("mask readback device poll failed");
        rx.recv()
            .expect("map channel")
            .expect("map readback failed");
        let mapped = slice.get_mapped_range();
        // Preserve the diagnostic API's RGBA output although GPU storage is R8.
        let data = expand_mask_readback(&mapped, width, height, padded_row);
        drop(mapped);
        Some(data)
    }
}

pub(super) fn expand_mask_readback(
    bytes: &[u8],
    width: u32,
    height: u32,
    padded_row: u32,
) -> Vec<u8> {
    let mut rgba = Vec::with_capacity(width as usize * height as usize * 4);
    for row in bytes
        .chunks_exact(padded_row as usize)
        .take(height as usize)
    {
        for &coverage in &row[..width as usize] {
            rgba.extend_from_slice(&[255, 255, 255, coverage]);
        }
    }
    rgba
}
