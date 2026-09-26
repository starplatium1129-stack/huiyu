use live2d_native::model::ViewTransform;
use tauri::{AppHandle, Manager};
use std::sync::Arc;
use crate::live2d_overlay::{apply_frame, Live2DOverlayState, OverlayRect};

#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize)]
pub struct StageFraming { pub zoom: f32, pub x: f32, pub y: f32 }
impl Default for StageFraming {
    fn default() -> Self { Self { zoom: 1.0, x: 0.0, y: 0.0 } }
}
impl StageFraming {
    pub fn validate(self) -> Result<Self, String> {
        if !self.zoom.is_finite() || !self.x.is_finite() || !self.y.is_finite() { return Err("invalid framing".into()); }
        Ok(Self { zoom: self.zoom.clamp(0.65, 2.2), x: self.x.clamp(-0.25, 0.25), y: self.y.clamp(-0.25, 0.25) })
    }
    pub fn transform(self, bounds: ([f32; 2], [f32; 2]), width: f32, height: f32) -> ViewTransform {
        let mut view = ViewTransform::fit_content(bounds, width, height, 0.02);
        view.scale *= self.zoom;
        view.center_x -= self.x * width / view.scale;
        view.center_y += self.y * height / view.scale;
        view
    }
}

#[tauri::command]
pub async fn aics_live2d_set_frame(app: AppHandle, rect: serde_json::Value, visible: bool, opacity: Option<f64>, framing: Option<StageFraming>) -> Result<(), String> {
    let framing = framing.unwrap_or_default().validate()?;
    let obj = rect.as_object().ok_or("rect must be an object")?;
    let x = obj.get("x").and_then(|v| v.as_i64()).ok_or("rect.x")? as i32;
    let y = obj.get("y").and_then(|v| v.as_i64()).ok_or("rect.y")? as i32;
    let width = obj.get("width").and_then(|v| v.as_u64()).ok_or("rect.width")? as u32;
    let height = obj.get("height").and_then(|v| v.as_u64()).ok_or("rect.height")? as u32;
    if crate::live2d_process::enabled() {
        let companion_hwnd = app.get_webview_window("companion").and_then(|window| window.hwnd().ok()).map(|handle| handle.0 as isize);
        return crate::live2d_process::call(&app, crate::live2d_process_protocol::Command::SetFrame {
            rect: OverlayRect { x, y, width, height }, visible,
            opacity: opacity.map(|o| (o.clamp(0.0, 1.0) * 255.0) as u32),
            framing: Some(serde_json::to_value(framing).map_err(|e| e.to_string())?), companion_hwnd,
        }).await.map(|_| ());
    }
    if let Some(state) = app.try_state::<Arc<Live2DOverlayState>>() { *state.framing.lock().unwrap() = framing; }
    apply_frame(&app, OverlayRect { x, y, width, height }, visible, opacity.map(|o| (o.clamp(0.0, 1.0) * 255.0) as u32))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn framing_and_hit_coordinates_share_a_transform() {
        let f = StageFraming { zoom: 1.65, x: -0.1, y: 0.12 };
        let view = f.transform(([-1.0, -2.0], [1.0, 2.0]), 800.0, 1200.0);
        let (x, y) = view.canvas_to_screen(0.3, 1.4, 800.0, 1200.0);
        let (cx, cy) = view.screen_to_canvas(x, y, 800.0, 1200.0);
        assert!((cx - 0.3).abs() < 0.001 && (cy - 1.4).abs() < 0.001);
        assert!(StageFraming { zoom: f32::NAN, ..f }.validate().is_err());
    }
}
