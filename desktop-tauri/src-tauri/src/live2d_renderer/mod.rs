use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender, TryRecvError};
#[path = "../live2d_frame_pacing.rs"]
mod frame_pacing;
#[path = "../live2d_adapter.rs"]
pub(crate) mod live2d_adapter;
#[path = "../live2d_assets.rs"]
pub(crate) mod live2d_assets;
use live2d_adapter::{apply_overlay_defaults, Live2DAdapterConfig, MouthBinding, OverlaySettler};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

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

mod blink;
mod device;
#[path = "model.rs"]
mod model_loading;
mod draw;
mod motion;
mod window;
mod commands;
mod frame;
mod selftest;
#[cfg(test)]
mod tests;

pub use selftest::selftest;
#[cfg(test)]
pub(crate) use selftest::selftest_adapter;
pub(crate) use window::overlay_window_thread;
pub(crate) use frame::{apply_frame, state_snapshot, send_command};
use blink::BlinkState;
#[cfg(test)]
use blink::BlinkPhase;
use commands::handle_command;

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
    pub shutdown: AtomicBool,
    pub rect: Mutex<OverlayRect>,
    pub framing: Mutex<crate::live2d_framing::StageFraming>,
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
            shutdown: AtomicBool::new(false),
            rect: Mutex::new(OverlayRect::default()),
            framing: Mutex::new(crate::live2d_framing::StageFraming::default()),
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


/// 意图命令：IPC → 渲染线程。带 reply 的等待同步结果；Async 变体由
/// WndProc 发出（点击命中），渲染线程算完直接 emit 事件。
pub enum OverlayCommand {
    Shutdown,
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


/// Renderer paths are selected by the native owner, never by a WebView command.
#[derive(Clone)]
pub(crate) struct RendererEnvironment {
    pub assets_root: std::path::PathBuf,
    pub local_root: Option<std::path::PathBuf>,
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
