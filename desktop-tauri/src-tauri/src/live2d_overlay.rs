//! 路径 B 壳侧：DirectComposition 透明 overlay 窗口 + aics_live2d_* IPC 命令。
//!
//! 契约：src/types/live2dNative.ts + docs/live2d-native-overlay-plan.md。
//! 渲染线程持 wgpu surface（绑定 overlay HWND）+ live2d-native crate 的
//! Model/Renderer；模型只由 setCharacter 创建，动作/表情/口型/情绪/凝视以
//! 意图命令经 channel 交给渲染线程执行（参数级写入由 Cubism Native 完成）。
//! overlay 位于透明 Companion WebView 下方且不接收鼠标；WebView 舞台把归一化
//! 点击坐标经 IPC 送到 Cubism HitArea，避免 Win32 window region 裁掉可见模型。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
#[path = "live2d_frame_pacing.rs"]
mod frame_pacing;
#[path = "live2d_adapter.rs"]
mod live2d_adapter;
#[path = "live2d_assets.rs"]
mod live2d_assets;
use live2d_adapter::{apply_overlay_defaults, Live2DAdapterConfig, MouthBinding, OverlaySettler};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};
use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, RECT, WPARAM};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetWindowRect, PeekMessageW,
    PostQuitMessage, RegisterClassExW, SetWindowLongPtrW, SetWindowPos, ShowWindow, TranslateMessage,
    CS_HREDRAW, CS_VREDRAW, CW_USEDEFAULT, GWLP_USERDATA, MSG, PM_REMOVE, SWP_NOACTIVATE,
    SWP_NOSIZE, SW_HIDE, SW_SHOWNA, WINDOW_EX_STYLE, WINDOW_STYLE, WM_DESTROY,
    WNDCLASSEXW, WS_EX_NOACTIVATE,
    WS_EX_NOREDIRECTIONBITMAP, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_POPUP,
};

use live2d_native::model::{self, Model, ViewTransform};
use live2d_native::renderer::{self, Renderer};

/// overlay 矩形。IPC 输入为 Companion-local 物理像素，state/render 内为屏幕物理像素。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct OverlayRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// 连续拿不到可绘制 surface 的帧数上限（165fps 下约 0.2 秒）。
/// 原实现在 Outdated/Lost 分支"configure 后直接 return"，既没有计数也没有
/// 任何日志：一旦 swapchain 持续拿不到帧就陷入每帧 configure、永不绘制的
/// 死循环，画面停在未定义内容上（实机即"老电视雪花"），而 frameCount 停增
/// 前端也无从分辨——visible/ready 仍是 true，不会提示"渲染已停止"。
const SURFACE_FAILURE_LIMIT: u32 = 30;
/// 就地重建 surface 的次数上限。连续重建仍失败说明是设备级故障，停止渲染
/// 线程并上报，让前端显示"渲染已停止 / 可重试"（走既有 NATIVE_RENDER_STOPPED
/// 通路重新拉起渲染线程），用户无需重启整个桌宠进程。
const SURFACE_RECOVERY_LIMIT: u32 = 3;

/// GPU 设备丢失标记。wgpu 只在 device.poll 时调用 device lost 回调，原实现
/// 从不 poll 也从未注册回调：驱动重置 / TDR / 休眠唤醒后仍每帧 submit +
/// present 已经作废的 backbuffer，表现同样是满屏雪花且只能靠重启进程恢复。
static DEVICE_LOST: AtomicBool = AtomicBool::new(false);
static DEVICE_LOST_DETAIL: Mutex<Option<String>> = Mutex::new(None);
/// 未被捕获的 wgpu 错误计数（验证/内部/显存）。渲染路径的错误平时全部走
/// ErrorSink 被静默丢弃（queue.submit 的返回值是 ()），命令被丢弃后画面仍
/// 会 present，表现为"画面不对但日志什么都没有"。这里只累计并打印前若干条，
/// 便于事后取证，不刷屏。
static RENDER_ERROR_COUNT: AtomicU32 = AtomicU32::new(0);
const RENDER_ERROR_LOG_LIMIT: u32 = 5;

pub struct Live2DOverlayState {
    pub rect: Mutex<OverlayRect>,
    pub visible: AtomicBool,
    pub opacity: AtomicU32,
    /// HWND 以 isize 存储（HWND = *mut c_void 非 Send）。
    pub hwnd: Mutex<Option<isize>>,
    pub companion_hwnd: Mutex<Option<isize>>,
    pub companion_offset: Mutex<Option<(i32, i32)>>,
    /// 窗口线程消息循环就绪标记。
    pub window_ready: AtomicBool,
    /// 渲染线程就绪标记：true 后 setCharacter 等命令不再返回 not-attached。
    pub renderer_attached: AtomicBool,
    /// overlay/render thread 启动门控，避免并发 ensure_overlay 重复启动。
    pub starting: AtomicBool,
    /// 渲染线程的命令通道。
    pub cmd_tx: Mutex<Option<Sender<OverlayCommand>>>,
    /// 当前加载的角色（口型参数映射等）。
    pub character: Mutex<Option<String>>,
    /// 已渲染帧数（selftest/诊断用）。
    pub frame_count: AtomicU64,
    /// 最近一次 hit-test 结果（selftest 断言用；app=None 时无事件可发）。
    pub hit_test_result: Mutex<Option<Vec<String>>>,
    /// 模型可见内容的大致屏幕矩形，仅用于诊断。
    pub model_bounds: Mutex<Option<OverlayRect>>,
    /// 原生渲染循环目标帧率。
    pub target_fps: AtomicU32,
    /// 模型 ready 标记：setCharacter 成功后置 true，前端 onReady 订阅前先查
    /// 此状态（一次性 ready 事件在订阅前发出会丢失，导致前端 connect 超时）。
    pub model_ready: AtomicBool,
    /// 最近一次规范化口型意图与角色映射值，仅供只读发布验收诊断。
    pub last_mouth_level: AtomicU32,
    pub last_mapped_mouth_value: AtomicU32,
    /// 连续拿不到可绘制 surface 的帧数（镜像渲染线程计数，供诊断取证）。
    /// 持续 > 0 说明 swapchain 拿不到帧，是"画面雪花/冻结"的直接指标。
    pub surface_failures: AtomicU32,
    /// 已就地重建 surface 的次数（镜像渲染线程计数）。
    pub surface_recoveries: AtomicU32,
}

impl Default for Live2DOverlayState {
    fn default() -> Self {
        Self {
            rect: Mutex::new(OverlayRect::default()),
            visible: AtomicBool::new(false),
            opacity: AtomicU32::new(255),
            hwnd: Mutex::new(None),
            companion_hwnd: Mutex::new(None),
            companion_offset: Mutex::new(None),
            window_ready: AtomicBool::new(false),
            renderer_attached: AtomicBool::new(false),
            starting: AtomicBool::new(false),
            cmd_tx: Mutex::new(None),
            character: Mutex::new(None),
            frame_count: AtomicU64::new(0),
            hit_test_result: Mutex::new(None),
            model_bounds: Mutex::new(None),
            target_fps: AtomicU32::new(165),
            model_ready: AtomicBool::new(false),
            last_mouth_level: AtomicU32::new(0.0f32.to_bits()),
            last_mapped_mouth_value: AtomicU32::new(0.0f32.to_bits()),
            surface_failures: AtomicU32::new(0),
            surface_recoveries: AtomicU32::new(0),
        }
    }
}

fn reset_mouth_diagnostics(state: &Live2DOverlayState) {
    state
        .last_mouth_level
        .store(0.0f32.to_bits(), Ordering::SeqCst);
    state
        .last_mapped_mouth_value
        .store(0.0f32.to_bits(), Ordering::SeqCst);
}

/// 清空"已加载模型"状态（setCharacter 前置与 destroy 共用）。
/// 只动模型级状态，保留 window_ready/renderer_attached/cmd_tx：
/// destroy 契约 = 释放模型与资源、隐藏 overlay，但渲染线程与窗口长期
/// 复用，后续 setCharacter 可直接重新加载（避免重建 wgpu 上下文）。
fn clear_model_state(state: &Live2DOverlayState) {
    state.model_ready.store(false, Ordering::SeqCst);
    *state.character.lock().unwrap() = None;
    *state.model_bounds.lock().unwrap() = None;
    reset_mouth_diagnostics(state);
}

fn try_begin_startup(state: &Live2DOverlayState) -> bool {
    if state.window_ready.load(Ordering::SeqCst)
        || state.renderer_attached.load(Ordering::SeqCst)
    {
        return false;
    }
    state
        .starting
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

fn reset_runtime_state(state: &Live2DOverlayState) {
    *state.cmd_tx.lock().unwrap() = None;
    *state.hwnd.lock().unwrap() = None;
    *state.companion_hwnd.lock().unwrap() = None;
    *state.companion_offset.lock().unwrap() = None;
    state.window_ready.store(false, Ordering::SeqCst);
    state.renderer_attached.store(false, Ordering::SeqCst);
    state.starting.store(false, Ordering::SeqCst);
    state.visible.store(false, Ordering::SeqCst);
    state.model_ready.store(false, Ordering::SeqCst);
    *state.character.lock().unwrap() = None;
    *state.model_bounds.lock().unwrap() = None;
    reset_mouth_diagnostics(state);
    // 渲染线程退出即丢弃 RenderContext，计数随之重建；镜像值同步清零，
    // 否则新线程起来后 state 里还留着上一代的故障计数，误导诊断。
    state.surface_failures.store(0, Ordering::Relaxed);
    state.surface_recoveries.store(0, Ordering::Relaxed);
    DEVICE_LOST.store(false, Ordering::SeqCst);
    if let Ok(mut slot) = DEVICE_LOST_DETAIL.lock() {
        *slot = None;
    }
}

static OVERLAY_STATE_INIT: OnceLock<Mutex<()>> = OnceLock::new();

fn followed_overlay_rect(
    current: OverlayRect,
    companion_x: i32,
    companion_y: i32,
    offset: (i32, i32),
) -> OverlayRect {
    OverlayRect {
        x: companion_x + offset.0,
        y: companion_y + offset.1,
        ..current
    }
}

// ---------------- 命令 ----------------

/// 意图命令：IPC → 渲染线程。带 reply 的等待同步结果；Async 变体由
/// WndProc 发出（点击命中），渲染线程算完直接 emit 事件。
pub enum OverlayCommand {
    SetCharacter {
        character: String,
        texture_scale: u32,
        adapter: Live2DAdapterConfig,
        reply: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    PlayMotion {
        group: String,
        index: Option<i64>,
        priority: Option<String>,
        reply: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    SetExpression {
        name: String,
        reply: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    SetMouthLevel(f32),
    SetEmotion {
        name: String,
        intensity: f32,
    },
    SetGaze(f32, f32),
    SetMaxFps(u32),
    HitTestAsync {
        x: f32,
        y: f32,
    },
    HitTest {
        x: f32,
        y: f32,
        reply: tokio::sync::oneshot::Sender<Result<Vec<String>, String>>,
    },
    Snapshot {
        path: String,
        reply: tokio::sync::oneshot::Sender<Result<(), String>>,
    },
    Destroy {
        reply: tokio::sync::oneshot::Sender<()>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MotionPhase {
    Entrance,
    Idle,
    Interaction,
}

/// 覆盖式眨眼状态机（2026-08-16 眼睛灰修复，对齐浏览器 blinkScheduler）：
/// 夏目作者 Idle 眼曲线长期闭/半闭且左右眼不同步（ParamEyeLOpen /
/// ParamEyeLOpen2 长时间一闭一睁），native 此前无任何参数覆写，眼睛在
/// Idle 下灰暗无神（用户反馈：常态眼睛发灰、点互动动作时正常、回 idle 又灰）。
/// 每帧把双眼参数写同一值（1=睁、0=闭），间隔随机 2.5-5s、单次眨眼约
/// 0.31s（closing 0.09s / closed 0.06s / opening 0.16s），与前端
/// `blinkScheduler.ts` 完全同参。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BlinkPhase {
    Open,
    Closing,
    Closed,
    Opening,
}

#[derive(Clone, Copy, Debug)]
struct BlinkState {
    phase: BlinkPhase,
    phase_elapsed: f32,
    timer_ms: f32,
    seed: u64,
}

impl BlinkState {
    const CLOSING_S: f32 = 0.09;
    const CLOSED_S: f32 = 0.06;
    const OPENING_S: f32 = 0.16;
    const MIN_INTERVAL_MS: f32 = 2500.0;
    const MAX_INTERVAL_MS: f32 = 5000.0;

    fn new() -> Self {
        let mut state = Self {
            phase: BlinkPhase::Open,
            phase_elapsed: 0.0,
            timer_ms: 0.0,
            seed: 0x9E37_79B9_7F4A_7C15 ^ u64::from(std::process::id()) ^ 0x0DDB_1A5E_5BAD_5EED,
        };
        state.timer_ms = state.next_delay();
        state
    }

    /// xorshift32 风格随机（复用渲染线程 motion_seed 的同款 RNG）。
    fn next_random(&mut self) -> f32 {
        self.seed ^= self.seed << 13;
        self.seed ^= self.seed >> 7;
        self.seed ^= self.seed << 17;
        (self.seed & 0xFFFF) as f32 / 65536.0
    }

    fn next_delay(&mut self) -> f32 {
        Self::MIN_INTERVAL_MS + self.next_random() * (Self::MAX_INTERVAL_MS - Self::MIN_INTERVAL_MS)
    }

    fn value(&self) -> f32 {
        match self.phase {
            BlinkPhase::Open => 1.0,
            BlinkPhase::Closing => 1.0 - (self.phase_elapsed / Self::CLOSING_S).min(1.0),
            BlinkPhase::Closed => 0.0,
            BlinkPhase::Opening => (self.phase_elapsed / Self::OPENING_S).min(1.0),
        }
    }

    fn update(&mut self, dt: f32) -> f32 {
        let dt = dt.clamp(0.0, 0.25);
        self.phase_elapsed += dt;
        match self.phase {
            BlinkPhase::Open => {
                self.timer_ms -= dt * 1000.0;
                if self.timer_ms <= 0.0 {
                    self.phase = BlinkPhase::Closing;
                    self.phase_elapsed = 0.0;
                }
            }
            BlinkPhase::Closing => {
                if self.phase_elapsed >= Self::CLOSING_S {
                    self.phase = BlinkPhase::Closed;
                    self.phase_elapsed = 0.0;
                }
            }
            BlinkPhase::Closed => {
                if self.phase_elapsed >= Self::CLOSED_S {
                    self.phase = BlinkPhase::Opening;
                    self.phase_elapsed = 0.0;
                }
            }
            BlinkPhase::Opening => {
                if self.phase_elapsed >= Self::OPENING_S {
                    self.phase = BlinkPhase::Open;
                    self.phase_elapsed = 0.0;
                    self.timer_ms = self.next_delay();
                }
            }
        }
        self.value()
    }
}

#[derive(Clone, Debug)]
struct ActiveMotion {
    handle: model::MotionHandle,
    phase: MotionPhase,
    group: String,
    index: i32,
    remaining_seconds: Option<f32>,
}

/// 同一互动组正在播放时，重复点击必须拒绝（不能 force 重启）。
fn would_reject_interaction(active: Option<&ActiveMotion>, group: &str) -> bool {
    matches!(active, Some(active) if active.phase == MotionPhase::Interaction && active.group == group)
}

struct RenderContext {
    instance: wgpu::Instance,
    adapter: wgpu::Adapter,
    device: wgpu::Device,
    queue: wgpu::Queue,
    surface: Option<wgpu::Surface<'static>>,
    surface_format: wgpu::TextureFormat,
    surface_alpha_mode: wgpu::CompositeAlphaMode,
    renderer: Option<Renderer>,
    model: Option<Model>,
    textures: Vec<renderer::Texture>,
    mouth_level: f32,
    emotion: Option<(String, f32)>,
    gaze: (f32, f32),
    character: Option<String>,
    profile: Option<Live2DAdapterConfig>,
    overlay_settler: Option<OverlaySettler>,
    hit_area_names: Vec<String>,
    motion_counts: HashMap<String, usize>,
    motion_durations: HashMap<String, Vec<f32>>,
    motion_last_indices: HashMap<String, usize>,
    motion_seed: u64,
    active_motion: Option<ActiveMotion>,
    ready_emitted: bool,
    last_rect: OverlayRect,
    /// 连续拿不到可绘制 surface 的帧数，见 SURFACE_FAILURE_LIMIT。
    surface_failures: u32,
    /// 已就地重建 surface 的次数，见 SURFACE_RECOVERY_LIMIT。
    surface_recoveries: u32,
    blink: BlinkState,
}

impl RenderContext {
    fn new() -> Result<Self, String> {
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

    fn ensure_surface(&mut self, hwnd: HWND) -> Result<(), String> {
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

    fn configure_surface(&mut self, width: u32, height: u32) {
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
    fn reset_surface(&mut self) {
        self.surface = None;
        self.renderer = None;
        self.last_rect = OverlayRect::default();
        self.surface_failures = 0;
        self.surface_recoveries += 1;
    }
}

/// 按角色配置的"永不绘制" drawable 列表（产品修复，仅影响渲染，不影响
/// 命中区/动作）。夏目源模型自带三块可见的矩形底板/外框 drawable
/// （101/102/104，4 顶点），在透明桌宠窗口上呈现为用户投诉的"透明框"；
/// 宁宁模型没有这类 drawable，列表为空。
fn hidden_drawables_for(character: &str) -> Vec<i32> {
    match character {
        "natsume" => vec![101, 102, 104],
        _ => Vec::new(),
    }
}

impl RenderContext {
    fn load_model(
        &mut self,
        assets_root: &std::path::Path,
        character: &str,
        texture_scale: u32,
        profile: Live2DAdapterConfig,
        local_root: Option<&std::path::Path>,
    ) -> Result<(), String> {
        if let Some(renderer) = self.renderer.as_mut() {
            renderer.release_model_resources();
        }
        self.model = None;
        self.textures.clear();
        self.character = None;
        self.profile = None;
        self.overlay_settler = None;
        self.hit_area_names.clear();
        self.motion_counts.clear();
        self.motion_durations.clear();
        self.motion_last_indices.clear();
        self.active_motion = None;
        self.ready_emitted = false;
        let files = live2d_assets::resolve_model(assets_root, local_root, character, &profile.profile_id)?;
        let dir = files.directory;
        let moc_path = files.moc;
        let model3_path = files.manifest;
        let moc = std::fs::read(&moc_path).map_err(|e| e.to_string())?;
        let model3_bytes = std::fs::read(&model3_path).map_err(|e| e.to_string())?;
        let manifest = model::parse_model3(&model3_bytes)?;
        let motion_counts = manifest
            .file_references
            .as_ref()
            .map(|refs| {
                refs.motions
                    .iter()
                    .map(|(group, motions)| (group.clone(), motions.len()))
                    .collect()
            })
            .unwrap_or_default();
        let mut motion_durations: HashMap<String, Vec<f32>> = HashMap::new();

        let mut m = Model::create(&moc, &model3_bytes)?;
        m.set_hidden_drawables(&hidden_drawables_for(character));
        let mut textures: Vec<renderer::Texture> = Vec::new();
        if let Some(refs) = &manifest.file_references {
            if let Some(physics) = &refs.physics {
                let data = std::fs::read(dir.join(physics)).map_err(|e| e.to_string())?;
                m.load_physics(&data)?;
            }
            if let Some(pose) = &refs.pose {
                let data = std::fs::read(dir.join(pose)).map_err(|e| e.to_string())?;
                m.load_pose(&data)?;
            }
            for expr in &refs.expressions {
                let data = std::fs::read(dir.join(&expr.file)).map_err(|e| e.to_string())?;
                m.add_expression(&expr.name, &data)?;
            }
            for (group, motions) in &refs.motions {
                for (idx, mr) in motions.iter().enumerate() {
                    let data = std::fs::read(dir.join(&mr.file)).map_err(|e| e.to_string())?;
                    let duration = serde_json::from_slice::<serde_json::Value>(&data)
                        .ok()
                        .and_then(|value| value.get("Meta")?.get("Duration")?.as_f64())
                        .filter(|value| value.is_finite() && *value > 0.0)
                        .map(|value| value as f32)
                        .unwrap_or(5.0);
                    motion_durations
                        .entry(group.clone())
                        .or_default()
                        .push(duration);
                    m.add_motion(group, idx as i32, &data)?;
                }
            }
            let renderer = self.renderer.as_mut().ok_or("renderer not created")?;
            for (ti, tex) in refs.textures.iter().enumerate() {
                let path = dir.join(tex);
                let t0 = Instant::now();
                let img = image::open(&path)
                    .map_err(|e| format!("open texture {}: {e}", path.display()))?
                    .to_rgba8();
                let (w, h) = img.dimensions();
                let (w, h) = frame_pacing::texture_dimensions(w, h, texture_scale);
                let img = if texture_scale > 1 {
                    image::imageops::resize(&img, w, h, image::imageops::FilterType::Lanczos3)
                } else { img };
                textures.push(renderer.load_texture(&img.into_raw(), w, h));
                eprintln!(
                    "[live2d] texture {}/{} {w}x{h} {:.2}s",
                    ti + 1,
                    refs.textures.len(),
                    t0.elapsed().as_secs_f32()
                );
            }
            if textures.is_empty() {
                return Err("no textures".to_string());
            }
        }
        self.model = Some(m);
        self.textures = textures;
        self.character = Some(character.to_string());
        self.profile = Some(profile);
        self.hit_area_names = manifest.hit_areas.iter().map(|h| h.name.clone()).collect();
        self.motion_counts = motion_counts;
        self.motion_durations = motion_durations;
        Ok(())
    }

    /// 每帧意图应用（口型/情绪/凝视）+ 模型 update。
    fn step(&mut self, dt: f32) {
        let Some(model) = self.model.as_mut() else {
            return;
        };
        model.update(dt);
        // 覆写参数必须在 UpdateMotion 之后：动作曲线每帧写回参数，
        // 先写会被动作覆盖（实测 TapHead 播放中口型始终为动作姿态）。
        if let (Some(profile), Some((name, intensity))) = (self.profile.as_ref(), self.emotion.clone()) {
            profile.apply_emotion(model, &name, intensity);
        }
        if let Some((param, value)) = self.profile.as_ref().and_then(|profile| profile.mouth_value(self.mouth_level)) {
            if model.parameter_index(param).is_some() {
                model.set_parameter(param, value, 0.7);
            }
        }
        let (gx, gy) = self.gaze;
        if gx != 0.0 || gy != 0.0 {
            let focus = self.profile.as_ref().map(|profile| profile.focus.as_slice()).unwrap_or_default();
            for (id, value, weight) in [
                ("ParamAngleX", 30.0 * gx, 0.6), ("ParamAngleY", 30.0 * gy, 0.6),
                ("ParamEyeBallX", gx, 0.8), ("ParamEyeBallY", gy, 0.8),
            ] {
                if focus.iter().any(|candidate| candidate == id) {
                    model.set_parameter(id, value, weight);
                }
            }
        }
        // 覆盖式眨眼（2026-08-16 眼睛灰修复）：作者 Idle 眼曲线长期闭/半闭
        // 且左右眼不同步，native 无覆写时眼睛灰暗无神。与浏览器 blinkScheduler
        // 对齐：双眼每帧写同一值（1=睁、0=闭，weight 1 压过动作曲线）；
        // 登场（Start 组）期间暂停——作者登场眼曲线左右同步且含开场闭眼，
        // 原样呈现（对齐前端 entranceUntil 逻辑）。
        let in_entrance = matches!(&self.active_motion, Some(m) if m.phase == MotionPhase::Entrance);
        if !in_entrance {
            let blink_value = self.blink.update(dt);
            for id in self.profile.as_ref().map(|profile| profile.blink.as_slice()).unwrap_or_default() {
                if model.parameter_index(id).is_some() {
                    model.set_parameter(id, blink_value, 1.0);
                }
            }
        }
        // 叠层参数每帧守卫（2026-08-16 静止发灰修复）：Idle 动作 Idle_6 把
        // Param36/37 拉出隐藏态（到 5+），静止时叠层显示 → 眼睛/全身发灰；
        // 点击互动（Tap 动作/复位）拉回隐藏态 → 恢复，回 Idle 又灰。非互动
        // 非登场期间每帧强制写回隐藏态（0/-1 分组，与 reset_overlay_params
        // 同表）——叠层只允许在互动/登场动作播放时显示。
        // 2026-08-23 换装闪回修复：动作结束后的回落改为 smoothstep 缓动
        // （step_overlay_settle），回落期间跳过硬性守卫；回落结束恢复守卫。
        // 原单帧硬写会让换装部件一帧内消失/回穿（桌宠实机"闪一下"）。
        let interaction_playing = matches!(
            &self.active_motion,
            Some(m) if m.phase == MotionPhase::Interaction || m.phase == MotionPhase::Entrance
        );
        if !interaction_playing {
            let settling = self.overlay_settler.as_mut().is_some_and(|settler| settler.step(model, dt));
            if !settling {
                self.overlay_settler = None;
                if let Some(config) = self.profile.as_ref().and_then(|profile| profile.overlay_settle.as_ref()) {
                    apply_overlay_defaults(model, config);
                }
            }
        }
    }

    fn render_frame(
        &mut self,
        state: &Live2DOverlayState,
        hwnd: HWND,
        rect: OverlayRect,
    ) -> Result<bool, String> {
        if rect.width == 0 || rect.height == 0 {
            return Ok(false);
        }
        if self.model.is_none() || self.renderer.is_none() {
            return Ok(false);
        }
        if self.surface.is_none() {
            self.ensure_surface(hwnd)?;
            self.configure_surface(rect.width, rect.height);
        }
        if self.last_rect.width != rect.width || self.last_rect.height != rect.height {
            self.configure_surface(rect.width, rect.height);
            self.last_rect = rect;
        }
        let surface = self.surface.as_ref().ok_or("no surface")?;
        let frame = match surface.get_current_texture() {
            Ok(frame) => {
                if self.surface_failures != 0 {
                    self.surface_failures = 0;
                    state.surface_failures.store(0, Ordering::Relaxed);
                }
                frame
            }
            Err(wgpu::SurfaceError::Outdated | wgpu::SurfaceError::Lost) => {
                self.configure_surface(rect.width, rect.height);
                self.surface_failures += 1;
                state
                    .surface_failures
                    .store(self.surface_failures, Ordering::Relaxed);
                if self.surface_failures < SURFACE_FAILURE_LIMIT {
                    return Ok(false);
                }
                // swapchain 卡死：就地丢弃 surface 重建（device 未变，模型纹理
                // 仍有效，只重建 surface + renderer）。此分支没有持有
                // SurfaceTexture，可以安全丢弃。
                eprintln!(
                    "[live2d] surface stuck after {} frames (recovery #{})",
                    self.surface_failures,
                    self.surface_recoveries + 1
                );
                self.reset_surface();
                state.surface_failures.store(0, Ordering::Relaxed);
                state
                    .surface_recoveries
                    .store(self.surface_recoveries, Ordering::Relaxed);
                if self.surface_recoveries >= SURFACE_RECOVERY_LIMIT {
                    return Err(format!(
                        "surface 连续 {} 次重建后仍不可用",
                        self.surface_recoveries
                    ));
                }
                return Ok(false);
            }
            Err(wgpu::SurfaceError::Timeout) => return Ok(false),
            Err(wgpu::SurfaceError::OutOfMemory) => {
                return Err("surface out of memory".to_string());
            }
            Err(e) => return Err(format!("surface error: {e}")),
        };
        let view = frame
            .texture
            .create_view(&wgpu::TextureViewDescriptor::default());
        let bounds = {
            let model = self.model.as_ref().ok_or("no model")?;
            model.content_bounds()
        };
        // 2x 超采样（对齐浏览器 wl-live2d resolution:2）：模型按两倍渲染尺寸
        // 拟合到离屏目标，再线性降采样回 surface——边缘 SSAA + 纹理细节翻倍。
        // 环境变量 L2D_SUPERSAMPLE=0 可关闭（诊断/低配）。
        let supersample = std::env::var("L2D_SUPERSAMPLE")
            .map(|v| v != "0")
            .unwrap_or(true);
        let (rw, rh) = if supersample {
            (
                (rect.width as f32 * 2.0).max(1.0),
                (rect.height as f32 * 2.0).max(1.0),
            )
        } else {
            (rect.width as f32, rect.height as f32)
        };
        let transform = ViewTransform::fit_content(bounds, rw, rh, 0.02);
        let (min_x, min_y) = transform.canvas_to_screen(bounds.0[0], bounds.0[1], rw, rh);
        let (max_x, max_y) = transform.canvas_to_screen(bounds.1[0], bounds.1[1], rw, rh);
        // 诊断边界换算回显示空间（超采样渲染是 rw/rh 上的坐标）。
        let disp_scale = if supersample { 2.0 } else { 1.0 };
        let bx = ((min_x.min(max_x)).floor().max(0.0) / disp_scale) as i32;
        let by = ((min_y.min(max_y)).floor().max(0.0) / disp_scale) as i32;
        let bw = (((max_x - min_x).abs().ceil() as f32) / disp_scale) as u32;
        let bh = (((max_y - min_y).abs().ceil() as f32) / disp_scale) as u32;
        // 诊断边界钳制在 overlay 内；输入事件由上层 WebView 转发，不再用它
        // 裁剪窗口可见区域。
        let clamp_x = (rect.x + bx).clamp(rect.x, rect.x + rect.width as i32);
        let clamp_y = (rect.y + by).clamp(rect.y, rect.y + rect.height as i32);
        let clamp_w = bw.min((rect.x + rect.width as i32 - clamp_x).max(1) as u32);
        let clamp_h = bh.min((rect.y + rect.height as i32 - clamp_y).max(1) as u32);
        *state.model_bounds.lock().unwrap() = Some(OverlayRect {
            x: clamp_x,
            y: clamp_y,
            width: clamp_w,
            height: clamp_h,
        });
        let model = self.model.as_ref().ok_or("no model")?;
        let renderer = self.renderer.as_mut().ok_or("no renderer")?;
        let encoder = renderer.draw_frame(
            model,
            &transform,
            &self.textures,
            &view,
            rect.width,
            rect.height,
            false,
            None,
            supersample,
        );
        let _ = self.queue.submit(std::iter::once(encoder.finish()));
        frame.present();
        Ok(true)
    }

    /// 归一化坐标（0..1，overlay 相对）→ 作者 HitArea 命中。
    /// 超采样开启时渲染空间是 2x 离屏目标，命中映射必须换算到同一空间。
    fn hit_test(&self, rect: OverlayRect, nx: f32, ny: f32) -> Vec<String> {
        let Some(model) = self.model.as_ref() else {
            return vec![];
        };
        if rect.width == 0 || rect.height == 0 {
            return vec![];
        }
        let supersample = std::env::var("L2D_SUPERSAMPLE")
            .map(|v| v != "0")
            .unwrap_or(true);
        let (rw, rh) = if supersample {
            (rect.width as f32 * 2.0, rect.height as f32 * 2.0)
        } else {
            (rect.width as f32, rect.height as f32)
        };
        let bounds = model.content_bounds();
        let transform = ViewTransform::fit_content(bounds, rw, rh, 0.02);
        let (canvas_x, canvas_y) = transform.screen_to_canvas(
            nx * rw,
            ny * rh,
            rw,
            rh,
        );
        // 作者 HitArea id 表：由 setCharacter 时解析 model3.json 缓存。
        // 当前返回命中 id 列表（空 = 未命中或模型未加载）。
        let hit_ids = self.hit_area_ids();
        let mut areas = Vec::new();
        if std::env::var("L2D_DEBUG_HIT").is_ok() {
            eprintln!("[hit] rect={rect:?}");
            eprintln!(
                "[hit] bounds_min={:?} bounds_max={:?} scale={} canvas=({canvas_x:.3},{canvas_y:.3})",
                bounds.0, bounds.1, transform.scale
            );
        }
        for id in &hit_ids {
            if model.hit_test(id, canvas_x, canvas_y) {
                if std::env::var("L2D_DEBUG_HIT").is_ok() {
                    eprintln!("[hit] HIT {id}");
                }
                areas.push(id.clone());
            }
        }
        areas
    }

    /// HitArea 名列表：setCharacter 时从 model3.json HitAreas 动态解析（宁宁/夏目通用），
    /// 空列表 = 模型未加载。
    fn hit_area_ids(&self) -> Vec<String> {
        self.hit_area_names.clone()
    }

    fn next_motion_index(&mut self, group: &str, requested: Option<i64>) -> Result<i32, String> {
        let count = self.motion_counts.get(group).copied().unwrap_or(0);
        if count == 0 {
            return Err(format!("motion group {group} not found"));
        }
        if let Some(index) = requested {
            if index < 0 || index as usize >= count {
                return Err(format!("motion {group}[{index}] not found"));
            }
            return Ok(index as i32);
        }

        // A small deterministic PRNG keeps selection varied without depending on
        // a shared global RNG from the render thread. Avoid repeating the same
        // variant when a group has more than one authored motion.
        let mut seed = self.motion_seed;
        seed ^= seed << 13;
        seed ^= seed >> 7;
        seed ^= seed << 17;
        self.motion_seed = seed;
        let mut index = (seed % count as u64) as usize;
        if count > 1 && self.motion_last_indices.get(group) == Some(&index) {
            index = (index + 1) % count;
        }
        self.motion_last_indices.insert(group.to_string(), index);
        Ok(index as i32)
    }

    fn start_motion(
        &mut self,
        group: &str,
        requested: Option<i64>,
        priority: i32,
        phase: MotionPhase,
    ) -> Result<i32, String> {
        let index = self.next_motion_index(group, requested)?;
        let model = self.model.as_mut().ok_or("model not loaded")?;
        let handle = model
            .start_motion(group, index, priority)
            .ok_or_else(|| format!("motion {group}[{index}] not found"))?;
        let remaining_seconds = if phase == MotionPhase::Idle {
            Some(
                self.motion_durations
                    .get(group)
                    .and_then(|durations| durations.get(index as usize))
                    .copied()
                    .unwrap_or(5.0),
            )
        } else {
            None
        };
        self.active_motion = Some(ActiveMotion {
            handle,
            phase,
            group: group.to_string(),
            index,
            remaining_seconds,
        });
        Ok(index)
    }

    fn emit_motion_started(app: Option<&AppHandle>, group: &str, index: i32) {
        if let Some(app) = app {
            let _ = app.emit(
                "aics:live2d:motion-started",
                serde_json::json!({ "group": group, "index": index }),
            );
        }
    }

    fn start_idle_motion(&mut self, app: Option<&AppHandle>) {
        if !self.motion_counts.contains_key("Idle") {
            return;
        }
        match self.start_motion("Idle", None, model::PRIORITY_IDLE, MotionPhase::Idle) {
            Ok(index) => Self::emit_motion_started(app, "Idle", index),
            Err(error) => eprintln!("[live2d] idle motion failed: {error}"),
        }
    }

    fn start_initial_motion(&mut self, app: Option<&AppHandle>) -> Result<(), String> {
        let entrance_group = self.profile.as_ref().and_then(|profile| profile.entrance_group.clone());
        if let Some(group) = entrance_group.filter(|group| self.motion_counts.contains_key(group)) {
            let index = self.start_motion(&group, None, model::PRIORITY_NORMAL, MotionPhase::Entrance)?;
            Self::emit_motion_started(app, &group, index);
        } else {
            if let Some(app) = app {
                let _ = app.emit("aics:live2d:entrance-finished", ());
            }
            self.start_idle_motion(app);
        }
        Ok(())
    }

    fn advance_motion(&mut self, dt: f32, app: Option<&AppHandle>) {
        if let Some(active) = self.active_motion.as_mut() {
            if let Some(remaining) = active.remaining_seconds.as_mut() {
                *remaining = (*remaining - dt).max(0.0);
            }
        }
        let Some(active) = self.active_motion.as_ref() else {
            return;
        };
        let finished = active
            .remaining_seconds
            .map(|remaining| remaining <= 0.0)
            .unwrap_or_else(|| {
                self.model
                    .as_ref()
                    .map(|model| model.is_finished(active.handle))
                    .unwrap_or(true)
            });
        if !finished {
            return;
        }
        let phase = active.phase;
        self.active_motion = None;
        if phase == MotionPhase::Entrance {
            if let Some(app) = app {
                let _ = app.emit("aics:live2d:entrance-finished", ());
            }
        }
        // 夏目互动/登场动作结束后回落叠层与换装参数：Tap* 驱动它们而 Idle
        // 不覆盖，不复位则叠层残留（2026-08-15 实机缺陷，见
        // docs/live2d-natsume-overlay-research.md）。回落为 smoothstep 缓动
        // 而非单帧硬写——硬写曾让换装部件一帧内消失回穿（2026-08-23 桌宠
        // 实机"换装闪回"反馈）。回落期间 step() 跳过硬性隐藏守卫，结束后
        // 恢复（防 Idle_6 拉灰）。Idle→Idle 轮换参数本就处于隐藏态，无需回落。
        if matches!(phase, MotionPhase::Interaction | MotionPhase::Entrance) {
            let config = self.profile.as_ref().and_then(|profile| profile.overlay_settle.as_ref());
            if let (Some(model), Some(config)) = (self.model.as_ref(), config) {
                self.overlay_settler = OverlaySettler::begin(model, config);
            }
        }
        self.start_idle_motion(app);
    }
}

fn create_overlay_window() -> Option<HWND> {
    unsafe {
        let class_name = "aics_live2d_overlay\0".encode_utf16().collect::<Vec<u16>>();
        let window_title = "aics-live2d-overlay\0".encode_utf16().collect::<Vec<u16>>();
        let hinstance = GetModuleHandleW(std::ptr::null());
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            style: CS_HREDRAW | CS_VREDRAW,
            lpfnWndProc: Some(overlay_wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinstance,
            hIcon: std::ptr::null_mut(),
            hCursor: std::ptr::null_mut(),
            hbrBackground: std::ptr::null_mut(),
            lpszMenuName: std::ptr::null(),
            lpszClassName: class_name.as_ptr(),
            hIconSm: std::ptr::null_mut(),
        };
        if RegisterClassExW(&wc) == 0 {
            let err = windows_sys::Win32::Foundation::GetLastError() as i32;
            if err != 1410 {
                // 1410 = ERROR_CLASS_ALREADY_EXISTS
                return None;
            }
        }
        let hwnd = CreateWindowExW(
            (WS_EX_NOREDIRECTIONBITMAP | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT)
                as WINDOW_EX_STYLE,
            class_name.as_ptr(),
            window_title.as_ptr(),
            WS_POPUP as WINDOW_STYLE,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            1,
            1,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            hinstance,
            std::ptr::null(),
        );
        if hwnd.is_null() {
            return None;
        }
        // 必须让窗口进入"已显示"状态，DXGI 才能枚举 surface 格式；
        // 后续由 SetFrame 用 SetWindowPos 定位 + SW_SHOWNA 真正显示。
        ShowWindow(hwnd, SW_SHOWNA);
        Some(hwnd)
    }
}

extern "system" fn overlay_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    unsafe {
        match msg {
            WM_DESTROY => {
                PostQuitMessage(0);
                return 0;
            }
            _ => {}
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

/// 渲染线程退出时向前端广播 stopped（带原因）。前端据此显示"渲染已停止"
/// 并可重试；正常 destroy 命令不退出线程，不触发本事件。
fn emit_stopped(app: Option<&AppHandle>, reason: &str) {
    if let Some(app) = app {
        let _ = app.emit(
            "aics:live2d:stopped",
            serde_json::json!({ "reason": reason }),
        );
    }
}

/// 渲染线程：消息循环（非阻塞）+ 命令处理 + 帧渲染。
fn overlay_window_thread(
    state: Arc<Live2DOverlayState>,
    assets_root: std::path::PathBuf,
    app: Option<AppHandle>,
) {
    // DPI 感知：进程级 per-monitor v2。前端 live2dOverlayLayout 已把 overlay
    // 矩形换算成屏幕物理像素，若进程非 DPI aware，Win32 会按系统 DPI 缩放
    // 窗口坐标导致错位（旧文档记录过 0.57 缩放问题）。Tauri/wry 若已设置
    // 则幂等；per-monitor v2 失败时回退 system-aware。
    unsafe {
        use windows_sys::Win32::UI::HiDpi::{
            SetProcessDpiAwareness, SetProcessDpiAwarenessContext,
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, PROCESS_PER_MONITOR_DPI_AWARE,
        };
        if SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) == 0 {
            let _ = SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE);
        }
    }
    let Some(hwnd) = create_overlay_window() else {
        let reason = "create overlay window failed";
        eprintln!("[live2d] {reason}");
        reset_runtime_state(&state);
        emit_stopped(app.as_ref(), reason);
        return;
    };
    unsafe {
        SetWindowLongPtrW(
            hwnd,
            GWLP_USERDATA,
            &*state as *const Live2DOverlayState as isize,
        );
    }
    *state.hwnd.lock().unwrap() = Some(hwnd as isize);

    let (tx, rx): (Sender<OverlayCommand>, Receiver<OverlayCommand>) = channel();
    *state.cmd_tx.lock().unwrap() = Some(tx);

    let mut ctx = match RenderContext::new() {
        Ok(ctx) => ctx,
        Err(e) => {
            eprintln!("[live2d] render context init failed: {e}");
            unsafe {
                DestroyWindow(hwnd);
            }
            reset_runtime_state(&state);
            emit_stopped(app.as_ref(), &format!("render context init failed: {e}"));
            return;
        }
    };
    state.renderer_attached.store(true, Ordering::SeqCst);
    state.window_ready.store(true, Ordering::SeqCst);
    state.starting.store(false, Ordering::SeqCst);

    // 目标帧率：默认 165（vsync 由 surface present 决定，165Hz 屏即 165fps），
    // 可用 L2D_TARGET_FPS 覆盖；前端也可通过 setMaxFps 动态调整。
    state.target_fps.store(frame_pacing::initial_fps(std::env::var("L2D_TARGET_FPS").ok().as_deref()), Ordering::SeqCst);

    let mut last_frame = Instant::now();
    let mut last_z_order_sync = Instant::now() - Duration::from_secs(1);
    let mut running = true;
    // 线程退出原因：None 表示 WM_QUIT 正常退出（窗口销毁，如进程退出），
    // 此时前端通常已不在；其余错误路径必须带原因广播，前端才能显示重试。
    let mut stopped_reason: Option<String> = None;
    while running {
        let iteration_started = Instant::now();
        unsafe {
            let mut msg = std::mem::zeroed::<MSG>();
            while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) > 0 {
                if msg.message == 0x0012 {
                    // WM_QUIT
                    running = false;
                }
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        loop {
            match rx.try_recv() {
                Ok(cmd) => handle_command(&state, &mut ctx, &assets_root, app.as_ref(), hwnd, cmd),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    stopped_reason = Some("renderer command channel disconnected".into());
                    running = false;
                    break;
                }
            }
        }
        // 每帧 poll 一次以驱动 wgpu 的 device lost 回调（非阻塞，开销极小）。
        // 不 poll 就永远发现不了 GPU reset / TDR / 休眠唤醒后的设备失效：原实现
        // 会在已作废的资源上继续 submit + present，画面变成满屏雪花，且因为
        // surface 仍能拿到帧（只是内容作废）而毫无征兆，只能重启进程恢复。
        if running {
            let _ = ctx.device.poll(wgpu::PollType::Poll);
            if DEVICE_LOST.swap(false, Ordering::SeqCst) {
                let detail = DEVICE_LOST_DETAIL
                    .lock()
                    .ok()
                    .and_then(|slot| slot.clone())
                    .unwrap_or_else(|| "未知原因".to_string());
                eprintln!("[live2d] device lost: {detail}");
                stopped_reason = Some(format!("GPU 设备丢失：{detail}"));
                break;
            }
        }
        if running && state.visible.load(Ordering::SeqCst) {
            let mut rect = *state.rect.lock().unwrap();
            if let (Some(companion), Some(offset)) = (
                *state.companion_hwnd.lock().unwrap(),
                *state.companion_offset.lock().unwrap(),
            ) {
                let companion = companion as HWND;
                let mut companion_rect = unsafe { std::mem::zeroed::<RECT>() };
                if unsafe { GetWindowRect(companion, &mut companion_rect) } != 0 {
                    let followed = followed_overlay_rect(
                        rect,
                        companion_rect.left,
                        companion_rect.top,
                        offset,
                    );
                    let moved = followed.x != rect.x || followed.y != rect.y;
                    let sync_z_order = last_z_order_sync.elapsed() >= Duration::from_millis(250);
                    if moved || sync_z_order {
                        unsafe {
                            SetWindowPos(
                                hwnd,
                                companion,
                                followed.x,
                                followed.y,
                                0,
                                0,
                                SWP_NOACTIVATE | SWP_NOSIZE,
                            );
                        }
                        if moved {
                            *state.rect.lock().unwrap() = followed;
                            rect = followed;
                        }
                        last_z_order_sync = Instant::now();
                    }
                }
            }
            let now = Instant::now();
            let dt = (now - last_frame).as_secs_f32().min(0.1);
            last_frame = now;
            ctx.step(dt);
            ctx.advance_motion(dt, app.as_ref());
            match ctx.render_frame(&state, hwnd, rect) {
                Ok(true) => {
                    state.frame_count.fetch_add(1, Ordering::Relaxed);
                }
                Ok(false) => {}
                Err(e) => {
                    eprintln!("[live2d] render frame: {e}");
                    stopped_reason = Some(format!("render frame failed: {e}"));
                    running = false;
                }
            }
        }
        if let Some(cmd) = if running { frame_pacing::wait(&rx, state.visible.load(Ordering::SeqCst), state.target_fps.load(Ordering::Relaxed), iteration_started.elapsed()) } else { None } {
            handle_command(&state, &mut ctx, &assets_root, app.as_ref(), hwnd, cmd);
        }
    }

    unsafe {
        DestroyWindow(hwnd);
    }
    reset_runtime_state(&state);
    if let Some(reason) = stopped_reason {
        emit_stopped(app.as_ref(), &reason);
    }
}

fn handle_command(
    state: &Arc<Live2DOverlayState>,
    ctx: &mut RenderContext,
    assets_root: &std::path::Path,
    app: Option<&AppHandle>,
    hwnd: HWND,
    cmd: OverlayCommand,
) {
    match cmd {
        OverlayCommand::SetCharacter { character, texture_scale, adapter, reply } => {
            clear_model_state(state);
            ctx.mouth_level = 0.0;
            state.visible.store(false, Ordering::SeqCst);
            unsafe {
                ShowWindow(hwnd, SW_HIDE);
            }
            let result = (|| {
                ctx.ensure_surface(hwnd)?;
                let local = app.map(|app| app.state::<crate::state::AppState>().paths.runtime_root.join("live2d-imports"));
                ctx.load_model(assets_root, &character, texture_scale, adapter, local.as_deref())?;
                ctx.start_initial_motion(app)
            })();
            if result.is_ok() {
                *state.character.lock().unwrap() = Some(character.clone());
                state.model_ready.store(true, Ordering::SeqCst);
                if !ctx.ready_emitted {
                    ctx.ready_emitted = true;
                    if let Some(app) = app {
                        let _ = app.emit("aics:live2d:ready", ());
                    }
                }
            }
            let _ = reply.send(result);
        }
        OverlayCommand::PlayMotion {
            group,
            index,
            priority,
            reply,
        } => {
            let result = (|| -> Result<i32, String> {
                // 同一互动组仍在播放时拒绝重复请求：前端据 motion-failed 的
                // reason 显示"动作进行中"，不能用 force 重启打断自己。
                if would_reject_interaction(ctx.active_motion.as_ref(), &group) {
                    let current = ctx
                        .active_motion
                        .as_ref()
                        .map(|active| active.index)
                        .unwrap_or(0);
                    return Err(format!("motion already playing: {group}[{current}]"));
                }
                let priority = match priority.as_deref() {
                    Some("idle") => model::PRIORITY_IDLE,
                    Some("force") => model::PRIORITY_FORCE,
                    Some("normal") => model::PRIORITY_NORMAL,
                    _ => model::PRIORITY_NORMAL,
                };
                ctx.start_motion(&group, index, priority, MotionPhase::Interaction)
            })();
            match &result {
                Ok(index) => {
                    RenderContext::emit_motion_started(app, &group, *index);
                }
                Err(reason) => {
                    if let Some(app) = app {
                        let _ = app.emit(
                            "aics:live2d:motion-failed",
                            serde_json::json!({ "group": group, "index": index, "reason": reason }),
                        );
                    }
                }
            }
            let _ = reply.send(result.map(|_| ()));
        }
        OverlayCommand::SetExpression { name, reply } => {
            let result = (|| -> Result<(), String> {
                let model = ctx.model.as_mut().ok_or("model not loaded")?;
                model
                    .start_expression(&name, model::PRIORITY_FORCE)
                    .ok_or_else(|| format!("expression {name} not found"))?;
                Ok(())
            })();
            let _ = reply.send(result);
        }
        OverlayCommand::SetMouthLevel(level) => {
            let normalized = level.clamp(0.0, 1.0);
            let mapped = ctx.profile.as_ref()
                .and_then(|profile| profile.mouth_value(normalized).map(|(_, value)| value))
                .unwrap_or(0.0);
            ctx.mouth_level = normalized;
            state
                .last_mouth_level
                .store(normalized.to_bits(), Ordering::SeqCst);
            state
                .last_mapped_mouth_value
                .store(mapped.to_bits(), Ordering::SeqCst);
        }
        OverlayCommand::SetEmotion { name, intensity } => {
            ctx.emotion = Some((name, intensity.clamp(0.0, 1.0)));
        }
        OverlayCommand::SetGaze(x, y) => {
            ctx.gaze = (x.clamp(-1.0, 1.0), y.clamp(-1.0, 1.0));
        }
        OverlayCommand::SetMaxFps(fps) => {
            state.target_fps.store(fps.clamp(1, 1000), Ordering::SeqCst);
        }
        OverlayCommand::HitTestAsync { x, y } => {
            let rect = *state.rect.lock().unwrap();
            let areas = ctx.hit_test(rect, x, y);
            *state.hit_test_result.lock().unwrap() = Some(areas.clone());
            if let Some(app) = app {
                let _ = app.emit("aics:live2d:hit-test", areas);
            }
        }
        OverlayCommand::HitTest { x, y, reply } => {
            let rect = *state.rect.lock().unwrap();
            let areas = ctx.hit_test(rect, x, y);
            *state.hit_test_result.lock().unwrap() = Some(areas.clone());
            let _ = reply.send(Ok(areas));
        }
        OverlayCommand::Snapshot { path, reply } => {
            let result = (|| -> Result<(), String> {
                let model = ctx.model.as_mut().ok_or("model not loaded")?;
                let renderer = ctx.renderer.as_mut().ok_or("renderer not created")?;
                let bounds = model.content_bounds();
                let transform = ViewTransform::fit_content(bounds, 800.0, 800.0, 0.02);
                let pixels = renderer.render_to_image(
                    model,
                    &transform,
                    &ctx.textures,
                    800,
                    800,
                    false,
                    None,
                );
                let img =
                    image::RgbaImage::from_raw(800, 800, pixels).ok_or("snapshot: bad rgba")?;
                img.save(&path).map_err(|e| format!("snapshot save: {e}"))?;
                Ok(())
            })();
            let _ = reply.send(result);
        }
        OverlayCommand::Destroy { reply } => {
            if let Some(renderer) = ctx.renderer.as_mut() {
                renderer.release_model_resources();
            }
            ctx.model = None;
            ctx.textures.clear();
            ctx.character = None;
            ctx.profile = None;
            ctx.overlay_settler = None;
            ctx.hit_area_names.clear();
            ctx.motion_counts.clear();
            ctx.motion_durations.clear();
            ctx.motion_last_indices.clear();
            ctx.active_motion = None;
            ctx.mouth_level = 0.0;
            // destroy 契约：只清模型级状态，保留渲染线程与窗口（长期复用）。
            // 前端 destroy 后仍可 setCharacter 重新加载；线程退出路径
            // （窗口销毁/通道断开/致命错误）才广播 aics:live2d:stopped。
            clear_model_state(state);
            let _ = reply.send(());
        }
    }
}

// ---------------- 公开 API ----------------

fn selftest_adapter(character: &str) -> Live2DAdapterConfig {
    let natsume = character == "natsume";
    Live2DAdapterConfig {
        profile_id: format!("selftest-{character}"),
        mouth: Some(MouthBinding {
            id: if natsume { "ParamMouthForm3" } else { "ParamMouthOpenY" }.into(),
            scale: if natsume { -0.5 } else { 1.0 },
            range: None,
        }),
        blink: if natsume { vec!["ParamEyeLOpen".into(), "ParamEyeLOpen2".into()] }
            else { vec!["ParamEyeLOpen".into(), "ParamEyeROpen".into()] },
        focus: vec!["ParamAngleX".into(), "ParamAngleY".into(), "ParamEyeBallX".into(), "ParamEyeBallY".into()],
        emotion_params: HashMap::new(),
        overlay_settle: None,
        entrance_group: natsume.then(|| "Start".into()),
        leave_group: Some("Leave".into()),
    }
}

/// 启动 overlay 窗口 + 渲染线程（幂等）。
/// 渲染链路自测：无 Tauri 依赖，直接创建 overlay → 加载模型 → 渲染数帧 → 退出。
/// 供 LIVE2D_SELFTEST=1 环境变量驱动，验证窗口/wgpu/模型/渲染循环全链路。
pub fn selftest(assets_root: std::path::PathBuf) -> Result<(), String> {
    let state = Arc::new(Live2DOverlayState::default());
    state.starting.store(true, Ordering::SeqCst);
    let handle = state.clone();
    thread::spawn(move || overlay_window_thread(handle, assets_root, None));
    let deadline = Instant::now() + Duration::from_secs(15);
    while !state.window_ready.load(Ordering::SeqCst) {
        if Instant::now() > deadline {
            return Err("selftest: overlay window not ready within 15s".into());
        }
        thread::sleep(Duration::from_millis(50));
    }
    let tx = state
        .cmd_tx
        .lock()
        .unwrap()
        .clone()
        .ok_or("selftest: no cmd channel")?;
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    tx.send(OverlayCommand::SetCharacter {
        character: "nene".to_string(),
        texture_scale: 1,
        adapter: selftest_adapter("nene"),
        reply: reply_tx,
    })
    .map_err(|e| format!("selftest: send set_character: {e}"))?;
    let reply = reply_rx
        .blocking_recv()
        .map_err(|e| format!("selftest: reply channel closed: {e}"))?;
    reply.map_err(|e| format!("selftest: set_character failed: {e}"))?;
    *state.rect.lock().unwrap() = OverlayRect {
        x: 200,
        y: 200,
        width: 800,
        height: 800,
    };
    state.visible.store(true, Ordering::SeqCst);

    let check = |label: &str, result: Result<Result<(), String>, String>| -> Result<(), String> {
        let inner = result.map_err(|e| format!("selftest: {label} channel error: {e}"))?;
        inner.map_err(|e| format!("selftest: {label} failed: {e}"))
    };

    let cmd = |c: OverlayCommand, timeout_ms: u64| -> Result<Result<(), String>, String> {
        let (r_tx, mut r_rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
        let c = match c {
            OverlayCommand::SetCharacter { character, texture_scale, adapter, .. } => OverlayCommand::SetCharacter {
                character,
                texture_scale,
                adapter,
                reply: r_tx,
            },
            OverlayCommand::PlayMotion {
                group,
                index,
                priority,
                ..
            } => OverlayCommand::PlayMotion {
                group,
                index,
                priority,
                reply: r_tx,
            },
            OverlayCommand::Snapshot { path, .. } => OverlayCommand::Snapshot { path, reply: r_tx },
            _other => {
                return Err(format!("selftest: unsupported reply command"));
            }
        };
        let tx = state
            .cmd_tx
            .lock()
            .unwrap()
            .clone()
            .ok_or("selftest: no cmd channel")?;
        tx.send(c)
            .map_err(|e| format!("selftest: send failed: {e}"))?;
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        loop {
            if let Ok(r) = r_rx.try_recv() {
                return Ok(r);
            }
            if Instant::now() > deadline {
                return Err("selftest: reply timeout".into());
            }
            thread::sleep(Duration::from_millis(20));
        }
    };

    let out_dir = std::env::var("LIVE2D_SNAPSHOT_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("."));

    check(
        "nene play_motion TapHead",
        cmd(
            OverlayCommand::PlayMotion {
                group: "TapHead".into(),
                index: Some(0),
                priority: Some("force".into()),
                reply: tokio::sync::oneshot::channel().0,
            },
            5000,
        ),
    )?;
    thread::sleep(Duration::from_millis(800));
    check(
        "nene snapshot",
        cmd(
            OverlayCommand::Snapshot {
                path: out_dir
                    .join("selftest-nene-motion.png")
                    .to_string_lossy()
                    .to_string(),
                reply: tokio::sync::oneshot::channel().0,
            },
            15000,
        ),
    )?;

    tx.send(OverlayCommand::SetMouthLevel(0.8))
        .map_err(|e| format!("selftest: send mouth: {e}"))?;
    tx.send(OverlayCommand::SetEmotion {
        name: "happy".into(),
        intensity: 1.0,
    })
    .map_err(|e| format!("selftest: send emotion: {e}"))?;
    thread::sleep(Duration::from_millis(500));
    check(
        "nene snapshot mouth+emotion",
        cmd(
            OverlayCommand::Snapshot {
                path: out_dir
                    .join("selftest-nene-mouth.png")
                    .to_string_lossy()
                    .to_string(),
                reply: tokio::sync::oneshot::channel().0,
            },
            15000,
        ),
    )?;

    // 点击点选在脸区中部（canvas y≈0.55，Face bbox y[0.441,0.625] 中心）。
    // 原 y=0.11 换算后 canvas y≈0.688，贴着 Head 区上缘（实测 bbox 到 0.687，
    // 差 0.001）——HitArea 顶点随动作相位微动，贴边坐标让断言随 TapHead
    // 姿势时好时坏（2026-08-23 实测空命中）。脸中心对动作相位不敏感。
    tx.send(OverlayCommand::HitTestAsync { x: 0.5, y: 0.20 })
        .map_err(|e| format!("selftest: send hit test: {e}"))?;
    thread::sleep(Duration::from_millis(300));
    let areas = state.hit_test_result.lock().unwrap().clone();
    match areas {
        Some(areas) if !areas.is_empty() => {
            println!("LIVE2D_SELFTEST_HITTEST areas={areas:?}");
        }
        Some(_) => {
            return Err("selftest: hit test returned empty areas (expected Face hit)".into())
        }
        None => return Err("selftest: hit test produced no result".into()),
    }

    check(
        "natsume set_character",
        cmd(
            OverlayCommand::SetCharacter {
                character: "natsume".into(),
                texture_scale: 1,
                adapter: selftest_adapter("natsume"),
                reply: tokio::sync::oneshot::channel().0,
            },
            120000,
        ),
    )?;
    check(
        "natsume play_motion Start",
        cmd(
            OverlayCommand::PlayMotion {
                group: "Start".into(),
                index: Some(0),
                priority: Some("force".into()),
                reply: tokio::sync::oneshot::channel().0,
            },
            5000,
        ),
    )?;
    thread::sleep(Duration::from_millis(800));
    check(
        "natsume snapshot",
        cmd(
            OverlayCommand::Snapshot {
                path: out_dir
                    .join("selftest-natsume.png")
                    .to_string_lossy()
                    .to_string(),
                reply: tokio::sync::oneshot::channel().0,
            },
            15000,
        ),
    )?;

    thread::sleep(Duration::from_secs(1));
    let frames = state.frame_count.load(Ordering::SeqCst);
    *state.cmd_tx.lock().unwrap() = None;
    if frames == 0 {
        return Err(format!(
            "selftest: no frames rendered (frame_count={frames})"
        ));
    }
    println!("LIVE2D_SELFTEST_OK frames={frames}");
    Ok(())
}
pub fn ensure_overlay(app: &AppHandle, assets_root: std::path::PathBuf) -> Arc<Live2DOverlayState> {
    let _init_guard = OVERLAY_STATE_INIT
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap();
    let state = if let Some(state) = app.try_state::<Arc<Live2DOverlayState>>() {
        state.inner().clone()
    } else {
        let state = Arc::new(Live2DOverlayState::default());
        app.manage(state.clone());
        state
    };
    if try_begin_startup(&state) {
        let handle = state.clone();
        let app2 = app.clone();
        thread::spawn(move || overlay_window_thread(handle, assets_root, Some(app2)));
    }
    state
}

fn overlay_assets_root(app: &AppHandle) -> std::path::PathBuf {
    app.state::<crate::state::AppState>()
        .paths
        .assets_root
        .clone()
}

/// setFrame：定位 + 显隐 + 透明度（屏幕物理像素）。
pub fn apply_frame(
    app: &AppHandle,
    local_rect: OverlayRect,
    visible: bool,
    opacity: Option<u32>,
) -> Result<(), String> {
    let assets_root = overlay_assets_root(app);
    let state = ensure_overlay(app, assets_root);
    let deadline = Instant::now() + Duration::from_secs(1);
    while !state.window_ready.load(Ordering::SeqCst) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    let Some(hwnd) = state.hwnd.lock().unwrap().clone().map(|h| h as HWND) else {
        return Err("overlay window not ready".to_string());
    };
    let companion_hwnd = app
        .get_webview_window("companion")
        .and_then(|window| window.hwnd().ok())
        .map(|handle| handle.0 as HWND)
        .unwrap_or(std::ptr::null_mut());
    *state.companion_hwnd.lock().unwrap() = (!companion_hwnd.is_null())
        .then_some(companion_hwnd as isize);
    let (rect, companion_offset) = if companion_hwnd.is_null() {
        (local_rect, None)
    } else {
        let mut companion_rect = unsafe { std::mem::zeroed::<RECT>() };
        if unsafe { GetWindowRect(companion_hwnd, &mut companion_rect) } != 0 {
            (
                followed_overlay_rect(
                    local_rect,
                    companion_rect.left,
                    companion_rect.top,
                    (local_rect.x, local_rect.y),
                ),
                Some((local_rect.x, local_rect.y)),
            )
        } else {
            (local_rect, None)
        }
    };
    *state.companion_offset.lock().unwrap() = companion_offset;
    *state.rect.lock().unwrap() = rect;
    state.visible.store(visible, Ordering::SeqCst);
    if !visible {
        *state.model_bounds.lock().unwrap() = None;
    }
    let alpha = opacity.unwrap_or(255).min(255);
    state.opacity.store(alpha, Ordering::SeqCst);
    // Per-pixel alpha is supplied by the premultiplied DComp surface. A global
    // frame alpha would require multiplying every renderer output, which is
    // outside the allowed overlay files; retain the value for API/state
    // compatibility but intentionally do not apply it with layered-window APIs.
    unsafe {
        if visible {
            // 首次 ShowWindow 会改变 top-level z-order；必须先显示，再把 overlay
            // 放到 Companion 之后，否则透明模型窗口仍会吞掉 WebView 点击。
            ShowWindow(hwnd, SW_SHOWNA);
            SetWindowPos(
                hwnd,
                companion_hwnd,
                rect.x,
                rect.y,
                rect.width as i32,
                rect.height as i32,
                SWP_NOACTIVATE,
            );
        } else {
            ShowWindow(hwnd, SW_HIDE);
        }
    }
    Ok(())
}

/// 发送意图命令并等待渲染线程接收（IPC 同步命令的通道建立）。
fn send_command(state: &Arc<Live2DOverlayState>, cmd: OverlayCommand) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let tx = state.cmd_tx.lock().unwrap().clone();
        if let Some(tx) = tx {
            tx.send(cmd)
                .map_err(|_| "renderer thread disconnected".to_string())?;
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err("renderer not attached".to_string());
        }
        thread::sleep(Duration::from_millis(20));
    }
}

/// 异步版 send_command：模型加载/纹理解码需要数秒，绝不能在 Tauri 主线程
/// 用 pollster::block_on 等待，否则 UI 线程被冻结、前端 loading 无法显示。
async fn send_command_async(
    state: &Arc<Live2DOverlayState>,
    cmd: OverlayCommand,
) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let tx = state.cmd_tx.lock().unwrap().clone();
        if let Some(tx) = tx {
            tx.send(cmd)
                .map_err(|_| "renderer thread disconnected".to_string())?;
            return Ok(());
        }
        if Instant::now() > deadline {
            return Err("renderer not attached".to_string());
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

// ---------------- IPC 命令（aics_live2d_*） ----------------

#[tauri::command]
pub async fn aics_live2d_set_character(
    app: AppHandle,
    model_path: String,
    character: Option<String>,
    texture_scale: Option<u32>,
    adapter: Option<Live2DAdapterConfig>,
) -> Result<serde_json::Value, String> {
    // 白名单：character 只接受已知角色；model_path 忽略（资产由 Rust 从
    // assets_root/live2d/{character} 读取，不接收任意路径）。
    let character = character.unwrap_or_else(|| "nene".to_string());
    let Some(adapter) = adapter else {
        return Ok(serde_json::json!({ "ok": false, "error": "missing Live2D adapter profile" }));
    };
    if let Err(error) = adapter.validate() {
        return Ok(serde_json::json!({ "ok": false, "error": error }));
    }
    let _ = model_path;
    let texture_scale = texture_scale.unwrap_or(1);
    if !matches!(texture_scale, 1 | 2 | 4) { return Err("invalid Live2D texture scale".into()); }
    let assets_root = overlay_assets_root(&app);
    let local_root = app.state::<crate::state::AppState>().paths.runtime_root.join("live2d-imports");
    if let Err(error) = live2d_assets::resolve_model(&assets_root, Some(&local_root), &character, &adapter.profile_id) {
        return Ok(serde_json::json!({ "ok": false, "error": error }));
    }
    let state = ensure_overlay(&app, assets_root);
    let (tx, rx) = tokio::sync::oneshot::channel();
    // 真异步：模型加载在渲染线程执行，本 command 挂起等待，不阻塞主线程；
    // 前端在调用期间保持 loading 状态。
    send_command_async(
        &state,
        OverlayCommand::SetCharacter {
            character,
            texture_scale,
            adapter,
            reply: tx,
        },
    )
    .await?;
    let result = rx
        .await
        .map_err(|_| "renderer dropped command".to_string())?;
    match result {
        Ok(()) => Ok(serde_json::json!({ "ok": true })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[tauri::command]
pub fn aics_live2d_set_frame(
    app: AppHandle,
    rect: serde_json::Value,
    visible: bool,
    opacity: Option<f64>,
) -> Result<(), String> {
    let obj = rect.as_object().ok_or("rect must be an object")?;
    let x = obj.get("x").and_then(|v| v.as_i64()).ok_or("rect.x")? as i32;
    let y = obj.get("y").and_then(|v| v.as_i64()).ok_or("rect.y")? as i32;
    let width = obj
        .get("width")
        .and_then(|v| v.as_u64())
        .ok_or("rect.width")? as u32;
    let height = obj
        .get("height")
        .and_then(|v| v.as_u64())
        .ok_or("rect.height")? as u32;
    apply_frame(
        &app,
        OverlayRect {
            x,
            y,
            width,
            height,
        },
        visible,
        opacity.map(|o| (o.clamp(0.0, 1.0) * 255.0) as u32),
    )
}

/// 只读状态查询。未初始化时不得创建 overlay 或启动渲染线程。
#[tauri::command]
pub fn aics_live2d_get_state(app: AppHandle) -> Result<serde_json::Value, String> {
    let Some(state) = app.try_state::<Arc<Live2DOverlayState>>() else {
        return Ok(serde_json::json!({
            "active": false,
            "rect": OverlayRect::default(),
            "visible": false,
            "frameCount": 0,
            "targetFps": 0,
            "character": null,
            "ready": false,
            "windowReady": false,
            "rendererAttached": false,
            "starting": false,
            "modelBounds": null,
            "mouthLevel": 0.0,
            "mouthMappedValue": 0.0,
            "surfaceFailures": 0,
            "surfaceRecoveries": 0,
            "renderErrors": 0,
        }));
    };
    let state = state.inner();
    Ok(serde_json::json!({
        "active": true,
        "rect": *state.rect.lock().unwrap(),
        "visible": state.visible.load(Ordering::SeqCst),
        "frameCount": state.frame_count.load(Ordering::SeqCst),
        "targetFps": state.target_fps.load(Ordering::SeqCst),
        "ready": state.model_ready.load(Ordering::SeqCst),
        "windowReady": state.window_ready.load(Ordering::SeqCst),
        "rendererAttached": state.renderer_attached.load(Ordering::SeqCst),
        "starting": state.starting.load(Ordering::SeqCst),
        "character": state.character.lock().unwrap().clone(),
        "modelBounds": *state.model_bounds.lock().unwrap(),
        "mouthLevel": f32::from_bits(state.last_mouth_level.load(Ordering::SeqCst)),
        "mouthMappedValue": f32::from_bits(state.last_mapped_mouth_value.load(Ordering::SeqCst)),
        "surfaceFailures": state.surface_failures.load(Ordering::Relaxed),
        "surfaceRecoveries": state.surface_recoveries.load(Ordering::Relaxed),
        "renderErrors": RENDER_ERROR_COUNT.load(Ordering::Relaxed),
    }))
}

#[tauri::command]
pub fn aics_live2d_play_motion(
    app: AppHandle,
    group: String,
    index: Option<i64>,
    priority: Option<String>,
) -> Result<serde_json::Value, String> {
    let assets_root = overlay_assets_root(&app);
    let state = ensure_overlay(&app, assets_root);
    let (tx, rx) = tokio::sync::oneshot::channel();
    send_command(
        &state,
        OverlayCommand::PlayMotion {
            group,
            index,
            priority,
            reply: tx,
        },
    )?;
    let result = pollster::block_on(rx).map_err(|_| "renderer dropped command".to_string())?;
    match result {
        Ok(()) => Ok(serde_json::json!({ "ok": true })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[tauri::command]
pub fn aics_live2d_set_expression(
    app: AppHandle,
    name: String,
) -> Result<serde_json::Value, String> {
    let assets_root = overlay_assets_root(&app);
    let state = ensure_overlay(&app, assets_root);
    let (tx, rx) = tokio::sync::oneshot::channel();
    send_command(&state, OverlayCommand::SetExpression { name, reply: tx })?;
    let result = pollster::block_on(rx).map_err(|_| "renderer dropped command".to_string())?;
    match result {
        Ok(()) => Ok(serde_json::json!({ "ok": true })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "error": e })),
    }
}

#[tauri::command]
pub fn aics_live2d_set_mouth_level(app: AppHandle, level: f64) -> Result<(), String> {
    let assets_root = overlay_assets_root(&app);
    let state = ensure_overlay(&app, assets_root);
    send_command(&state, OverlayCommand::SetMouthLevel(level as f32))
}

#[tauri::command]
pub fn aics_live2d_set_max_fps(app: AppHandle, fps: f64) -> Result<(), String> {
    let assets_root = app
        .state::<crate::state::AppState>()
        .paths
        .assets_root
        .clone();
    let state = ensure_overlay(&app, assets_root);
    let fps = if fps.is_finite() {
        fps.round().clamp(1.0, 1000.0) as u32
    } else {
        60
    };
    send_command(&state, OverlayCommand::SetMaxFps(fps))
}

#[tauri::command]
pub fn aics_live2d_set_emotion(app: AppHandle, name: String, intensity: f64) -> Result<(), String> {
    let assets_root = overlay_assets_root(&app);
    let state = ensure_overlay(&app, assets_root);
    send_command(
        &state,
        OverlayCommand::SetEmotion {
            name,
            intensity: intensity as f32,
        },
    )
}

#[tauri::command]
pub fn aics_live2d_set_gaze(app: AppHandle, x: f64, y: f64) -> Result<(), String> {
    let assets_root = overlay_assets_root(&app);
    let state = ensure_overlay(&app, assets_root);
    send_command(&state, OverlayCommand::SetGaze(x as f32, y as f32))
}

#[tauri::command]
pub fn aics_live2d_hit_test(app: AppHandle, x: f64, y: f64) -> Result<serde_json::Value, String> {
    let assets_root = overlay_assets_root(&app);
    let state = ensure_overlay(&app, assets_root);
    let (tx, rx) = tokio::sync::oneshot::channel();
    send_command(
        &state,
        OverlayCommand::HitTest {
            x: x as f32,
            y: y as f32,
            reply: tx,
        },
    )?;
    let areas =
        pollster::block_on(rx).map_err(|_| "renderer dropped hit-test command".to_string())??;
    Ok(serde_json::json!({ "areas": areas }))
}

#[tauri::command]
pub fn aics_live2d_destroy(app: AppHandle) -> Result<(), String> {
    let assets_root = overlay_assets_root(&app);
    let state = ensure_overlay(&app, assets_root);
    let (tx, rx) = tokio::sync::oneshot::channel();
    send_command(&state, OverlayCommand::Destroy { reply: tx })?;
    let _ = pollster::block_on(rx);
    if let Some(hwnd) = state.hwnd.lock().unwrap().clone().map(|h| h as HWND) {
        unsafe {
            ShowWindow(hwnd, SW_HIDE);
        }
    }
    state.visible.store(false, Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        clear_model_state, followed_overlay_rect, selftest_adapter,
        reset_runtime_state, try_begin_startup, would_reject_interaction, ActiveMotion,
        BlinkPhase, BlinkState, Live2DOverlayState, MotionPhase, OverlayRect,
    };
    use live2d_native::model;

    #[test]
    fn mouth_intent_uses_character_specific_ranges() {
        assert_eq!(selftest_adapter("nene").mouth_value(1.0), Some(("ParamMouthOpenY", 1.0)));
        assert_eq!(selftest_adapter("natsume").mouth_value(1.0), Some(("ParamMouthForm3", -0.5)));
        assert_eq!(selftest_adapter("natsume").mouth_value(2.0), Some(("ParamMouthForm3", -0.5)));
    }

    #[test]
    fn blink_state_cycles_open_closed_and_returns_to_open() {
        // 覆盖式眨眼状态机：open 值恒 1；强制走完 closing→closed→opening 后
        // 回到 open，且任意时刻值在 [0,1]。间隔随机（2.5-5s）不在此验证。
        let mut blink = BlinkState::new();
        assert_eq!(blink.value(), 1.0);
        assert_eq!(blink.phase, BlinkPhase::Open);
        // 直接推进到 closing（把定时器清零）
        blink.timer_ms = 0.0;
        let mut value = blink.update(0.016);
        assert_eq!(blink.phase, BlinkPhase::Closing);
        assert!((value - 1.0).abs() < 1e-6 || (0.0..=1.0).contains(&value));
        // 走完 closing（0.09s）+ closed（0.06s）+ opening（0.16s）
        for _ in 0..40 {
            value = blink.update(0.016);
        }
        assert_eq!(blink.phase, BlinkPhase::Open);
        assert_eq!(value, 1.0);
        // 全程值域合法
        let mut min_v = f32::MAX;
        let mut max_v = f32::MIN;
        let mut probe = BlinkState::new();
        probe.timer_ms = 0.0;
        for _ in 0..200 {
            let v = probe.update(0.016);
            min_v = min_v.min(v);
            max_v = max_v.max(v);
        }
        assert!(min_v >= 0.0 && max_v <= 1.0, "blink value out of range: {min_v}..{max_v}");
    }

    #[test]
    fn blink_params_follow_frontend_mapping() {
        assert_eq!(selftest_adapter("natsume").blink, ["ParamEyeLOpen", "ParamEyeLOpen2"]);
        assert_eq!(selftest_adapter("nene").blink, ["ParamEyeLOpen", "ParamEyeROpen"]);
    }

    #[test]
    fn overlay_follows_companion_without_changing_size() {
        let current = OverlayRect { x: 120, y: 80, width: 300, height: 480 };
        let moved = followed_overlay_rect(current, 700, 400, (12, 24));
        assert_eq!(moved, OverlayRect { x: 712, y: 424, width: 300, height: 480 });
    }

    #[test]
    fn interaction_busy_rejects_only_same_group() {
        let active = ActiveMotion {
            handle: model::MotionHandle(1),
            phase: MotionPhase::Interaction,
            group: "TapHead".to_string(),
            index: 2,
            remaining_seconds: Some(3.0),
        };
        assert!(would_reject_interaction(Some(&active), "TapHead"));
        assert!(!would_reject_interaction(Some(&active), "TapSkirt"));
        assert!(!would_reject_interaction(None, "TapHead"));
        let idle = ActiveMotion {
            phase: MotionPhase::Idle,
            ..active
        };
        assert!(
            !would_reject_interaction(Some(&idle), "TapHead"),
            "idle 可被点击打断"
        );
    }

    #[test]
    fn startup_gate_allows_one_starter_and_restarts_after_cleanup() {
        let state = Live2DOverlayState::default();
        assert!(try_begin_startup(&state));
        assert!(!try_begin_startup(&state));

        state.window_ready.store(true, std::sync::atomic::Ordering::SeqCst);
        state.starting.store(false, std::sync::atomic::Ordering::SeqCst);
        assert!(!try_begin_startup(&state));

        reset_runtime_state(&state);
        assert!(try_begin_startup(&state));
    }

    #[test]
    fn runtime_reset_clears_all_ready_and_starting_flags() {
        let state = Live2DOverlayState::default();
        state.window_ready.store(true, std::sync::atomic::Ordering::SeqCst);
        state.renderer_attached.store(true, std::sync::atomic::Ordering::SeqCst);
        state.starting.store(true, std::sync::atomic::Ordering::SeqCst);
        state.visible.store(true, std::sync::atomic::Ordering::SeqCst);
        reset_runtime_state(&state);
        assert!(!state.window_ready.load(std::sync::atomic::Ordering::SeqCst));
        assert!(!state.renderer_attached.load(std::sync::atomic::Ordering::SeqCst));
        assert!(!state.starting.load(std::sync::atomic::Ordering::SeqCst));
        assert!(!state.visible.load(std::sync::atomic::Ordering::SeqCst));
        assert!(state.hwnd.lock().unwrap().is_none());
        assert!(state.cmd_tx.lock().unwrap().is_none());
    }

    #[test]
    fn destroy_clears_model_state_but_keeps_thread_for_reuse() {
        let state = Live2DOverlayState::default();
        // 模拟运行中的渲染线程：窗口与通道就绪、模型已加载。
        state.window_ready.store(true, std::sync::atomic::Ordering::SeqCst);
        state.renderer_attached.store(true, std::sync::atomic::Ordering::SeqCst);
        state.starting.store(false, std::sync::atomic::Ordering::SeqCst);
        let (tx, _rx) = std::sync::mpsc::channel::<super::OverlayCommand>();
        *state.cmd_tx.lock().unwrap() = Some(tx);
        *state.character.lock().unwrap() = Some("nene".to_string());
        state.model_ready.store(true, std::sync::atomic::Ordering::SeqCst);
        *state.model_bounds.lock().unwrap() = Some(OverlayRect { x: 1, y: 2, width: 3, height: 4 });
        state
            .last_mouth_level
            .store(0.8f32.to_bits(), std::sync::atomic::Ordering::SeqCst);

        clear_model_state(&state);

        // 模型级状态清空：destroy 契约（释放模型、可重新 setCharacter）。
        assert!(!state.model_ready.load(std::sync::atomic::Ordering::SeqCst));
        assert!(state.character.lock().unwrap().is_none());
        assert!(state.model_bounds.lock().unwrap().is_none());
        assert_eq!(
            f32::from_bits(state.last_mouth_level.load(std::sync::atomic::Ordering::SeqCst)),
            0.0
        );
        // 线程与窗口保持：长期复用，不触发 stopped/重建。
        assert!(state.window_ready.load(std::sync::atomic::Ordering::SeqCst));
        assert!(state.renderer_attached.load(std::sync::atomic::Ordering::SeqCst));
        assert!(state.cmd_tx.lock().unwrap().is_some());
    }
}
