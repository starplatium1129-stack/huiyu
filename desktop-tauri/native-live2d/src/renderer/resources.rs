//! Model-owned geometry, masks and reusable upload buffers.
use super::*;

impl Renderer {
    pub(super) fn ensure_model_cache(
        &mut self,
        model: &Model,
        textures: &[Texture],
        drawables: &[Drawable],
        uv_flipped: bool,
    ) {
        let model_id = model.cache_key();
        let texture_source = textures.as_ptr() as usize;
        let rebuild = self.model_cache.as_ref().map_or(true, |cache| {
            cache.model_id != model_id
                || cache.texture_source != texture_source
                || cache.geometry.len() != drawables.len()
                || cache.color_bind_groups.len() != textures.len()
        });
        if !rebuild {
            return;
        }

        // Dropping the old cache before building the new one releases stale
        // mask textures, bind groups and geometry after a character switch.
        self.model_cache = None;
        let (channels, channel_for_drawable) = build_mask_channels(drawables, textures.len());
        let mut color_bind_groups = Vec::with_capacity(textures.len());
        for texture in textures {
            color_bind_groups.push(self.create_color_bind_group(texture));
        }
        let mut vertex_count = 0;
        let geometry = drawables.iter().map(|drawable| {
            if drawable.vertex_count == 0 || drawable.indices.is_empty()
                || drawable.texture_index as usize >= textures.len()
            {
                return None;
            }
            let vertices = vertex_count..vertex_count + drawable.vertex_count;
            vertex_count = vertices.end;
            Some(self.create_geometry(drawable, uv_flipped, vertices))
        }).collect();
        let positions = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("live2d-positions"),
            size: (vertex_count as u64 * VERTEX_STRIDE).max(VERTEX_STRIDE),
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        self.model_cache = Some(ModelGpuCache {
            model_id,
            texture_source,
            geometry,
            positions,
            position_staging: vec![[0.0; 2]; vertex_count],
            mask_size: None,
            channels,
            channel_for_drawable,
            color_bind_groups,
        });
    }

    fn create_geometry(
        &self,
        drawable: &Drawable,
        uv_flipped: bool,
        vertices: Range<usize>,
    ) -> GeometryBuffers {
        use wgpu::util::{BufferInitDescriptor, DeviceExt};
        let uv_data = make_uv_data(drawable, uv_flipped);
        let uvs = self.device.create_buffer_init(&BufferInitDescriptor {
            label: Some("live2d-uvs"),
            contents: bytemuck::cast_slice(&uv_data),
            usage: wgpu::BufferUsages::VERTEX,
        });
        let indices = self.device.create_buffer_init(&BufferInitDescriptor {
            label: Some("live2d-indices"),
            contents: bytemuck::cast_slice(&drawable.indices),
            usage: wgpu::BufferUsages::INDEX,
        });
        let blend = frame::blend_for(drawable, RenderOptions::from_env().force_normal_blend);
        GeometryBuffers { vertices, revision: 0, blend, uvs, indices }
    }

    pub(super) fn prepare_masks(&mut self, channels: &[usize], width: u32, height: u32) {
        let cache = self.model_cache.as_mut().expect("model GPU cache");
        if cache.mask_size != Some((width, height)) {
            for channel in &mut cache.channels {
                channel.gpu = None;
            }
            cache.mask_size = Some((width, height));
        }
        for &index in channels {
            self.ensure_mask_resource(index, width, height);
        }
    }

    pub(super) fn ensure_uniform_cache(&mut self, required_slots: usize) {
        let required_slots = required_slots.max(1);
        if self
            .uniform_cache
            .as_ref()
            .map(|cache| cache.capacity_slots >= required_slots)
            .unwrap_or(false)
        {
            return;
        }
        let limits = self.device.limits();
        let buffer_limited_slots = limits.max_buffer_size / UNIFORM_STRIDE;
        let offset_limited_slots = u32::MAX as u64 / UNIFORM_STRIDE + 1;
        let max_slots = buffer_limited_slots.min(offset_limited_slots) as usize;
        let capacity_slots = required_slots
            .checked_next_power_of_two()
            .expect("uniform slot count overflow")
            .min(max_slots);
        assert!(
            capacity_slots >= required_slots,
            "Live2D frame needs {required_slots} uniform slots, device supports {max_slots}"
        );
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("live2d-uniform"),
            size: capacity_slots as u64 * UNIFORM_STRIDE,
            usage: wgpu::BufferUsages::UNIFORM | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let bind_group = self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("live2d-uniform-bg"),
            layout: &self.uniform_layout,
            entries: &[wgpu::BindGroupEntry {
                binding: 0,
                resource: wgpu::BindingResource::Buffer(wgpu::BufferBinding {
                    buffer: &buffer,
                    offset: 0,
                    size: wgpu::BufferSize::new(UNIFORM_STRIDE),
                }),
            }],
        });
        self.uniform_cache = Some(UniformCache {
            buffer,
            bind_group,
            capacity_slots,
        });
    }

    pub(super) fn upload_frame(&mut self, drawables: &[Drawable], values: &[Uniforms]) {
        let cache = self.model_cache.as_mut().expect("model GPU cache");
        let mut dirty = cache.position_staging.len()..0;
        for (drawable, geometry) in drawables.iter().zip(&mut cache.geometry) {
            let Some(geometry) = geometry else { continue; };
            if geometry.revision == drawable.position_revision {
                continue;
            }
            cache.position_staging[geometry.vertices.clone()].copy_from_slice(&drawable.positions);
            geometry.revision = drawable.position_revision;
            dirty.start = dirty.start.min(geometry.vertices.start);
            dirty.end = dirty.end.max(geometry.vertices.end);
        }
        if dirty.start < dirty.end {
            self.queue.write_buffer(&cache.positions, dirty.start as u64 * VERTEX_STRIDE,
                bytemuck::cast_slice(&cache.position_staging[dirty]));
        }

        if !values.is_empty() {
            self.uniform_staging.resize(values.len() * UNIFORM_STRIDE as usize, 0);
            for (slot, value) in self.uniform_staging.chunks_exact_mut(UNIFORM_STRIDE as usize).zip(values) {
                let bytes = bytemuck::bytes_of(value);
                slot[..bytes.len()].copy_from_slice(bytes);
            }
            let uniform = self.uniform_cache.as_ref().expect("uniform cache");
            self.queue.write_buffer(&uniform.buffer, 0, &self.uniform_staging);
        }
    }

    pub(super) fn create_color_bind_group(&self, texture: &Texture) -> wgpu::BindGroup {
        self.device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("live2d-tex-bg"),
            layout: &self.tex_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&texture.view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&self.sampler),
                },
            ],
        })
    }
}

fn build_mask_channels(
    drawables: &[Drawable],
    texture_count: usize,
) -> (Vec<MaskChannel>, Vec<Option<usize>>) {
    let mut channels = Vec::new();
    let mut channel_for_drawable = vec![None; drawables.len()];
    for d in drawables {
        let Ok(drawable_index) = usize::try_from(d.index) else {
            continue;
        };
        if drawable_index >= drawables.len() {
            continue;
        }
        let mut key: Vec<i32> = d
            .masks
            .iter()
            .copied()
            .filter(|mask_index| {
                usize::try_from(*mask_index)
                    .map(|index| {
                        index < drawables.len()
                            && (drawables[index].texture_index as usize) < texture_count
                            && !drawables[index].positions.is_empty()
                            && !drawables[index].indices.is_empty()
                    })
                    .unwrap_or(false)
            })
            .collect();
        if key.is_empty() {
            continue;
        }
        key.sort_unstable();
        key.dedup();
        let channel_index = channels
            .iter()
            .position(|channel: &MaskChannel| channel.mask_indices == key)
            .unwrap_or_else(|| {
                channels.push(MaskChannel {
                    mask_indices: key.clone(),
                    members: Vec::new(),
                    gpu: None,
                });
                channels.len() - 1
            });
        channels[channel_index].members.push(d.index);
        channel_for_drawable[drawable_index] = Some(channel_index);
    }
    (channels, channel_for_drawable)
}

fn make_uv_data(d: &Drawable, uv_flipped: bool) -> Vec<[f32; 2]> {
    d.uvs
        .iter()
        .map(|uv| [uv[0], if uv_flipped { 1.0 - uv[1] } else { uv[1] }])
        .collect()
}
