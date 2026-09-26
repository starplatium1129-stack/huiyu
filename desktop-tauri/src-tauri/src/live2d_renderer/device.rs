use super::*;

impl RenderContext {
    pub(super) fn new() -> Result<Self, String> {
        let instance = wgpu::Instance::new(&wgpu::InstanceDescriptor {
            backends: wgpu::Backends::DX12,
            flags: Default::default(),
            memory_budget_thresholds: Default::default(),
            backend_options: wgpu::BackendOptions {
                dx12: wgpu::Dx12BackendOptions {
                    presentation_system: wgpu_types::Dx12SwapchainKind::DxgiFromVisual,
                    ..Default::default()
                },
                ..Default::default()
            },
        });
        let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: None,
            force_fallback_adapter: false,
        }))
        .map_err(|e| format!("no adapter: {e}"))?;
        eprintln!(
            "[live2d] adapter: {:?} backend={:?}",
            adapter.get_info().name,
            adapter.get_info().backend
        );
        let (device, queue) = pollster::block_on(adapter.request_device(
            &wgpu::DeviceDescriptor {
                label: Some("live2d-overlay"),
                required_features: wgpu::Features::empty(),
                required_limits: wgpu::Limits::default(),
                experimental_features: wgpu::ExperimentalFeatures::disabled(),
                memory_hints: wgpu::MemoryHints::default(),
                trace: wgpu::Trace::Off,
            },
        ))
        .map_err(|e| format!("no device: {e}"))?;
        // 设备丢失回调：wgpu 只在 poll 时触发，渲染循环每帧 Poll 一次来驱动它。
        // 标记置位后由渲染线程停止并上报，前端据此提示重试（重新拉起线程即
        // 重新建 device），不必重启整个应用。
        device.set_device_lost_callback(|reason, message| {
            if let Ok(mut slot) = DEVICE_LOST_DETAIL.lock() {
                *slot = Some(format!("{reason:?}: {message}"));
            }
            DEVICE_LOST.store(true, Ordering::SeqCst);
        });
        device.on_uncaptured_error(std::sync::Arc::new(|error: wgpu::Error| {
            let seen = RENDER_ERROR_COUNT.fetch_add(1, Ordering::Relaxed);
            if seen < RENDER_ERROR_LOG_LIMIT {
                eprintln!("[live2d] wgpu error: {error}");
            }
        }));
        Ok(Self {
            instance,
            adapter,
            device,
            queue,
            surface: None,
            surface_format: wgpu::TextureFormat::Rgba8UnormSrgb,
            surface_alpha_mode: wgpu::CompositeAlphaMode::PreMultiplied,
            renderer: None,
            model: None,
            fit_bounds: None,
            textures: Vec::new(),
            mouth_level: 0.0,
            emotion: None,
            gaze: (0.0, 0.0),
            character: None,
            profile: None,
            overlay_settler: None,
            hit_area_names: Vec::new(),
            motion_counts: HashMap::new(),
            motion_durations: HashMap::new(),
            motion_last_indices: HashMap::new(),
            motion_seed: 0x9E37_79B9_7F4A_7C15 ^ u64::from(std::process::id()),
            active_motion: None,
            ready_emitted: false,
            last_rect: OverlayRect::default(),
            surface_failures: 0,
            surface_recoveries: 0,
            blink: BlinkState::new(),
        })
    }

    pub(super) fn ensure_surface(&mut self, hwnd: HWND) -> Result<(), String> {
        if self.surface.is_some() {
            return Ok(());
        }
        use raw_window_handle::{
            RawDisplayHandle, RawWindowHandle, Win32WindowHandle, WindowsDisplayHandle,
        };
        use std::num::NonZeroIsize;
        let win32 = Win32WindowHandle::new(NonZeroIsize::new(hwnd as isize).ok_or("hwnd=0")?);
        // 窗口句柄的生命周期由本线程独占保证（窗口线程创建/持有 HWND）。
        let surface = unsafe {
            self.instance
                .create_surface_unsafe(wgpu::SurfaceTargetUnsafe::RawHandle {
                    raw_display_handle: RawDisplayHandle::Windows(WindowsDisplayHandle::new()),
                    raw_window_handle: RawWindowHandle::Win32(win32),
                })
        }
        .map_err(|e| format!("create_surface: {e}"))?;
        let caps = surface.get_capabilities(&self.adapter);
        let format = caps
            .formats
            .iter()
            .copied()
            .find(|f| f.is_srgb())
            .or_else(|| caps.formats.first().copied())
            .ok_or("surface has no formats")?;
        if !caps
            .alpha_modes
            .contains(&wgpu::CompositeAlphaMode::PreMultiplied)
        {
            return Err(format!(
                "surface does not advertise premultiplied alpha: {:?}",
                caps.alpha_modes
            ));
        }
        self.surface_format = format;
        self.surface_alpha_mode = wgpu::CompositeAlphaMode::PreMultiplied;
        self.surface = Some(surface);
        self.renderer = Some(Renderer::new(
            Arc::new(self.device.clone()),
            Arc::new(self.queue.clone()),
            self.surface_format,
        ));
        Ok(())
    }

    pub(super) fn configure_surface(&mut self, width: u32, height: u32) {
        if let Some(surface) = self.surface.as_ref() {
            let _ = surface.configure(
                &self.device,
                &wgpu::SurfaceConfiguration {
                    usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
                    format: self.surface_format,
                    width: width.max(1),
                    height: height.max(1),
                    present_mode: wgpu::PresentMode::AutoVsync,
                    alpha_mode: self.surface_alpha_mode,
                    view_formats: vec![],
                    desired_maximum_frame_latency: 2,
                },
            );
        }
    }

    /// 就地重建 surface（surface 卡死自愈）：丢弃 surface 与 renderer，下一帧
    /// 由 render_frame 的 ensure_surface 重新创建。
    /// 两点必须一起做：renderer 持有 device/queue 克隆并缓存 surface format 与
    /// 2x 离屏目标，不重建会与新 surface 失配导致 blit 被丢弃（又退化成雪花）；
    /// last_rect 必须归零，否则下一帧会因"尺寸未变"跳过 configure_surface。
    /// 模型纹理属于 device，device 未变时无需重传；模型 GPU 缓存由 draw_frame
    /// 的 ensure_model_cache 自动重建。
    pub(super) fn reset_surface(&mut self) {
        self.surface = None;
        self.renderer = None;
        self.last_rect = OverlayRect::default();
        self.surface_failures = 0;
        self.surface_recoveries += 1;
    }
}
