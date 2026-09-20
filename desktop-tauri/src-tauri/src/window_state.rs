use std::fs;
use std::path::Path;
use std::sync::Mutex;

/// 与 Electron 版 windowState.ts 完全一致的 JSON 文件格式与语义，
/// 保证升级迁移后数据无缝可用。

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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

pub fn load_window_bounds(file_path: &Path, fallback: Option<&WindowBounds>) -> WindowBounds {
    let fallback = fallback.unwrap_or(&DEFAULT_BOUNDS);
    let Ok(raw) = fs::read_to_string(file_path) else {
        return fallback.clone();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return fallback.clone();
    };
    let Some(obj) = value.as_object() else { return fallback.clone() };
    let (Some(x), Some(y), Some(width), Some(height)) = (
        obj.get("x").and_then(is_finite_number),
        obj.get("y").and_then(is_finite_number),
        obj.get("width").and_then(is_finite_number),
        obj.get("height").and_then(is_finite_number),
    ) else {
        return fallback.clone();
    };
    WindowBounds { x, y, width, height }
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

pub fn save_window_bounds(file_path: &Path, bounds: &WindowBounds) {
    // 拒绝异常状态（2026-08-15 实机：远程会话中窗口被最小化/虚拟屏切换后
    // 保存了 -18286 坐标与 158x26 尺寸，下次启动窗口在屏幕外不可见）。
    if bounds.width < 40 || bounds.height < 40
        || bounds.x < -10_000 || bounds.y < -10_000
        || bounds.x > 100_000 || bounds.y > 100_000 {
        return;
    }
    let _guard = WINDOW_STATE_WRITE.lock().unwrap_or_else(|error| error.into_inner());
    let mut value = window_state_json(file_path);
    let previous = value.clone();
    value["x"] = serde_json::json!(bounds.x);
    value["y"] = serde_json::json!(bounds.y);
    value["width"] = serde_json::json!(bounds.width);
    value["height"] = serde_json::json!(bounds.height);
    if value != previous { save_json_atomic(file_path, &value); }
}

/// Convert Tauri's physical client-area measurements to Electron-compatible DIP values.
pub fn physical_to_logical_bounds(bounds: &WindowBounds, scale_factor: f64) -> WindowBounds {
    let scale_factor = if scale_factor.is_finite() && scale_factor > 0.0 { scale_factor } else { 1.0 };
    WindowBounds {
        x: (bounds.x as f64 / scale_factor).round() as i64,
        y: (bounds.y as f64 / scale_factor).round() as i64,
        width: (bounds.width as f64 / scale_factor).round() as i64,
        height: (bounds.height as f64 / scale_factor).round() as i64,
    }
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
    save_json_atomic(file_path, &serde_json::json!({ "root": resolved }));
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presentation_accepts_legacy_bounds_and_keeps_normal_geometry() {
        let tmp = std::env::temp_dir().join(format!("aics-window-presentation-{}", std::process::id()));
        let file = tmp.join("window.json");
        let normal = WindowBounds { x: 120, y: 72, width: 1100, height: 800 };
        save_window_bounds(&file, &normal);
        assert_eq!(load_window_presentation(&file), WindowPresentation { zoom: 1.0, maximized: false });
        save_window_presentation(&file, Some(1.5), Some(true));
        assert_eq!(load_window_bounds(&file, None).width, normal.width);
        assert_eq!(load_window_presentation(&file), WindowPresentation { zoom: 1.5, maximized: true });
        save_window_bounds(&file, &WindowBounds { x: 200, ..normal });
        assert_eq!(load_window_presentation(&file), WindowPresentation { zoom: 1.5, maximized: true });
        save_window_presentation(&file, Some(1.0), Some(false));
        assert_eq!(load_window_bounds(&file, None).x, 200);
        assert_eq!(load_window_presentation(&file), WindowPresentation { zoom: 1.0, maximized: false });
        let _ = fs::remove_dir_all(tmp);
    }

    #[test]
    fn corrupt_and_out_of_range_zoom_have_safe_defaults() {
        assert_eq!(bounded_window_zoom(f64::NAN), 1.0);
        assert_eq!(bounded_window_zoom(f64::INFINITY), 1.0);
        assert_eq!(bounded_window_zoom(0.1), 0.75);
        assert_eq!(bounded_window_zoom(3.0), 2.0);
        let tmp = std::env::temp_dir().join(format!("aics-window-presentation-corrupt-{}", std::process::id()));
        let file = tmp.join("window.json");
        fs::create_dir_all(&tmp).unwrap();
        fs::write(&file, r#"{"zoom":"bad","maximized":"true"}"#).unwrap();
        assert_eq!(load_window_presentation(&file), WindowPresentation { zoom: 1.0, maximized: false });
        fs::write(&file, "{broken").unwrap();
        assert_eq!(load_window_presentation(&file), WindowPresentation { zoom: 1.0, maximized: false });
        let _ = fs::remove_dir_all(tmp);
    }

    #[test]
    fn presentation_reports_unwritable_state_instead_of_claiming_persistence() {
        let tmp = std::env::temp_dir().join(format!("aics-window-presentation-write-{}", std::process::id()));
        fs::create_dir_all(&tmp).unwrap();
        let blocker = tmp.join("not-a-directory");
        fs::write(&blocker, "keep").unwrap();
        assert!(!save_window_presentation(&blocker.join("window.json"), Some(1.5), None));
        assert_eq!(fs::read_to_string(&blocker).unwrap(), "keep");
        let _ = fs::remove_dir_all(tmp);
    }

    #[test]
    fn companion_preferences_survive_save_and_restart() {
        let tmp = std::env::temp_dir().join(format!("aics-prefs-test-{}", std::process::id()));
        let file = tmp.join("preferences.json");
        let preferences = CompanionPreferences {
            always_on_top: true, ignore_mouse_events: true, live2d_enabled: Some(false), chat_docked: false,
        };
        save_companion_preferences(&file, &preferences);
        let loaded = load_companion_preferences(&file);
        assert!(loaded.always_on_top);
        assert!(loaded.ignore_mouse_events);
        assert_eq!(loaded.live2d_enabled, Some(false));
        save_companion_preferences(&file, &CompanionPreferences::default());
        let loaded = load_companion_preferences(&file);
        assert!(!loaded.always_on_top);
        assert!(!loaded.ignore_mouse_events);
        assert_eq!(loaded.live2d_enabled, None);
        let _ = fs::remove_dir_all(tmp);
    }

    #[test]
    fn legacy_snake_case_preferences_remain_readable() {
        let preferences: CompanionPreferences = serde_json::from_str(
            r#"{"always_on_top":true,"ignore_mouse_events":true,"live2d_enabled":false}"#,
        ).unwrap();
        assert!(preferences.always_on_top && preferences.ignore_mouse_events);
        assert_eq!(preferences.live2d_enabled, Some(false));
        let json = serde_json::to_value(preferences).unwrap();
        assert_eq!(json["alwaysOnTop"], true);
        assert!(json.get("always_on_top").is_none());
    }

    #[test]
    fn round_trip_window_bounds() {
        let tmp = std::env::temp_dir().join(format!("aics-ws-test-{}", std::process::id()));
        let file = tmp.join("window.json");
        let bounds = WindowBounds { x: 120, y: 80, width: 540, height: 760 };
        save_window_bounds(&file, &bounds);
        let loaded = load_window_bounds(&file, None);
        assert_eq!(loaded.x, 120);
        assert_eq!(loaded.height, 760);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn clamp_keeps_window_on_screen() {
        // 窗口比工作区大时收缩到工作区宽度（Electron 语义）
        let clamped = clamp_window_bounds(
            &WindowBounds { x: -500, y: -500, width: 4000, height: 3000 },
            (0, 0, 1920, 1080),
            None,
        );
        assert_eq!(clamped.width, 1920);
        assert_eq!(clamped.height, 1080);
        // 窗口整体收进工作区（2026-08-15 起，替代旧的"至少留 80px"语义）
        assert!(clamped.x >= 0);
        assert!(clamped.y >= 0);
        assert!(clamped.x + clamped.width <= 1920);
        assert!(clamped.y + clamped.height <= 1080);
        // 正常工作区内的窗口位置保留
        let clamped2 = clamp_window_bounds(
            &WindowBounds { x: 100, y: 100, width: 540, height: 760 },
            (0, 0, 1920, 1080),
            None,
        );
        assert_eq!(clamped2.x, 100);
        assert_eq!(clamped2.y, 100);
    }

    #[test]
    fn corrupt_json_falls_back() {
        let tmp = std::env::temp_dir().join(format!("aics-ws-test2-{}", std::process::id()));
        let file = tmp.join("window.json");
        fs::create_dir_all(&tmp).unwrap();
        fs::write(&file, "{corrupt").unwrap();
        let loaded = load_window_bounds(&file, None);
        assert_eq!(loaded.x, DEFAULT_BOUNDS.x);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn save_rejects_offscreen_minimized_bounds() {
        // 2026-08-15 实机坏状态：远程会话最小化后保存 -18286 坐标与 158x26 尺寸
        let tmp = std::env::temp_dir().join(format!("aics-ws-test4-{}", std::process::id()));
        let file = tmp.join("window.json");
        fs::create_dir_all(&tmp).unwrap();
        let bad = WindowBounds { x: -18286, y: -18286, width: 158, height: 26 };
        save_window_bounds(&file, &bad);
        assert!(!file.exists(), "offscreen/minimized bounds must not be persisted");
        let ok = WindowBounds { x: 24, y: 80, width: 540, height: 760 };
        save_window_bounds(&file, &ok);
        assert!(file.exists());
        let loaded = load_window_bounds(&file, None);
        assert_eq!(loaded.x, 24);
        assert_eq!(loaded.width, 540);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn workspace_round_trip() {
        let tmp = std::env::temp_dir().join(format!("aics-ws-test3-{}", std::process::id()));
        let file = tmp.join("ai-workspace.json");
        fs::create_dir_all(&tmp).unwrap();
        assert!(save_ai_workspace(&file, tmp.to_str().unwrap()));
        assert_eq!(load_ai_workspace(&file), std::path::absolute(&tmp).unwrap().to_string_lossy());
        // 不存在目录拒绝
        assert!(!save_ai_workspace(&file, "Z:/definitely/not/a/dir"));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn physical_bounds_convert_to_logical_dips() {
        let physical = WindowBounds { x: -1500, y: 75, width: 1200, height: 900 };
        let logical = physical_to_logical_bounds(&physical, 1.5);
        assert_eq!(logical.x, -1000);
        assert_eq!(logical.y, 50);
        assert_eq!(logical.width, 800);
        assert_eq!(logical.height, 600);
    }

    #[test]
    fn invalid_scale_factor_is_treated_as_one() {
        let bounds = WindowBounds { x: 10, y: 20, width: 30, height: 40 };
        assert_eq!(physical_to_logical_bounds(&bounds, 0.0).width, 30);
        assert_eq!(physical_to_logical_bounds(&bounds, f64::NAN).height, 40);
    }
}
