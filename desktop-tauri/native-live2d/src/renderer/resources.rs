//! Model-owned geometry, masks and reusable upload buffers.
use super::*;

impl Renderer {
    pub(super) fn ensure_model_cache(
        &mut self,
        model: &Model,
        textures: &[Texture],
        drawables: &[Drawable],
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
            self.resource_stats.color_bind_groups_created += 1;
            self.record_resource_creation();
        }
        self.model_cache = Some(ModelGpuCache {
            model_id,
            texture_source,
            geometry: (0..drawables.len()).map(|_| None).collect(),
            channels,
            channel_for_drawable,
            color_bind_groups,
        });
    }

    pub(super) fn prewarm_model_resources(
        &mut self,
        drawables: &[Drawable],
        uv_flipped: bool,
        width: u32,
        height: u32,
    ) {
        for drawable in drawables {
            self.ensure_geometry(drawable, uv_flipped);
        }
        let channel_count = self
            .model_cache
            .as_ref()
            .map(|cache| cache.channels.len())
            .unwrap_or(0);
        for channel_index in 0..channel_count {
            self.ensure_mask_resource(channel_index, width, height);
        }
    }

    pub(super) fn ensure_geometry(&mut self, d: &Drawable, uv_flipped: bool) {
        let drawable_index = d.index as usize;
        assert_eq!(
            d.positions.len(),
            d.uvs.len(),
            "drawable position/UV count mismatch"
        );
        let needs_new = self
            .model_cache
            .as_ref()
            .and_then(|cache| cache.geometry.get(drawable_index))
            .and_then(|geometry| geometry.as_ref())
            .map(|geometry| {
                geometry.vertex_count != d.positions.len()
                    || geometry.uv_data.len() != d.uvs.len()
                    || geometry.index_data != d.indices
            })
            .unwrap_or(true);

        if needs_new {
            let geometry = self.create_geometry(d, uv_flipped);
            let cache = self.model_cache.as_mut().expect("model GPU cache");
            cache.geometry[drawable_index] = Some(geometry);
            self.resource_stats.vertex_buffers_created += 1;
            self.resource_stats.uv_buffers_created += 1;
            self.resource_stats.index_buffers_created += 1;
            self.record_resource_creation_n(3);
            return;
        }

        let queue = Arc::clone(&self.queue);
        let cache = self.model_cache.as_mut().expect("model GPU cache");
        let geometry = cache.geometry[drawable_index]
            .as_mut()
            .expect("geometry cache entry");
        if geometry.uv_flipped != uv_flipped {
            let uv_data = make_uv_data(d, uv_flipped);
            queue.write_buffer(&geometry.uvs, 0, bytemuck::cast_slice(&uv_data));
            geometry.uv_data = uv_data;
            geometry.uv_flipped = uv_flipped;
        }
    }

    pub(super) fn create_geometry(&self, d: &Drawable, uv_flipped: bool) -> GeometryBuffers {
        let uv_data = make_uv_data(d, uv_flipped);
        let position_size =
            round_up4((d.positions.len() * std::mem::size_of::<[f32; 2]>()) as u64).max(4);
        let uv_size = round_up4((uv_data.len() * std::mem::size_of::<[f32; 2]>()) as u64).max(4);
        let index_size = round_up4((d.indices.len() * std::mem::size_of::<u16>()) as u64).max(4);
        let positions = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("live2d-positions"),
            size: position_size,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let uvs = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("live2d-uvs"),
            size: uv_size,
            usage: wgpu::BufferUsages::VERTEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        let indices = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("live2d-indices"),
            size: index_size,
            usage: wgpu::BufferUsages::INDEX | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        if !d.positions.is_empty() {
            self.queue
                .write_buffer(&positions, 0, bytemuck::cast_slice(&d.positions));
        }
        if !uv_data.is_empty() {
            self.queue
                .write_buffer(&uvs, 0, bytemuck::cast_slice(&uv_data));
        }
        if !d.indices.is_empty() {
            let mut padded = Vec::with_capacity(index_size as usize);
            padded.extend_from_slice(bytemuck::cast_slice(&d.indices));
            padded.resize(index_size as usize, 0);
            self.queue.write_buffer(&indices, 0, &padded);
        }
        GeometryBuffers {
            positions,
            uvs,
            indices,
            uv_data,
            index_data: d.indices.clone(),
            uv_flipped,
            vertex_count: d.positions.len(),
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
        self.resource_stats.uniform_buffers_created += 1;
        self.resource_stats.uniform_bind_groups_created += 1;
        self.record_resource_creation_n(2);
    }

    pub(super) fn prepare_dynamic_uploads(
        &mut self,
        drawables: &[Drawable],
        geometry_needed: &[bool],
        values: &[Uniforms],
    ) -> (Vec<(usize, u64, u64)>, Option<(u64, u64)>) {
        self.upload_staging.clear();
        let mut position_uploads = Vec::new();
        for (drawable_index, needed) in geometry_needed.iter().copied().enumerate() {
            if !needed || drawables[drawable_index].positions.is_empty() {
                continue;
            }
            let bytes = bytemuck::cast_slice(&drawables[drawable_index].positions);
            let source_offset = self.upload_staging.len() as u64;
            self.upload_staging.extend_from_slice(bytes);
            position_uploads.push((drawable_index, source_offset, bytes.len() as u64));
        }

        let uniform_upload = if values.is_empty() {
            None
        } else {
            let source_offset = round_up4(self.upload_staging.len() as u64) as usize;
            self.upload_staging.resize(source_offset, 0);
            let byte_len = values.len() * UNIFORM_STRIDE as usize;
            self.upload_staging.resize(source_offset + byte_len, 0);
            for (slot, value) in values.iter().enumerate() {
                let start = source_offset + slot * UNIFORM_STRIDE as usize;
                let end = start + std::mem::size_of::<Uniforms>();
                self.upload_staging[start..end].copy_from_slice(bytemuck::bytes_of(value));
            }
            Some((source_offset as u64, byte_len as u64))
        };

        if !self.upload_staging.is_empty() {
            self.ensure_upload_buffer(self.upload_staging.len());
            let queue = Arc::clone(&self.queue);
            let upload_buffer = self.upload_buffer.as_ref().expect("upload buffer");
            queue.write_buffer(upload_buffer, 0, &self.upload_staging);
        }
        (position_uploads, uniform_upload)
    }

    pub(super) fn ensure_upload_buffer(&mut self, required_bytes: usize) {
        if self.upload_capacity >= required_bytes {
            return;
        }
        let capacity = required_bytes
            .checked_next_power_of_two()
            .expect("dynamic upload size overflow")
            .max(4096);
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("live2d-dynamic-upload"),
            size: capacity as u64,
            usage: wgpu::BufferUsages::COPY_SRC | wgpu::BufferUsages::COPY_DST,
            mapped_at_creation: false,
        });
        self.upload_buffer = Some(buffer);
        self.upload_capacity = capacity;
        self.resource_stats.upload_buffers_created += 1;
        self.record_resource_creation();
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

    pub(super) fn record_resource_creation(&mut self) {
        self.record_resource_creation_n(1);
    }

    pub(super) fn record_resource_creation_n(&mut self, count: usize) {
        self.resource_stats.frame_creations += count;
        self.resource_stats.total_creations += count as u64;
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

fn round_up4(v: u64) -> u64 {
    (v + 3) & !3
}
