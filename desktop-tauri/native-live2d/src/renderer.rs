//! wgpu renderer for Live2D drawables.
//!
//! Implements official Cubism renderer semantics on top of wgpu: premultiplied
//! alpha blending, mask offscreens (drawables with the same mask set share one
//! channel), multiply/screen colors, per-drawable opacity and color blend
//! modes. Legacy-compatible blends (Normal/Add/Multiply/Screen) are fully
//! implemented; exotic 5.3 color modes fall back to Normal with a warning.

use std::sync::Arc;

#[path = "renderer_texture_upload.rs"]
mod texture_upload;

use bytemuck::{Pod, Zeroable};

use crate::model::{Drawable, Model, ViewTransform};

const SHADER: &str = include_str!("shader.wgsl");
const UNIFORM_STRIDE: u64 = 256;
const COLOR_TEXTURE_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8UnormSrgb;

#[repr(C)]
#[derive(Clone, Copy, Pod, Zeroable)]
struct Uniforms {
    transform: [f32; 4],
    multiply_color: [f32; 4],
    screen_color: [f32; 4],
    misc: [f32; 4],
}

pub struct Texture {
    pub width: u32,
    pub height: u32,
    pub view: wgpu::TextureView,
}

#[derive(Default, Debug, Clone, Copy)]
pub struct RenderResourceStats {
    pub frame_creations: usize,
    pub total_creations: u64,
    pub textures_created: u64,
    pub texture_upload_buffers_created: u64,
    pub upload_buffers_created: u64,
    pub uniform_buffers_created: u64,
    pub uniform_bind_groups_created: u64,
    pub vertex_buffers_created: u64,
    pub uv_buffers_created: u64,
    pub index_buffers_created: u64,
    pub mask_textures_created: u64,
    pub mask_bind_groups_created: u64,
    pub color_bind_groups_created: u64,
}

struct UniformCache {
    buffer: wgpu::Buffer,
    bind_group: wgpu::BindGroup,
    capacity_slots: usize,
}

struct TextureUploadState {
    buffer: Option<wgpu::Buffer>,
    capacity: u64,
}

struct GeometryBuffers {
    positions: wgpu::Buffer,
    uvs: wgpu::Buffer,
    indices: wgpu::Buffer,
    uv_data: Vec<[f32; 2]>,
    index_data: Vec<u16>,
    uv_flipped: bool,
    vertex_count: usize,
}

struct MaskGpuResources {
    // Keep the texture handle alongside its view for an explicit resource
    // lifetime. The view alone also retains the underlying wgpu resource.
    _texture: wgpu::Texture,
    view: wgpu::TextureView,
    bind_group: wgpu::BindGroup,
    width: u32,
    height: u32,
}

struct MaskChannel {
    mask_indices: Vec<i32>,
    members: Vec<i32>,
    gpu: Option<MaskGpuResources>,
}

struct ModelGpuCache {
    model_id: u64,
    texture_source: usize,
    geometry: Vec<Option<GeometryBuffers>>,
    channels: Vec<MaskChannel>,
    channel_for_drawable: Vec<Option<usize>>,
    color_bind_groups: Vec<wgpu::BindGroup>,
}

struct RenderOptions {
    x_shift: f32,
    uv_flipped: bool,
    force_normal_blend: bool,
    only_indices: Option<Vec<i32>>,
    min_opacity: Option<f32>,
    only_unmasked: bool,
    order_limit: Option<usize>,
    debug_transform: bool,
    debug_order: bool,
    debug_draw91: bool,
}

impl RenderOptions {
    fn from_env() -> Self {
        Self {
            x_shift: std::env::var("L2D_X_SHIFT")
                .ok()
                .and_then(|v| v.parse::<f32>().ok())
                .unwrap_or(0.0),
            uv_flipped: std::env::var("L2D_NO_FLIP").is_err(),
            force_normal_blend: std::env::var("L2D_FORCE_NORMAL_BLEND").is_ok(),
            only_indices: std::env::var("L2D_ONLY_INDICES").ok().map(|list| {
                list.split(',')
                    .filter_map(|v| v.trim().parse::<i32>().ok())
                    .collect()
            }),
            min_opacity: std::env::var("L2D_MIN_OPACITY")
                .ok()
                .map(|value| value.parse::<f32>().unwrap_or(0.0)),
            only_unmasked: std::env::var("L2D_ONLY_UNMASKED").is_ok(),
            order_limit: std::env::var("L2D_LIMIT_ORDER")
                .ok()
                .map(|value| value.parse::<usize>().unwrap_or(usize::MAX)),
            debug_transform: std::env::var("L2D_DEBUG_TRANSFORM").is_ok(),
            debug_order: std::env::var("L2D_DEBUG_ORDER").is_ok(),
            debug_draw91: std::env::var("L2D_DEBUG_DRAW91").is_ok(),
        }
    }
}

pub struct Renderer {
    pub device: Arc<wgpu::Device>,
    pub queue: Arc<wgpu::Queue>,
    pub format: wgpu::TextureFormat,
    pipelines: Pipelines,
    tex_layout: wgpu::BindGroupLayout,
    uniform_layout: wgpu::BindGroupLayout,
    sampler: wgpu::Sampler,
    white_mask_bg: wgpu::BindGroup,
    uniform_cache: Option<UniformCache>,
    model_cache: Option<ModelGpuCache>,
    drawables_scratch: Vec<Drawable>,
    upload_buffer: Option<wgpu::Buffer>,
    upload_capacity: usize,
    upload_staging: Vec<u8>,
    texture_upload: TextureUploadState,
    resource_stats: RenderResourceStats,
    stats: RenderStats,
    /// 2x supersample offscreen target: (width, height, texture, view).
    /// Recreated when the render size changes; cleared per frame by the main
    /// pass, then blitted (linear downsample) into the swapchain surface.
    ss_texture: Option<(u32, u32, wgpu::Texture, wgpu::TextureView)>,
    ss_bg: Option<wgpu::BindGroup>,
    ss_pipeline: wgpu::RenderPipeline,
}

#[derive(Default, Debug, Clone)]
pub struct RenderStats {
    pub draw_calls: usize,
    pub mask_textures: usize,
    pub total_vertices: usize,
}

struct Pipelines {
    standard: [wgpu::RenderPipeline; 4],
    masked: [wgpu::RenderPipeline; 4],
    mask: wgpu::RenderPipeline,
}

pub fn new_device() -> Result<(Arc<wgpu::Device>, Arc<wgpu::Queue>), String> {
    let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
        backends: if cfg!(target_os = "windows") {
            wgpu::Backends::DX12
        } else {
            wgpu::Backends::PRIMARY
        },
        ..Default::default()
    });
    let adapter = block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        force_fallback_adapter: false,
        compatible_surface: None,
    }))
    .map_err(|e| format!("no adapter available: {e}"))?;
    let adapter_info = adapter.get_info();
    if cfg!(target_os = "windows") && adapter_info.backend != wgpu::Backend::Dx12 {
        return Err(format!(
            "expected DX12 adapter, got {:?} ({})",
            adapter_info.backend, adapter_info.name
        ));
    }
    eprintln!(
        "[live2d] offscreen adapter: {} backend={:?}",
        adapter_info.name, adapter_info.backend
    );
    let (device, queue) = block_on(adapter.request_device(
        &wgpu::DeviceDescriptor {
            label: Some("live2d-native"),
            required_features: wgpu::Features::empty(),
            required_limits: wgpu::Limits::default(),
            experimental_features: wgpu::ExperimentalFeatures::disabled(),
            memory_hints: wgpu::MemoryHints::default(),
            trace: wgpu::Trace::Off,
        },
    ))
    .map_err(|e| format!("no device: {e}"))?;
    Ok((Arc::new(device), Arc::new(queue)))
}

fn block_on<F: std::future::Future>(future: F) -> F::Output {
    use std::task::{Context, Poll, RawWaker, RawWakerVTable, Waker};
    fn noop(_: *const ()) {}
    fn clone(_: *const ()) -> RawWaker {
        let vtable: &'static RawWakerVTable = &RawWakerVTable::new(clone, noop, noop, noop);
        RawWaker::new(std::ptr::null(), vtable)
    }
    let waker = unsafe { Waker::from_raw(clone(std::ptr::null())) };
    let mut cx = Context::from_waker(&waker);
    let mut future = Box::pin(future);
    loop {
        match future.as_mut().poll(&mut cx) {
            Poll::Ready(value) => return value,
            Poll::Pending => std::thread::yield_now(),
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum BlendKind {
    Normal = 0,
    Add = 1,
    Multiply = 2,
    Screen = 3,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum PipelineKind {
    Main,
    Mask,
}

impl Renderer {
    pub fn new(
        device: Arc<wgpu::Device>,
        queue: Arc<wgpu::Queue>,
        format: wgpu::TextureFormat,
    ) -> Renderer {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("live2d-shader"),
            source: wgpu::ShaderSource::Wgsl(SHADER.into()),
        });

        let tex_layout = create_tex_layout(&device);
        let uniform_layout = create_uniform_layout(&device);
        let main_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("live2d-main-layout"),
            bind_group_layouts: &[&tex_layout, &tex_layout, &uniform_layout],
            push_constant_ranges: &[],
        });

        // Mask coordinates outside the render target must sample the edge,
        // not wrap into another part of the mask atlas.
        let sampler = device.create_sampler(&wgpu::SamplerDescriptor {
            label: Some("live2d-sampler"),
            mag_filter: wgpu::FilterMode::Linear,
            min_filter: wgpu::FilterMode::Linear,
            mipmap_filter: wgpu::FilterMode::Nearest,
            address_mode_u: wgpu::AddressMode::ClampToEdge,
            address_mode_v: wgpu::AddressMode::ClampToEdge,
            address_mode_w: wgpu::AddressMode::ClampToEdge,
            ..Default::default()
        });

        // Shared 1x1 white mask texture for non-masked drawables (group1 must
        // be bound on all pipelines; fs_main ignores it).
        let white = device.create_texture(&wgpu::TextureDescriptor {
            label: Some("live2d-white-mask"),
            size: wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        });
        queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &white,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &[255, 255, 255, 255],
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(4),
                rows_per_image: Some(1),
            },
            wgpu::Extent3d {
                width: 1,
                height: 1,
                depth_or_array_layers: 1,
            },
        );
        let white_view = white.create_view(&wgpu::TextureViewDescriptor::default());
        let white_mask_bg = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("live2d-white-mask-bg"),
            layout: &tex_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: wgpu::BindingResource::TextureView(&white_view),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::Sampler(&sampler),
                },
            ],
        });

        let blends = [
            BlendKind::Normal,
            BlendKind::Add,
            BlendKind::Multiply,
            BlendKind::Screen,
        ];
        let mut standard = Vec::with_capacity(4);
        let mut masked = Vec::with_capacity(4);
        for blend in blends {
            standard.push(make_pipeline(
                &device,
                &module,
                &main_layout,
                false,
                blend,
                format,
                PipelineKind::Main,
            ));
            masked.push(make_pipeline(
                &device,
                &module,
                &main_layout,
                true,
                blend,
                format,
                PipelineKind::Main,
            ));
        }
        // Mask channel pipeline: straight-alpha "over" blending, writes into
        // an Rgba8Unorm channel texture (only the alpha channel is consumed).
        let mask = make_pipeline(
            &device,
            &module,
            &main_layout,
            false,
            BlendKind::Normal,
            wgpu::TextureFormat::Rgba8Unorm,
            PipelineKind::Mask,
        );

        // 2x supersample blit pipeline: samples the offscreen supersample
        // texture (group 0 = texture + sampler) with linear filtering and
        // writes the downscaled frame into the swapchain surface.
        let ss_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("live2d-ss-blit-layout"),
            bind_group_layouts: &[&tex_layout],
            push_constant_ranges: &[],
        });
        let ss_pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("live2d-ss-blit"),
            layout: Some(&ss_layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs_blit"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs_blit"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::REPLACE),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview: None,
            cache: None,
        });

        Renderer {
            device,
            queue,
            format,
            pipelines: Pipelines {
                standard: standard.try_into().unwrap(),
                masked: masked.try_into().unwrap(),
                mask,
            },
            tex_layout,
            uniform_layout,
            sampler,
            white_mask_bg,
            uniform_cache: None,
            model_cache: None,
            drawables_scratch: Vec::new(),
            upload_buffer: None,
            upload_capacity: 0,
            upload_staging: Vec::new(),
            texture_upload: TextureUploadState {
                buffer: None,
                capacity: 0,
            },
            resource_stats: RenderResourceStats::default(),
            stats: RenderStats::default(),
            ss_texture: None,
            ss_bg: None,
            ss_pipeline,
        }
    }

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
            (width.saturating_mul(2).max(1), height.saturating_mul(2).max(1))
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
            format: wgpu::TextureFormat::Rgba8Unorm,
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

        let row_size = width * 4;
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
        let mut data = Vec::with_capacity((row_size * height) as usize);
        if padded_row == row_size {
            data.extend_from_slice(&mapped[..(row_size * height) as usize]);
        } else {
            for row in mapped.chunks_exact(padded_row as usize) {
                data.extend_from_slice(&row[..row_size as usize]);
            }
        }
        drop(mapped);
        Some(data)
    }

    pub fn stats(&self) -> &RenderStats {
        &self.stats
    }

    pub fn resource_stats(&self) -> &RenderResourceStats {
        &self.resource_stats
    }

    /// Release every GPU/CPU allocation whose lifetime belongs to the loaded
    /// model while retaining device-wide pipelines and layouts.
    pub fn release_model_resources(&mut self) {
        self.model_cache = None;
        self.uniform_cache = None;
        self.upload_buffer = None;
        self.upload_capacity = 0;
        self.upload_staging.clear();
        self.upload_staging.shrink_to_fit();
        self.drawables_scratch.clear();
        self.drawables_scratch.shrink_to_fit();
        self.release_texture_uploads();
        self.ss_bg = None;
        self.ss_texture = None;
        self.resource_stats.frame_creations = 0;
    }

    pub fn model_resources_released(&self) -> bool {
        self.model_cache.is_none()
            && self.uniform_cache.is_none()
            && self.upload_buffer.is_none()
            && self.upload_capacity == 0
            && self.texture_upload.buffer.is_none()
            && self.texture_upload.capacity == 0
            && self.ss_bg.is_none()
            && self.ss_texture.is_none()
            && self.upload_staging.capacity() == 0
            && self.drawables_scratch.capacity() == 0
    }

    fn ensure_model_cache(&mut self, model: &Model, textures: &[Texture], drawables: &[Drawable]) {
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

    fn prewarm_model_resources(
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

    fn ensure_geometry(&mut self, d: &Drawable, uv_flipped: bool) {
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

    fn create_geometry(&self, d: &Drawable, uv_flipped: bool) -> GeometryBuffers {
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

    fn ensure_mask_resource(&mut self, channel_index: usize, width: u32, height: u32) {
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
            format: wgpu::TextureFormat::Rgba8Unorm,
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

    fn ensure_uniform_cache(&mut self, required_slots: usize) {
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

    fn prepare_dynamic_uploads(
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

    fn ensure_upload_buffer(&mut self, required_bytes: usize) {
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

    fn create_color_bind_group(&self, texture: &Texture) -> wgpu::BindGroup {
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

    fn record_resource_creation(&mut self) {
        self.record_resource_creation_n(1);
    }

    fn record_resource_creation_n(&mut self, count: usize) {
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

fn make_uniform(
    d: &Drawable,
    transform: &ViewTransform,
    has_mask: bool,
    inverted_mask: bool,
    width: u32,
    height: u32,
    x_shift: f32,
    debug_transform: bool,
) -> Uniforms {
    let u = Uniforms {
        transform: transform.as_uniform_shifted(width as f32, height as f32, x_shift),
        multiply_color: d.multiply_color,
        screen_color: d.screen_color,
        misc: [
            d.opacity,
            if has_mask { 1.0 } else { 0.0 },
            if inverted_mask { 1.0 } else { 0.0 },
            0.0,
        ],
    };
    if debug_transform && (d.index == 104 || d.index == 32) {
        eprintln!(
            "[dbg] transform={:?} pos0={:?}",
            u.transform,
            d.positions.first()
        );
    }
    u
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

fn round_up4(v: u64) -> u64 {
    (v + 3) & !3
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

fn blend_state(kind: BlendKind, premultiplied: bool) -> wgpu::BlendState {
    // Verified against the reference ayagami renderer (and VTube Studio).
    use wgpu::{BlendFactor, BlendOperation};
    let (src_c, dst_c, src_a, dst_a) = if premultiplied {
        match kind {
            BlendKind::Normal => (
                BlendFactor::One,
                BlendFactor::OneMinusSrcAlpha,
                BlendFactor::One,
                BlendFactor::OneMinusSrcAlpha,
            ),
            BlendKind::Add => (
                BlendFactor::One,
                BlendFactor::One,
                BlendFactor::Zero,
                BlendFactor::One,
            ),
            BlendKind::Multiply => (
                BlendFactor::Dst,
                BlendFactor::OneMinusSrcAlpha,
                BlendFactor::Zero,
                BlendFactor::One,
            ),
            BlendKind::Screen => (
                BlendFactor::OneMinusDst,
                BlendFactor::One,
                BlendFactor::One,
                BlendFactor::One,
            ),
        }
    } else {
        match kind {
            BlendKind::Normal => (
                BlendFactor::SrcAlpha,
                BlendFactor::OneMinusSrcAlpha,
                BlendFactor::SrcAlpha,
                BlendFactor::OneMinusSrcAlpha,
            ),
            BlendKind::Add => (
                BlendFactor::SrcAlpha,
                BlendFactor::One,
                BlendFactor::SrcAlpha,
                BlendFactor::One,
            ),
            BlendKind::Multiply => (
                BlendFactor::Dst,
                BlendFactor::OneMinusSrcAlpha,
                BlendFactor::SrcAlpha,
                BlendFactor::OneMinusSrcAlpha,
            ),
            BlendKind::Screen => (
                BlendFactor::OneMinusDst,
                BlendFactor::One,
                BlendFactor::SrcAlpha,
                BlendFactor::One,
            ),
        }
    };
    wgpu::BlendState {
        color: wgpu::BlendComponent {
            src_factor: src_c,
            dst_factor: dst_c,
            operation: BlendOperation::Add,
        },
        alpha: wgpu::BlendComponent {
            src_factor: src_a,
            dst_factor: dst_a,
            operation: BlendOperation::Add,
        },
    }
}

fn create_tex_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("live2d-tex-layout"),
        entries: &[
            wgpu::BindGroupLayoutEntry {
                binding: 0,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Texture {
                    sample_type: wgpu::TextureSampleType::Float { filterable: true },
                    view_dimension: wgpu::TextureViewDimension::D2,
                    multisampled: false,
                },
                count: None,
            },
            wgpu::BindGroupLayoutEntry {
                binding: 1,
                visibility: wgpu::ShaderStages::FRAGMENT,
                ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                count: None,
            },
        ],
    })
}

fn create_uniform_layout(device: &wgpu::Device) -> wgpu::BindGroupLayout {
    device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
        label: Some("live2d-uniform-layout"),
        entries: &[wgpu::BindGroupLayoutEntry {
            binding: 0,
            visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Uniform,
                has_dynamic_offset: true,
                min_binding_size: None,
            },
            count: None,
        }],
    })
}

fn make_pipeline(
    device: &wgpu::Device,
    module: &wgpu::ShaderModule,
    layout: &wgpu::PipelineLayout,
    masked: bool,
    blend: BlendKind,
    format: wgpu::TextureFormat,
    kind: PipelineKind,
) -> wgpu::RenderPipeline {
    let position_layout = wgpu::VertexBufferLayout {
        array_stride: 8,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &[wgpu::VertexAttribute {
            format: wgpu::VertexFormat::Float32x2,
            offset: 0,
            shader_location: 0,
        }],
    };
    let uv_layout = wgpu::VertexBufferLayout {
        array_stride: 8,
        step_mode: wgpu::VertexStepMode::Vertex,
        attributes: &[wgpu::VertexAttribute {
            format: wgpu::VertexFormat::Float32x2,
            offset: 0,
            shader_location: 1,
        }],
    };
    let targets = [Some(wgpu::ColorTargetState {
        format,
        blend: Some(if kind == PipelineKind::Mask {
            // Mask channel pass: out = src + dst * (1 - src), matching the
            // reference renderer (avoids squared-alpha darkening).
            wgpu::BlendState {
                color: wgpu::BlendComponent {
                    src_factor: wgpu::BlendFactor::One,
                    dst_factor: wgpu::BlendFactor::OneMinusSrc,
                    operation: wgpu::BlendOperation::Add,
                },
                alpha: wgpu::BlendComponent {
                    src_factor: wgpu::BlendFactor::One,
                    dst_factor: wgpu::BlendFactor::OneMinusSrc,
                    operation: wgpu::BlendOperation::Add,
                },
            }
        } else {
            blend_state(blend, true)
        }),
        write_mask: if kind == PipelineKind::Mask {
            wgpu::ColorWrites::ALL
        } else if matches!(blend, BlendKind::Add | BlendKind::Multiply) {
            wgpu::ColorWrites::COLOR
        } else {
            wgpu::ColorWrites::ALL
        },
    })];
    let entry = if kind == PipelineKind::Mask {
        "fs_mask"
    } else if matches!(blend, BlendKind::Multiply) {
        if masked {
            "fs_multiply_masked"
        } else {
            "fs_multiply"
        }
    } else if masked {
        "fs_masked"
    } else {
        "fs_main"
    };
    device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some(entry),
        layout: Some(layout),
        vertex: wgpu::VertexState {
            module,
            entry_point: Some("vs_main"),
            compilation_options: Default::default(),
            buffers: &[position_layout, uv_layout],
        },
        fragment: Some(wgpu::FragmentState {
            module,
            entry_point: Some(entry),
            compilation_options: Default::default(),
            targets: &targets,
        }),
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            strip_index_format: None,
            front_face: wgpu::FrontFace::Ccw,
            cull_mode: None,
            unclipped_depth: false,
            polygon_mode: wgpu::PolygonMode::Fill,
            conservative: false,
        },
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        multiview: None,
        cache: None,
    })
}
