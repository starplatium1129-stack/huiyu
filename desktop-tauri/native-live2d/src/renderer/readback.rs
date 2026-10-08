//! Offscreen rendering and CPU image readback.
use super::*;

impl Renderer {
    /// Render one frame to a CPU buffer (RGBA8, sRGB-encoded).
    /// With `no_mask`, mask channels are skipped and every drawable draws
    /// uncropped (used to isolate mask-cropping bugs). With `only_drawable`,
    /// only that drawable index is drawn.
    pub fn render_to_image(
        &mut self,
        model: &Model,
        transform: &ViewTransform,
        textures: &[Texture],
        width: u32,
        height: u32,
        no_mask: bool,
        only_drawable: Option<i32>,
    ) -> Vec<u8> {
        let target = self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("live2d-target"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: self.format,
            usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
            view_formats: &[],
        });
        let target_view = target.create_view(&wgpu::TextureViewDescriptor::default());
        let mut encoder = self.draw_frame(
            model,
            transform,
            textures,
            &target_view,
            width,
            height,
            no_mask,
            only_drawable,
            false,
        );

        // read back（DX12 强制 COPY_BYTES_PER_ROW_ALIGNMENT=256，需按行对齐）
        let row_size = width * 4;
        let padded_row = row_size.div_ceil(256) * 256;
        let readback = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("live2d-readback"),
            size: (padded_row as u64) * (height as u64),
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture: &target,
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
            .expect("readback device poll failed");
        rx.recv()
            .expect("map channel")
            .expect("map readback failed");
        let mapped = slice.get_mapped_range();
        let mut data = Vec::with_capacity((row_size * height) as usize);
        if padded_row == row_size {
            data.extend_from_slice(&mapped[..(row_size * height) as usize]);
        } else {
            for row in mapped.chunks_exact(padded_row as usize) {
                data.extend_from_slice(&row[..row_size as usize]);
            }
        }
        drop(mapped);
        normalize_readback_rgba(self.format, &mut data);
        if std::env::var("L2D_DEBUG_ALPHA").is_ok() {
            let mut buckets = [0u64; 5];
            let mut opaque = 0u64;
            for px in data.chunks_exact(4) {
                let a = px[3];
                if a > 250 {
                    opaque += 1;
                } else if a > 8 {
                    buckets[((a as usize) / 64).min(4)] += 1;
                }
            }
            eprintln!(
                "[alpha] render-target opaque={opaque} semi=[{},{},{},{}]",
                buckets[0], buckets[1], buckets[2], buckets[3]
            );
        }
        data
    }
}

fn normalize_readback_rgba(format: wgpu::TextureFormat, data: &mut [u8]) {
    if matches!(
        format,
        wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Bgra8UnormSrgb
    ) {
        for pixel in data.chunks_exact_mut(4) {
            pixel.swap(0, 2);
        }
    }
}
