use super::*;

const CELL_SIZE: u32 = 4;
const MAX_MASK_CELLS: usize = 1024 * 1024;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AlphaMaskSnapshot {
    pub rect: OverlayRect,
    pub mask_width: u32,
    pub mask_height: u32,
    pub data: Vec<u8>,
}

impl AlphaMaskSnapshot {
    pub fn valid_local(&self) -> bool {
        let size = self.mask_width as usize * self.mask_height as usize;
        self.rect.valid_local() && self.mask_width > 0 && self.mask_height > 0
            && size <= MAX_MASK_CELLS && size == self.data.len()
    }

    pub fn hit(&self, x: i32, y: i32) -> bool {
        if !self.rect.contains(x, y) { return false; }
        let column = ((x - self.rect.x) as u64 * self.mask_width as u64 / self.rect.width as u64) as u32;
        let row = ((y - self.rect.y) as u64 * self.mask_height as u64 / self.rect.height as u64) as u32;
        for y in row.saturating_sub(1)..=(row + 1).min(self.mask_height - 1) {
            let start = (y * self.mask_width + column.saturating_sub(1)) as usize;
            let end = (y * self.mask_width + (column + 1).min(self.mask_width - 1)) as usize;
            if self.data[start..=end].iter().any(|&alpha| alpha > 16) { return true; }
        }
        false
    }
}

pub(super) struct MaskReadback {
    pipeline: wgpu::ComputePipeline,
    target: Option<MaskTarget>,
    pending: Option<Receiver<Result<(), wgpu::BufferAsyncError>>>,
    captured_framing: crate::live2d_framing::StageFraming,
    captured_at: Instant,
}

struct MaskTarget {
    view: wgpu::TextureView,
    bind_group: wgpu::BindGroup,
    buffer: wgpu::Buffer,
    staging: wgpu::Buffer,
    width: u32,
    height: u32,
    format: wgpu::TextureFormat,
    mask_width: u32,
    mask_height: u32,
}

impl MaskReadback {
    pub(super) fn new(device: &wgpu::Device) -> Self {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("live2d alpha mask"),
            source: wgpu::ShaderSource::Wgsl(include_str!("alpha_mask.wgsl").into()),
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("live2d alpha downsample"),
            layout: None,
            module: &module,
            entry_point: Some("main"),
            compilation_options: Default::default(),
            cache: None,
        });
        Self {
            pipeline, target: None, pending: None,
            captured_framing: Default::default(),
            captured_at: Instant::now() - Duration::from_secs(1),
        }
    }

    pub(super) fn collect(&mut self, rect: OverlayRect, framing: crate::live2d_framing::StageFraming) -> Option<AlphaMaskSnapshot> {
        let result = match self.pending.as_ref()?.try_recv() {
            Err(TryRecvError::Empty) => return None,
            result => result,
        };
        self.pending = None;
        let target = self.target.as_ref()?;
        if !matches!(result, Ok(Ok(()))) { return None; }
        let current = (target.width, target.height) == (rect.width, rect.height) && self.captured_framing == framing;
        let snapshot = current.then(|| {
            let length = (target.mask_width * target.mask_height) as usize;
            // Compute packs four alpha bytes per little-endian word.
            let data = target.staging.slice(..).get_mapped_range()[..length].to_vec();
            AlphaMaskSnapshot {
                rect: OverlayRect { x: 0, y: 0, ..rect },
                mask_width: target.mask_width,
                mask_height: target.mask_height,
                data,
            }
        });
        target.staging.unmap();
        snapshot
    }

    pub(super) fn capture_target(
        &mut self,
        device: &wgpu::Device,
        rect: OverlayRect,
        format: wgpu::TextureFormat,
        framing: crate::live2d_framing::StageFraming,
        interval: Duration,
        needs_mask: bool,
    ) -> Option<&wgpu::TextureView> {
        if self.pending.is_some() { return None; }
        let matching = self.target.as_ref().is_some_and(|target| {
            (target.width, target.height, target.format) == (rect.width, rect.height, format)
        });
        if matching && !needs_mask && self.captured_framing == framing && self.captured_at.elapsed() < interval {
            return None;
        }
        if !matching {
            let mask_width = rect.width.div_ceil(CELL_SIZE);
            let mask_height = rect.height.div_ceil(CELL_SIZE);
            let cells = (mask_width * mask_height) as usize;
            if cells > MAX_MASK_CELLS { return None; }
            let texture = device.create_texture(&wgpu::TextureDescriptor {
                label: Some("live2d captured frame"),
                size: wgpu::Extent3d { width: rect.width, height: rect.height, depth_or_array_layers: 1 },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format,
                usage: wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::TEXTURE_BINDING,
                view_formats: &[],
            });
            let view = texture.create_view(&Default::default());
            let buffer = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("live2d alpha mask"),
                size: cells.next_multiple_of(4) as u64,
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            });
            let staging = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("live2d alpha readback"),
                size: buffer.size(),
                usage: wgpu::BufferUsages::MAP_READ | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            });
            let bind_group = device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.pipeline.get_bind_group_layout(0),
                entries: &[
                    wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
                    wgpu::BindGroupEntry { binding: 1, resource: buffer.as_entire_binding() },
                ],
            });
            self.target = Some(MaskTarget { view, bind_group, buffer, staging, width: rect.width, height: rect.height, format, mask_width, mask_height });
        }
        self.captured_at = Instant::now();
        self.captured_framing = framing;
        self.target.as_ref().map(|target| &target.view)
    }

    pub(super) fn encode(&self, encoder: &mut wgpu::CommandEncoder) {
        let Some(target) = &self.target else { return; };
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &target.bind_group, &[]);
        // A workgroup covers up to 256 mask cells.
        pass.dispatch_workgroups((target.mask_width * target.mask_height).div_ceil(256), 1, 1);
        drop(pass);
        encoder.copy_buffer_to_buffer(&target.buffer, 0, &target.staging, 0, target.buffer.size());
    }

    pub(super) fn map(&mut self) {
        let Some(target) = &self.target else { return; };
        let (tx, rx) = channel();
        target.staging.slice(..).map_async(wgpu::MapMode::Read, move |result| { let _ = tx.send(result); });
        self.pending = Some(rx);
    }
}
