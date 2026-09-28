use super::*;

#[test]
fn mask_readback_preserves_rgba_and_skips_row_padding() {
    let mut bytes = vec![231; 512];
    bytes[..3].copy_from_slice(&[0, 128, 255]);
    bytes[256..259].copy_from_slice(&[64, 192, 1]);
    let rgba = mask::expand_mask_readback(&bytes, 3, 2, 256);
    assert_eq!(rgba.len(), 24);
    assert_eq!(
        rgba.chunks_exact(4).map(|p| p[3]).collect::<Vec<_>>(),
        [0, 128, 255, 64, 192, 1]
    );
    assert!(rgba.chunks_exact(4).all(|p| p[..3] == [255; 3]));
}

fn buffer(device: &wgpu::Device, bytes: &[u8]) -> wgpu::Buffer {
    let buffer = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("mask-regression-geometry"),
        size: bytes.len() as u64,
        usage: wgpu::BufferUsages::VERTEX,
        mapped_at_creation: true,
    });
    buffer
        .slice(..)
        .get_mapped_range_mut()
        .copy_from_slice(bytes);
    buffer.unmap();
    buffer
}

fn target(device: &wgpu::Device, format: wgpu::TextureFormat) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("mask-regression-target"),
        size: wgpu::Extent3d {
            width: 3,
            height: 2,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::TEXTURE_BINDING
            | wgpu::TextureUsages::COPY_SRC,
        view_formats: &[],
    })
}

fn readback(renderer: &Renderer, texture: &wgpu::Texture, bytes_per_pixel: usize) -> Vec<u8> {
    let buffer = renderer.device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("mask-regression-readback"),
        size: 512,
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut encoder = renderer.device.create_command_encoder(&Default::default());
    encoder.copy_texture_to_buffer(
        texture.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &buffer,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(256),
                rows_per_image: Some(2),
            },
        },
        texture.size(),
    );
    renderer.queue.submit([encoder.finish()]);
    let slice = buffer.slice(..);
    let (tx, rx) = std::sync::mpsc::channel();
    slice.map_async(wgpu::MapMode::Read, move |result| {
        tx.send(result).unwrap();
    });
    renderer
        .device
        .poll(wgpu::PollType::wait_indefinitely())
        .unwrap();
    rx.recv().unwrap().unwrap();
    let mapped = slice.get_mapped_range();
    let result = mapped
        .chunks_exact(256)
        .flat_map(|row| row[..3 * bytes_per_pixel].iter().copied())
        .collect();
    drop(mapped);
    buffer.unmap();
    result
}

// Explicitly invoked on a machine with a GPU; ordinary cargo test stays device-free.
#[test]
#[ignore = "requires a GPU (DX12 on Windows)"]
fn mask_union_and_inversion() {
    let (device, queue) = new_device().expect("GPU required for mask regression");
    let mut renderer = Renderer::new(device, queue, wgpu::TextureFormat::Rgba8Unorm);
    let positions = buffer(
        &renderer.device,
        bytemuck::cast_slice(&[[-1.0f32, -1.0], [3.0, -1.0], [-1.0, 3.0]]),
    );
    let uvs = buffer(&renderer.device, bytemuck::cast_slice(&[[0.5f32, 0.5]; 3]));
    let textures: Vec<_> = [128, 64, 255]
        .into_iter()
        .map(|alpha| renderer.load_texture(&[255, 255, 255, alpha], 1, 1))
        .collect();
    renderer.release_texture_uploads();
    let colors: Vec<_> = textures
        .iter()
        .map(|t| renderer.create_color_bind_group(t))
        .collect();
    renderer.ensure_uniform_cache(1);
    let mask_texture = target(&renderer.device, MASK_TEXTURE_FORMAT);
    let mask_view = mask_texture.create_view(&Default::default());
    let mask_binding = renderer.create_color_bind_group(&Texture {
        width: 3,
        height: 2,
        view: mask_texture.create_view(&Default::default()),
    });
    let mut uniform = Uniforms {
        transform: [1.0, 1.0, 0.0, 0.0],
        multiply_color: [1.0; 4],
        screen_color: [0.0; 4],
        misc: [1.0, 0.0, 0.0, 0.0],
    };
    let cache = renderer.uniform_cache.as_ref().unwrap();
    renderer
        .queue
        .write_buffer(&cache.buffer, 0, bytemuck::bytes_of(&uniform));
    let mut encoder = renderer.device.create_command_encoder(&Default::default());
    {
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("mask-regression-union"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &mask_view,
                resolve_target: None,
                depth_slice: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
            })],
            ..Default::default()
        });
        pass.set_pipeline(&renderer.pipelines.mask);
        pass.set_bind_group(1, &renderer.white_mask_bg, &[]);
        pass.set_bind_group(2, &cache.bind_group, &[0]);
        pass.set_vertex_buffer(0, positions.slice(..));
        pass.set_vertex_buffer(1, uvs.slice(..));
        for color in &colors[..2] {
            pass.set_bind_group(0, color, &[]);
            pass.draw(0..3, 0..1);
        }
    }
    renderer.queue.submit([encoder.finish()]);
    // Union of 128/255 and 64/255 is 159.8745/255, rounded to 160.
    assert_eq!(readback(&renderer, &mask_texture, 1), vec![160; 6]);
    for inverted in [false, true] {
        uniform.misc[1] = 1.0;
        uniform.misc[2] = if inverted { 1.0 } else { 0.0 };
        renderer
            .queue
            .write_buffer(&cache.buffer, 0, bytemuck::bytes_of(&uniform));
        let output = target(&renderer.device, renderer.format);
        let view = output.create_view(&Default::default());
        let mut encoder = renderer.device.create_command_encoder(&Default::default());
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("mask-regression-sampling"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: &view,
                    resolve_target: None,
                    depth_slice: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                        store: wgpu::StoreOp::Store,
                    },
                })],
                ..Default::default()
            });
            pass.set_pipeline(&renderer.pipelines.masked[BlendKind::Normal as usize]);
            pass.set_bind_group(0, &colors[2], &[]);
            pass.set_bind_group(1, &mask_binding, &[]);
            pass.set_bind_group(2, &cache.bind_group, &[0]);
            pass.set_vertex_buffer(0, positions.slice(..));
            pass.set_vertex_buffer(1, uvs.slice(..));
            pass.draw(0..3, 0..1);
        }
        renderer.queue.submit([encoder.finish()]);
        let expected = if inverted { 95 } else { 160 };
        assert_eq!(readback(&renderer, &output, 4), vec![expected; 24]);
    }
}
