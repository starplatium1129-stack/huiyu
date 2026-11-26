use super::*;

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

// One bit per 2×2 physical pixels. Mixed cells stay click-through, so a
// transparent hole never turns opaque when the mask is reduced.
pub(super) struct PaintedPixels {
    framing: crate::live2d_framing::StageFraming,
    width: u32,
    height: u32,
    bits: Vec<u8>,
}

impl PaintedPixels {
    pub(super) fn hit(&self, rect: OverlayRect, framing: crate::live2d_framing::StageFraming, x: i32, y: i32) -> bool {
        if self.framing != framing || (self.width, self.height) != (rect.width, rect.height)
            || x < 0 || y < 0 || x as u32 >= self.width || y as u32 >= self.height {
            return false;
        }
        let stride = self.width.div_ceil(2).div_ceil(32) as usize * 4;
        let (column, row) = (x as usize / 2, y as usize / 2);
        self.bits[row * stride + column / 8] & (1 << (column % 8)) != 0
    }

    pub(super) fn pointer_sample(&self, frame: OverlayRect, framing: crate::live2d_framing::StageFraming, x: i32, y: i32) -> Option<PointerHitSample> {
        if self.framing != framing || (self.width, self.height) != (frame.width, frame.height)
            || !frame.contains(x, y)
        {
            return None;
        }
        let column = (x.abs_diff(frame.x) / 2).saturating_sub(16);
        let first_row = (y.abs_diff(frame.y) / 2).saturating_sub(16);
        let stride = self.width.div_ceil(2).div_ceil(32) as usize * 4;
        let mut rows = [0u32; 32];
        for (index, output) in rows.iter_mut().enumerate() {
            let y = first_row as usize + index;
            if y >= self.height.div_ceil(2) as usize { break; }
            let source_row = &self.bits[y * stride..(y + 1) * stride];
            let start = (column / 32) as usize * 4;
            let shift = column % 32;
            let low = u32::from_le_bytes(source_row[start..start + 4].try_into().ok()?);
            let high = source_row.get(start + 4..start + 8)
                .and_then(|bytes| bytes.try_into().ok())
                .map(u32::from_le_bytes).unwrap_or(0);
            *output = if shift == 0 { low } else { (low >> shift) | (high << (32 - shift)) };
        }
        Some(PointerHitSample { frame, column, first_row, rows })
    }
}

/// Private renderer-to-host shape sample around the physical cursor, bounded
/// to 128 bytes of mask data. Never serialize it to a WebView.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PointerHitSample {
    frame: OverlayRect,
    column: u32,
    first_row: u32,
    rows: [u32; 32],
}

impl PointerHitSample {
    fn local_cell(&self, frame: OverlayRect, x: i32, y: i32) -> Option<(u32, usize)> {
        if self.frame != frame || !frame.contains(x, y) { return None; }
        let column = (x.abs_diff(frame.x) / 2).checked_sub(self.column)?;
        let row = (y.abs_diff(frame.y) / 2).checked_sub(self.first_row)? as usize;
        (column < 32 && row < self.rows.len()).then_some((column, row))
    }

    pub(super) fn covers(&self, frame: OverlayRect, x: i32, y: i32) -> bool {
        self.local_cell(frame, x, y).is_some()
    }

    pub(crate) fn hit(&self, frame: OverlayRect, x: i32, y: i32) -> bool {
        self.local_cell(frame, x, y)
            .is_some_and(|(column, row)| self.rows[row] & (1 << column) != 0)
    }
}

pub(super) struct MaskReadback {
    pipeline: wgpu::ComputePipeline,
    target: Option<MaskTarget>,
    pending: Option<Receiver<Result<(), wgpu::BufferAsyncError>>>,
    captured_framing: crate::live2d_framing::StageFraming,
    captured_at: Instant,
    cursor_near: bool,
}

pub(super) struct MaskTarget {
    pub(super) view: wgpu::TextureView,
    pub(super) blit_bind_group: wgpu::BindGroup,
    bind_group: wgpu::BindGroup,
    buffer: wgpu::Buffer,
    staging: wgpu::Buffer,
    width: u32,
    height: u32,
    format: wgpu::TextureFormat,
}

impl MaskReadback {
    pub(super) fn new(device: &wgpu::Device) -> Self {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("live2d alpha mask"),
            source: wgpu::ShaderSource::Wgsl(include_str!("alpha_mask.wgsl").into()),
        });
        let pipeline = device.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("live2d painted pixels"),
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
            cursor_near: false,
        }
    }

    pub(super) fn collect(&mut self, rect: OverlayRect, framing: crate::live2d_framing::StageFraming) -> Option<PaintedPixels> {
        let result = match self.pending.as_ref()?.try_recv() {
            Err(TryRecvError::Empty) => return None,
            result => result,
        };
        self.pending = None;
        let target = self.target.as_ref()?;
        if !matches!(result, Ok(Ok(()))) { return None; }
        let current = (target.width, target.height) == (rect.width, rect.height) && self.captured_framing == framing;
        let snapshot = current.then(|| PaintedPixels {
            framing,
            width: target.width,
            height: target.height,
            bits: target.staging.slice(..).get_mapped_range().to_vec(),
        });
        target.staging.unmap();
        snapshot
    }

    pub(super) fn capture_target(
        &mut self,
        renderer: &Renderer,
        rect: OverlayRect,
        format: wgpu::TextureFormat,
        framing: crate::live2d_framing::StageFraming,
        interval: Duration,
        needs_mask: bool,
        cursor_near: bool,
    ) -> Option<&MaskTarget> {
        if self.pending.is_some() { return None; }
        let cursor_entered = cursor_near && !self.cursor_near;
        self.cursor_near = cursor_near;
        let matching = self.target.as_ref().is_some_and(|target| {
            (target.width, target.height, target.format) == (rect.width, rect.height, format)
        });
        if matching && !needs_mask && self.captured_framing == framing
            && !(cursor_near && (cursor_entered || self.captured_at.elapsed() >= interval))
        {
            return None;
        }
        if !matching {
            let device = &renderer.device;
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
                size: u64::from(rect.width.div_ceil(2).div_ceil(32)) * u64::from(rect.height.div_ceil(2)) * 4,
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
            let blit_bind_group = renderer.create_blit_bind_group(&view);
            self.target = Some(MaskTarget { view, blit_bind_group, bind_group, buffer, staging, width: rect.width, height: rect.height, format });
        }
        self.captured_at = Instant::now();
        self.captured_framing = framing;
        self.target.as_ref()
    }

    pub(super) fn encode(&self, encoder: &mut wgpu::CommandEncoder) {
        let Some(target) = &self.target else { return; };
        let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor::default());
        pass.set_pipeline(&self.pipeline);
        pass.set_bind_group(0, &target.bind_group, &[]);
        // Each invocation packs 32 half-resolution cells in one word.
        pass.dispatch_workgroups(target.width.div_ceil(2 * 32 * 8), target.height.div_ceil(2 * 8), 1);
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
