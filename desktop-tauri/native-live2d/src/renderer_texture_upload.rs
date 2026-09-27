use super::{Renderer, Texture, COLOR_TEXTURE_FORMAT};

impl Renderer {
    /// Upload an RGBA texture as-is (straight alpha), matching the reference
    /// ayagami renderer; the shader consumes the stored values directly.
    pub fn load_texture(&mut self, rgba: &[u8], width: u32, height: u32) -> Texture {
        let size = wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        };
        let texture = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("live2d-texture"),
            size,
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: COLOR_TEXTURE_FORMAT,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        self.resource_stats.textures_created += 1;
        self.record_resource_creation();
        let row_size = width as usize * 4;
        assert_eq!(
            rgba.len(),
            row_size * height as usize,
            "texture RGBA byte length mismatch"
        );
        let padded_row = row_size.div_ceil(256);
        let padded_row = padded_row * 256;
        let upload_size = padded_row as u64 * height as u64;
        if self.texture_upload.capacity < upload_size {
            let capacity = upload_size.next_power_of_two().max(256 * 256 * 4);
            self.texture_upload.buffer = Some(self.device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("live2d-texture-upload"),
                size: capacity,
                usage: wgpu::BufferUsages::MAP_WRITE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            }));
            self.texture_upload.capacity = capacity;
            self.resource_stats.texture_upload_buffers_created += 1;
            self.record_resource_creation();
        }
        let upload_buffer = self
            .texture_upload
            .buffer
            .as_ref()
            .expect("texture upload buffer");
        {
            let slice = upload_buffer.slice(..upload_size);
            let (tx, rx) = std::sync::mpsc::channel();
            slice.map_async(wgpu::MapMode::Write, move |result| {
                let _ = tx.send(result);
            });
            self.device
                .poll(wgpu::PollType::wait_indefinitely())
                .expect("texture upload device poll failed");
            rx.recv()
                .expect("texture upload map channel")
                .expect("texture upload map failed");
            let mut mapped = slice.get_mapped_range_mut();
            for row in 0..height as usize {
                let source_start = row * row_size;
                let target_start = row * padded_row;
                mapped[target_start..target_start + row_size]
                    .copy_from_slice(&rgba[source_start..source_start + row_size]);
                mapped[target_start + row_size..target_start + padded_row].fill(0);
            }
            drop(mapped);
        }
        upload_buffer.unmap();
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("live2d-texture-upload-encoder"),
            });
        encoder.copy_buffer_to_texture(
            wgpu::TexelCopyBufferInfo {
                buffer: upload_buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(padded_row as u32),
                    rows_per_image: Some(height),
                },
            },
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            size,
        );
        self.queue.submit(std::iter::once(encoder.finish()));
        self.device
            .poll(wgpu::PollType::wait_indefinitely())
            .expect("texture copy device poll failed");
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        Texture {
            width,
            height,
            view,
        }
    }

    /// The upload buffer can be large; retain it only while loading a model.
    /// load_texture waits for each copy, so no in-flight submission uses it here.
    pub fn release_texture_uploads(&mut self) {
        self.texture_upload.buffer = None;
        self.texture_upload.capacity = 0;
    }
}