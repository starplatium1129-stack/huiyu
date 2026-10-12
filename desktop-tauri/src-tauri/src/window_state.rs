use std::fs;
use std::path::Path;
use std::sync::Mutex;

#[path = "window_geometry.rs"]
mod geometry;
pub use geometry::{clamp_bounds_to_work_areas, normalize_companion_bounds, physical_to_logical_bounds,
    restore_window_placement, DisplayWorkArea, WindowPlacement};

/// 与 Electron 版 windowState.ts 完全一致的 JSON 文件格式与语义，
/// 保证升级迁移后数据无缝可用。

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct WindowBounds {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionPreferences {
    #[serde(default, alias = "always_on_top")]
    pub always_on_top: bool,
    #[serde(default, alias = "ignore_mouse_events")]
    pub ignore_mouse_events: bool,
    #[serde(default, alias = "live2d_enabled")]
    pub live2d_enabled: Option<bool>,
    #[serde(default = "default_chat_docked")]
    pub chat_docked: bool,
}
fn default_chat_docked() -> bool { true }
impl Default for CompanionPreferences {
    fn default() -> Self { Self { always_on_top: false, ignore_mouse_events: false, live2d_enabled: None, chat_docked: true } }
}

const DEFAULT_BOUNDS: WindowBounds = WindowBounds { x: 24, y: 80, width: 540, height: 760 };

// Geometry and zoom can be saved from different IPC/window callbacks. Serialize
// read-modify-write so neither callback discards the other's JSON fields.
static WINDOW_STATE_WRITE: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WindowPresentation {
    pub zoom: f64,
    pub maximized: bool,
}

pub fn bounded_window_zoom(zoom: f64) -> f64 {
    if zoom.is_finite() { zoom.clamp(0.75, 2.0) } else { 1.0 }
}

fn window_state_json(file_path: &Path) -> serde_json::Value {
    fs::read_to_string(file_path).ok()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
        .filter(|value| value.is_object())
        .unwrap_or_else(|| serde_json::json!({}))
}

pub fn load_window_presentation(file_path: &Path) -> WindowPresentation {
    let value = window_state_json(file_path);
    WindowPresentation {
        zoom: bounded_window_zoom(value.get("zoom").and_then(|zoom| zoom.as_f64()).unwrap_or(1.0)),
        maximized: value.get("maximized").and_then(|state| state.as_bool()).unwrap_or(false),
    }
}

pub fn save_window_presentation(file_path: &Path, zoom: Option<f64>, maximized: Option<bool>) -> bool {
    let _guard = WINDOW_STATE_WRITE.lock().unwrap_or_else(|error| error.into_inner());
    let mut value = window_state_json(file_path);
    let previous = value.clone();
    if let Some(zoom) = zoom { value["zoom"] = serde_json::json!(bounded_window_zoom(zoom)); }
    if let Some(maximized) = maximized { value["maximized"] = serde_json::json!(maximized); }
    value == previous || try_save_json_atomic(file_path, &value)
}

fn is_finite_number(v: &serde_json::Value) -> Option<i64> {
    v.as_f64().filter(|f| f.is_finite()).map(|f| f.round() as i64)
}

pub fn load_window_bounds(file_path: &Path, fallback: Option<&WindowBounds>) -> (WindowBounds, Option<WindowBounds>) {
    let fallback = fallback.unwrap_or(&DEFAULT_BOUNDS);
    let Ok(raw) = fs::read_to_string(file_path) else {
        return (fallback.clone(), None);
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return (fallback.clone(), None);
    };
    let Some(obj) = value.as_object() else { return (fallback.clone(), None) };
    let (Some(x), Some(y), Some(width), Some(height)) = (
        obj.get("x").and_then(is_finite_number),
        obj.get("y").and_then(is_finite_number),
        obj.get("width").and_then(is_finite_number),
        obj.get("height").and_then(is_finite_number),
    ) else {
        return (fallback.clone(), None);
    };
    let physical = obj.get("physicalBounds").cloned()
        .and_then(|value| serde_json::from_value::<WindowBounds>(value).ok())
        .filter(valid_saved_bounds);
    (WindowBounds { x, y, width, height }, physical)
}

pub fn clamp_window_bounds(
    bounds: &WindowBounds,
    work_area: (i64, i64, i64, i64), // (x, y, width, height)
    min_size: Option<(i64, i64)>,    // (minWidth, minHeight)
) -> WindowBounds {
    let (area_x, area_y, area_w, area_h) = work_area;
    let (min_width, min_height) = min_size.unwrap_or((360, 480));
    let width = (bounds.width.min(area_w)).max(min_width.min(area_w));
    let height = (bounds.height.min(area_h)).max(min_height.min(area_h));
    // 完全收进工作区（2026-08-15：旧实现允许"只留 80px"，配合坏状态文件
    // 会把窗口夹在屏幕外；统一要求窗口整体可见）
    let max_x = (area_x + area_w - width).max(area_x);
    let max_y = (area_y + area_h - height).max(area_y);
    let x = (bounds.x.max(area_x)).min(max_x);
    let y = (bounds.y.max(area_y)).min(max_y);
    WindowBounds { x, y, width, height }
}

/// 原子写：临时文件 + rename（与 Electron 版一致，防半写损坏）
pub fn save_json_atomic(file_path: &Path, value: &serde_json::Value) {
    let _ = try_save_json_atomic(file_path, value);
}

fn try_save_json_atomic(file_path: &Path, value: &serde_json::Value) -> bool {
    let Some(parent) = file_path.parent() else { return false };
    if fs::create_dir_all(parent).is_err() { return false; }
    let temporary = file_path.with_extension(format!("{}.{}.tmp", "json", std::process::id()));
    if fs::write(&temporary, serde_json::to_string(value).unwrap_or_default()).is_ok()
        && fs::rename(&temporary, file_path).is_ok() {
        return true;
    }
    let _ = fs::remove_file(&temporary);
    false
}

fn valid_saved_bounds(bounds: &WindowBounds) -> bool {
    bounds.width >= 40 && bounds.height >= 40 && bounds.width <= 100_000 && bounds.height <= 100_000
        && (-10_000..=100_000).contains(&bounds.x) && (-10_000..=100_000).contains(&bounds.y)
}

pub fn save_window_bounds(file_path: &Path, bounds: &WindowBounds, physical: Option<&WindowBounds>) {
    // 拒绝异常状态（2026-08-15 实机：远程会话中窗口被最小化/虚拟屏切换后
    // 保存了 -18286 坐标与 158x26 尺寸，下次启动窗口在屏幕外不可见）。
    if !valid_saved_bounds(bounds) { return; }
    let _guard = WINDOW_STATE_WRITE.lock().unwrap_or_else(|error| error.into_inner());
    let mut value = window_state_json(file_path);
    let previous = value.clone();
    value["x"] = serde_json::json!(bounds.x);
    value["y"] = serde_json::json!(bounds.y);
    value["width"] = serde_json::json!(bounds.width);
    value["height"] = serde_json::json!(bounds.height);
    // Older readers ignore this optional field; new saves never retain a hint for old coordinates.
    if let Some(physical) = physical.filter(|bounds| valid_saved_bounds(bounds)) {
        value["physicalBounds"] = serde_json::json!(physical);
    } else { value.as_object_mut().unwrap().remove("physicalBounds"); }
    if value != previous { save_json_atomic(file_path, &value); }
}

pub fn load_companion_preferences(file_path: &Path) -> CompanionPreferences {
    let Ok(raw) = fs::read_to_string(file_path) else {
        return CompanionPreferences::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save_companion_preferences(file_path: &Path, preferences: &CompanionPreferences) {
    save_json_atomic(
        file_path,
        &serde_json::to_value(preferences).expect("companion preferences must serialize"),
    );
}

pub fn load_desktop_gateway_port(file_path: &Path, fallback: u16) -> u16 {
    let Ok(raw) = fs::read_to_string(file_path) else {
        return fallback;
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return fallback;
    };
    value
        .as_object()
        .and_then(|o| o.get("port").and_then(|v| v.as_u64()))
        .filter(|p| (1024..=65_535).contains(p))
        .map(|p| p as u16)
        .unwrap_or(fallback)
}

pub fn save_desktop_gateway_port(file_path: &Path, port: u16) {
    if !(1024..=65_535).contains(&port) {
        return;
    }
    save_json_atomic(file_path, &serde_json::json!({ "port": port }));
}

pub fn load_ai_workspace(file_path: &Path) -> String {
    let Ok(raw) = fs::read_to_string(file_path) else {
        return String::new();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return String::new();
    };
    let root = value
        .as_object()
        .and_then(|o| o.get("root"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if root.trim().is_empty() {
        return String::new();
    }
    let resolved = std::path::absolute(root.trim())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| root.trim().to_string());
    if Path::new(&resolved).is_dir() {
        resolved
    } else {
        String::new()
    }
}

pub fn save_ai_workspace(file_path: &Path, root: &str) -> bool {
    let Ok(resolved) = std::path::absolute(root) else {
        return false;
    };
    if !resolved.is_dir() {
        return false;
    }
    try_save_json_atomic(file_path, &serde_json::json!({ "root": resolved }))
}
