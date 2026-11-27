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
        let row_size = width as usize * 4;
        assert_eq!(
            rgba.len(),
            row_size * height as usize,
            "texture RGBA byte length mismatch"
        );
        // Queue writes accept unpadded rows and share the next submission.
        // All texture uploads for a character are sent without draining the GPU.
        self.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            rgba,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            size,
        );
        self.textures_pending = true;
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        Texture {
            width,
            height,
            view,
        }
    }

    /// Submit all pending texture writes together. The GPU queue keeps them
    /// ordered with subsequent draws and releases its staging after completion.
    pub fn release_texture_uploads(&mut self) {
        if std::mem::take(&mut self.textures_pending) {
            self.queue.submit([]);
        }
    }
}