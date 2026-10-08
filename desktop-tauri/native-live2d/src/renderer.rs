//! wgpu renderer for Live2D drawables.
//!
//! Implements official Cubism renderer semantics on top of wgpu: premultiplied
//! alpha blending, mask offscreens (drawables with the same mask set share one
//! channel), multiply/screen colors, per-drawable opacity and color blend
//! modes. Legacy-compatible blends (Normal/Add/Multiply/Screen) are fully
//! implemented; exotic 5.3 color modes fall back to Normal with a warning.

use std::sync::Arc;

mod frame;
mod pipelines;
mod readback;
mod resources;

#[path = "renderer_mask.rs"]
mod mask;
#[cfg(test)]
#[path = "renderer_mask_tests.rs"]
mod mask_tests;
#[path = "renderer_texture_upload.rs"]
mod texture_upload;

use bytemuck::{Pod, Zeroable};

use crate::model::{Drawable, Model, ViewTransform};

const SHADER: &str = include_str!("shader.wgsl");
const UNIFORM_STRIDE: u64 = 256;
const MASK_TEXTURE_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::R8Unorm;
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
    let (device, queue) = block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("live2d-native"),
        required_features: wgpu::Features::empty(),
        required_limits: wgpu::Limits::default(),
        experimental_features: wgpu::ExperimentalFeatures::disabled(),
        memory_hints: wgpu::MemoryHints::default(),
        trace: wgpu::Trace::Off,
    }))
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
