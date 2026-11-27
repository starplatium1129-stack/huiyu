use crate::mutex::{RecoverMutex, RecoverRwLock};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
#[path = "../live2d_frame_pacing.rs"]
mod frame_pacing;
#[path = "../live2d_adapter.rs"]
pub(crate) mod live2d_adapter;
#[path = "../live2d_assets.rs"]
pub(crate) mod live2d_assets;
use live2d_adapter::{Live2DAdapterConfig, OverlaySettler, ProfileParameters};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, PeekMessageW,
    PostQuitMessage, RegisterClassExW, SetWindowLongPtrW, SetWindowPos, ShowWindow, TranslateMessage,
    CS_HREDRAW, CS_VREDRAW, GWLP_USERDATA, MSG, PM_REMOVE, SWP_NOACTIVATE,
    SWP_NOSIZE, SWP_SHOWWINDOW, SW_HIDE, SW_SHOWNA, WINDOW_EX_STYLE, WINDOW_STYLE, WM_DESTROY,
    WNDCLASSEXW, WS_EX_NOACTIVATE,
    WS_EX_NOREDIRECTIONBITMAP, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_POPUP,
};

use live2d_native::model::{self, Model, ViewTransform};
use live2d_native::renderer::{self, Renderer};

mod blink;
mod device;
#[path = "model.rs"]
mod model_loading;
mod draw;
mod motion;
mod window;
mod commands;
mod frame;
mod alpha_mask;
mod texture_cache;

pub(crate) use window::overlay_window_thread;
pub(crate) use frame::{apply_frame, set_revealed, state_snapshot, send_command};
pub(crate) use alpha_mask::{AlphaMaskSnapshot, PointerHitSample};
use blink::BlinkState;

use commands::handle_command;

/// overlay 矩形。IPC 输入为 Companion-local 物理像素，state/render 内为屏幕物理像素。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
pub struct OverlayRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

impl OverlayRect {
    pub fn contains(self, x: i32, y: i32) -> bool {
        x >= self.x && y >= self.y && x.abs_diff(self.x) < self.width && y.abs_diff(self.y) < self.height
    }

    pub fn valid_local(self) -> bool {
        self.x >= 0 && self.y >= 0 && self.width > 0 && self.height > 0
            && self.x as u32 + self.width.min(16385) <= 16384
            && self.y as u32 + self.height.min(16385) <= 16384
    }
}

/// 连续拿不到可绘制 surface 的帧数上限。
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
    pub shutdown: AtomicBool,
    pub rect: Mutex<OverlayRect>,
    pub framing: Mutex<crate::live2d_framing::StageFraming>,
    pub visible: AtomicBool,
    pub revealed: AtomicBool,
    pub first_frame_ready: AtomicBool,
    alpha_mask: RwLock<Option<alpha_mask::PaintedPixels>>,
    pub(crate) pointer_feedback: std::sync::OnceLock<PointerFeedback>,
    pub opacity: AtomicU32,
    /// HWND 以 isize 存储（HWND = *mut c_void 非 Send）。
    pub hwnd: Mutex<Option<isize>>,
    pub companion_hwnd: Mutex<Option<isize>>,
    pub companion_offset: Mutex<Option<(i32, i32)>>,
    placement: Mutex<Option<(isize, OverlayRect)>>,
    /// 窗口线程消息循环就绪标记。
    pub window_ready: AtomicBool,
    /// 渲染线程就绪标记：true 后 setCharacter 等命令不再返回 not-attached。
    pub renderer_attached: AtomicBool,
    /// overlay/render thread 启动门控，避免并发 ensure_overlay 重复启动。
    pub starting: AtomicBool,
    pub(crate) startup_changed: tokio::sync::Notify,
    /// 渲染线程的命令通道。
    pub cmd_tx: Mutex<Option<Sender<OverlayCommand>>>,
    /// 当前加载的角色（口型参数映射等）。
    pub character: Mutex<Option<String>>,
    /// 已渲染帧数（诊断用）。
    pub frame_count: AtomicU64,
    /// 模型可见内容的大致屏幕矩形，仅用于诊断。
    pub model_bounds: Mutex<Option<OverlayRect>>,
    /// 原生渲染循环目标帧率。
    pub fps_limit: AtomicU32,
    pub display_hz: AtomicU32,
    pub target_fps: AtomicU32,
    render_suspended: AtomicBool,
    session_locked: AtomicBool,
    system_suspended: AtomicBool,
    /// 模型 ready 标记：仅在 setCharacter 成功后允许绘制模型。
    pub model_ready: AtomicBool,
    /// 最近一次规范化口型意图与角色映射值，仅供只读发布验收诊断。
    pub last_mouth_level: AtomicU32,
    pub last_mapped_mouth_value: AtomicU32,
    pending_gaze: AtomicU64,
    /// 连续拿不到可绘制 surface 的帧数（镜像渲染线程计数，供诊断取证）。
    /// 持续 > 0 说明 swapchain 拿不到帧，是"画面雪花/冻结"的直接指标。
    pub surface_failures: AtomicU32,
    /// 已就地重建 surface 的次数（镜像渲染线程计数）。
    pub surface_recoveries: AtomicU32,
}

impl Default for Live2DOverlayState {
    fn default() -> Self {
        Self {
            shutdown: AtomicBool::new(false),
            rect: Mutex::new(OverlayRect::default()),
            framing: Mutex::new(crate::live2d_framing::StageFraming::default()),
            visible: AtomicBool::new(false),
            revealed: AtomicBool::new(true),
            first_frame_ready: AtomicBool::new(false),
            alpha_mask: RwLock::default(),
            pointer_feedback: std::sync::OnceLock::new(),
            opacity: AtomicU32::new(255),
            hwnd: Mutex::new(None),
            companion_hwnd: Mutex::new(None),
            companion_offset: Mutex::new(None),
            placement: Mutex::new(None),
            window_ready: AtomicBool::new(false),
            renderer_attached: AtomicBool::new(false),
            starting: AtomicBool::new(false),
            startup_changed: tokio::sync::Notify::new(),
            cmd_tx: Mutex::new(None),
            character: Mutex::new(None),
            frame_count: AtomicU64::new(0),
            model_bounds: Mutex::new(None),
            fps_limit: AtomicU32::new(0),
            display_hz: AtomicU32::new(frame_pacing::FALLBACK_HZ),
            target_fps: AtomicU32::new(0),
            render_suspended: AtomicBool::new(false),
            session_locked: AtomicBool::new(false),
            system_suspended: AtomicBool::new(false),
            model_ready: AtomicBool::new(false),
            last_mouth_level: AtomicU32::new(0.0f32.to_bits()),
            last_mapped_mouth_value: AtomicU32::new(0.0f32.to_bits()),
            pending_gaze: AtomicU64::new(NO_GAZE),
            surface_failures: AtomicU32::new(0),
            surface_recoveries: AtomicU32::new(0),
        }
    }
}

const NO_GAZE: u64 = u64::MAX;

pub(crate) type PointerFeedback = Arc<dyn Fn(Option<PointerHitSample>) + Send + Sync>;

impl Live2DOverlayState {
    pub(crate) fn publish_mouth(&self, level: f32) {
        if !self.model_ready.load(Ordering::Acquire) { return; }
        let level = if level.is_finite() { level.clamp(0.0, 1.0) } else { 0.0 };
        self.last_mouth_level.store(level.to_bits(), Ordering::Relaxed);
    }

    pub(crate) fn publish_gaze(&self, x: f32, y: f32) {
        if self.model_ready.load(Ordering::Acquire) && x.is_finite() && y.is_finite() {
            let x = x.clamp(-1.0, 1.0).to_bits();
            let y = y.clamp(-1.0, 1.0).to_bits();
            self.pending_gaze.store(u64::from(x) << 32 | u64::from(y), Ordering::Relaxed);
        }
    }

    fn take_gaze(&self) -> Option<(f32, f32)> {
        let packed = self.pending_gaze.swap(NO_GAZE, Ordering::Relaxed);
        (packed != NO_GAZE).then(|| (f32::from_bits((packed >> 32) as u32), f32::from_bits(packed as u32)))
    }

    pub fn hit_opaque_pixel(&self, screen_x: i32, screen_y: i32) -> bool {
        if !self.visible.load(Ordering::Acquire) || !self.revealed.load(Ordering::Acquire) { return false; }
        let rect = *self.rect.recover_lock();
        if !rect.contains(screen_x, screen_y) { return false; }
        let framing = *self.framing.recover_lock();
        self.alpha_mask.recover_read().as_ref().is_some_and(|mask| {
            mask.hit(rect, framing, screen_x - rect.x, screen_y - rect.y)
        })
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
/// 复用，GPU 上下文随 destroy 释放，后续 setCharacter 按需重新建立。
fn clear_model_state(state: &Live2DOverlayState) {
    state.model_ready.store(false, Ordering::SeqCst);
    state.first_frame_ready.store(false, Ordering::Release);
    *state.alpha_mask.recover_write() = None;
    *state.character.recover_lock() = None;
    *state.model_bounds.recover_lock() = None;
    reset_mouth_diagnostics(state);
    state.pending_gaze.store(NO_GAZE, Ordering::Relaxed);
}

pub(crate) fn try_begin_startup(state: &Live2DOverlayState) -> bool {
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
    *state.cmd_tx.recover_lock() = None;
    *state.hwnd.recover_lock() = None;
    *state.companion_hwnd.recover_lock() = None;
    *state.companion_offset.recover_lock() = None;
    *state.placement.recover_lock() = None;
    state.window_ready.store(false, Ordering::SeqCst);
    state.renderer_attached.store(false, Ordering::SeqCst);
    state.starting.store(false, Ordering::SeqCst);
    state.startup_changed.notify_waiters();
    state.visible.store(false, Ordering::SeqCst);
    state.target_fps.store(0, Ordering::Relaxed);
    state.render_suspended.store(false, Ordering::Relaxed);
    state.session_locked.store(false, Ordering::Relaxed);
    state.system_suspended.store(false, Ordering::Relaxed);
    clear_model_state(state);
    // 渲染线程退出即丢弃 RenderContext，计数随之重建；镜像值同步清零，
    // 否则新线程起来后 state 里还留着上一代的故障计数，误导诊断。
    state.surface_failures.store(0, Ordering::Relaxed);
    state.surface_recoveries.store(0, Ordering::Relaxed);
    DEVICE_LOST.store(false, Ordering::SeqCst);
    if let Ok(mut slot) = DEVICE_LOST_DETAIL.lock() {
        *slot = None;
    }
}

fn companion_origin(hwnd: HWND) -> Option<POINT> {
    let mut point = POINT { x: 0, y: 0 };
    (unsafe { ClientToScreen(hwnd, &mut point) } != 0).then_some(point)
}

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

pub enum OverlayReply<T> {
    Async(tokio::sync::oneshot::Sender<T>),
    Blocking(std::sync::mpsc::SyncSender<T>),
}

impl<T> OverlayReply<T> {
    fn send(self, response: T) {
        match self {
            Self::Async(reply) => { let _ = reply.send(response); }
            Self::Blocking(reply) => { let _ = reply.send(response); }
        }
    }
}

/// 意图命令：IPC → 渲染线程，带 reply 的命令返回处理结果。
pub enum OverlayCommand {
    Shutdown,
    ReleaseHidden,
    SyncPlacement {
        check_order: bool,
    },
    SetCharacter {
        character: String,
        texture_scale: u32,
        adapter: Live2DAdapterConfig,
        reply: OverlayReply<Result<(), String>>,
    },
    PlayMotion {
        group: String,
        index: Option<i64>,
        priority: Option<String>,
        reply: OverlayReply<Result<(), String>>,
    },
    SetExpression {
        name: String,
        reply: OverlayReply<Result<(), String>>,
    },
    SetEmotion {
        name: String,
        intensity: f32,
    },
    SetMaxFps(u32),
    HitTest {
        x: f32,
        y: f32,
        reply: OverlayReply<Result<Vec<String>, String>>,
    },
    Snapshot {
        path: String,
        reply: OverlayReply<Result<(), String>>,
    },
    Destroy {
        reply: OverlayReply<()>,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MotionPhase {
    Entrance,
    Idle,
    Interaction,
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
    // Author motion/physics must not move the camera by changing the drawable bbox.
    fit_bounds: Option<([f32; 2], [f32; 2])>,
    textures: Vec<renderer::Texture>,
    mouth_level: f32,
    emotion: Option<(String, f32)>,
    gaze: (f32, f32),
    character: Option<String>,
    profile: Option<Live2DAdapterConfig>,
    parameters: ProfileParameters,
    overlay_settler: Option<OverlaySettler>,
    hit_area_names: Vec<String>,
    motion_counts: HashMap<String, usize>,
    motion_durations: HashMap<String, Vec<f32>>,
    motion_last_indices: HashMap<String, usize>,
    motion_seed: u64,
    active_motion: Option<ActiveMotion>,
    alpha_readback: Option<alpha_mask::MaskReadback>,
    last_rect: OverlayRect,
    /// 连续拿不到可绘制 surface 的帧数，见 SURFACE_FAILURE_LIMIT。
    surface_failures: u32,
    /// 已就地重建 surface 的次数，见 SURFACE_RECOVERY_LIMIT。
    surface_recoveries: u32,
    blink: BlinkState,
}

/// Renderer paths are selected by the native owner, never by a WebView command.
#[derive(Clone)]
pub(crate) struct RendererEnvironment {
    pub attached: Option<std::sync::mpsc::SyncSender<()>>,
    pub assets_root: std::path::PathBuf,
    pub local_root: Option<std::path::PathBuf>,
    pub cache_root: Option<std::path::PathBuf>,
    pub events: Option<RendererEvents>,
}

#[derive(Clone)]
pub(crate) struct RendererEvents(pub Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>);
impl RendererEvents {
    pub(crate) fn emit<T: serde::Serialize>(&self, name: &str, payload: T) -> Result<(), String> {
        (self.0)(name, serde_json::to_value(payload).map_err(|error| error.to_string())?);
        Ok(())
    }
}
