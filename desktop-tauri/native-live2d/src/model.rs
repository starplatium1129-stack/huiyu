//! Safe wrapper around the native Live2D model (motions, expressions,
//! physics, pose, eye blink, parameters, drawables, hit tests).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

use serde::Deserialize;

use crate::ffi::{self, l2d_model as L2dModelOpaque};

pub const PRIORITY_NONE: i32 = ffi::L2D_PRIORITY_NONE;
pub const PRIORITY_IDLE: i32 = ffi::L2D_PRIORITY_IDLE;
pub const PRIORITY_NORMAL: i32 = ffi::L2D_PRIORITY_NORMAL;
pub const PRIORITY_FORCE: i32 = ffi::L2D_PRIORITY_FORCE;

static FRAMEWORK_READY: OnceLock<Result<(), String>> = OnceLock::new();
static NEXT_MODEL_ID: AtomicU64 = AtomicU64::new(1);

unsafe fn slice_from_ffi<'a, T>(pointer: *const T, count: i32) -> &'a [T] {
    if count <= 0 || pointer.is_null() {
        &[]
    } else {
        std::slice::from_raw_parts(pointer, count as usize)
    }
}

pub fn ensure_framework() -> Result<(), String> {
    FRAMEWORK_READY
        .get_or_init(|| {
            let code = unsafe { ffi::l2d_initialize() };
            if code == 0 {
                Ok(())
            } else {
                Err("Cubism framework initialize failed".to_string())
            }
        })
        .clone()
}

/// A motion handle used with `Model::is_finished`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MotionHandle(pub i64);

/// Snapshot of one drawable after `Model::update`.
#[derive(Clone, Debug, Default)]
pub struct Drawable {
    pub index: i32,
    pub vertex_count: usize,
    pub positions: Vec<[f32; 2]>,
    pub uvs: Vec<[f32; 2]>,
    pub indices: Vec<u16>,
    pub opacity: f32,
    pub culling: bool,
    pub texture_index: u32,
    pub visible: bool,
    pub render_order: i32,
    pub color_blend: i32,
    pub alpha_blend: i32,
    pub multiply_color: [f32; 4],
    pub screen_color: [f32; 4],
    pub masks: Vec<i32>,
    pub inverted_mask: bool,
}

/// The old CubismJson parser in the 5-r.5 framework only terminates numeric
/// values on `\n` or `,` (e.g. `0.6 }` fails). Re-serialize every JSON asset
/// with serde so each value sits on its own line before handing it to C++.
fn normalize_json(json: &[u8]) -> Result<Vec<u8>, String> {
    let value: serde_json::Value =
        serde_json::from_slice(json).map_err(|e| format!("json parse failed: {e}"))?;
    serde_json::to_string_pretty(&value)
        .map(|s| s.into_bytes())
        .map_err(|e| format!("json re-serialize failed: {e}"))
}

pub struct Model {
    ptr: *mut L2dModelOpaque,
    id: u64,
    /// Drawable indices that must never be painted (per-character product
    /// fixes, e.g. the natsume model's own backdrop/frame plates 101/102/104
    /// that users perceive as a "transparent box" around the character).
    /// Rendering-only: hit tests and content bounds are unaffected.
    hidden_drawables: Vec<i32>,
}

unsafe impl Send for Model {}

impl Model {
    pub fn create(moc: &[u8], model3: &[u8]) -> Result<Model, String> {
        ensure_framework()?;
        let model3 = normalize_json(model3)?;
        let ptr = unsafe {
            ffi::l2d_model_create(moc.as_ptr(), moc.len(), model3.as_ptr(), model3.len())
        };
        if ptr.is_null() {
            return Err("l2d_model_create failed".to_string());
        }
        let id = NEXT_MODEL_ID.fetch_add(1, Ordering::Relaxed);
        Ok(Model {
            ptr,
            id,
            hidden_drawables: Vec::new(),
        })
    }

    /// Drawables in `ids` are dropped from the painted frame (opacity 0 and
    /// invisible in the drawable snapshot). The Core model state is untouched:
    /// hit areas, motions and content bounds keep their authored behavior.
    pub fn set_hidden_drawables(&mut self, ids: &[i32]) {
        self.hidden_drawables = ids.iter().copied().collect();
    }

    pub fn hidden_drawables(&self) -> &[i32] {
        &self.hidden_drawables
    }

    /// Stable identity for renderer-side GPU caches.
    ///
    /// The native model can be replaced in the same Rust storage slot, so a
    /// pointer address alone is not sufficient to invalidate cached buffers.
    pub fn cache_key(&self) -> u64 {
        self.id
    }

    pub fn add_motion(&mut self, group: &str, index: i32, json: &[u8]) -> Result<(), String> {
        let g = ffi::CStringGuard::new(group);
        let json = normalize_json(json)?;
        let code = unsafe {
            ffi::l2d_model_add_motion(self.ptr, g.as_ptr(), index, json.as_ptr(), json.len())
        };
        if code == 0 {
            Ok(())
        } else {
            Err(format!("add_motion failed: {group}[{index}]"))
        }
    }

    pub fn add_expression(&mut self, name: &str, json: &[u8]) -> Result<(), String> {
        let n = ffi::CStringGuard::new(name);
        let json = normalize_json(json)?;
        let code = unsafe {
            ffi::l2d_model_add_expression(self.ptr, n.as_ptr(), json.as_ptr(), json.len())
        };
        if code == 0 {
            Ok(())
        } else {
            Err(format!("add_expression failed: {name}"))
        }
    }

    pub fn load_physics(&mut self, json: &[u8]) -> Result<(), String> {
        let json = normalize_json(json)?;
        let code = unsafe { ffi::l2d_model_load_physics(self.ptr, json.as_ptr(), json.len()) };
        if code == 0 {
            Ok(())
        } else {
            Err("load_physics failed".to_string())
        }
    }

    pub fn load_pose(&mut self, json: &[u8]) -> Result<(), String> {
        let json = normalize_json(json)?;
        let code = unsafe { ffi::l2d_model_load_pose(self.ptr, json.as_ptr(), json.len()) };
        if code == 0 {
            Ok(())
        } else {
            Err("load_pose failed".to_string())
        }
    }

    pub fn start_motion(&mut self, group: &str, index: i32, priority: i32) -> Option<MotionHandle> {
        let g = ffi::CStringGuard::new(group);
        let handle = unsafe { ffi::l2d_model_start_motion(self.ptr, g.as_ptr(), index, priority) };
        (handle > 0).then_some(MotionHandle(handle))
    }

    pub fn start_expression(&mut self, name: &str, priority: i32) -> Option<MotionHandle> {
        let n = ffi::CStringGuard::new(name);
        let handle = unsafe { ffi::l2d_model_start_expression(self.ptr, n.as_ptr(), priority) };
        (handle > 0).then_some(MotionHandle(handle))
    }

    pub fn stop_all_motions(&mut self) {
        unsafe { ffi::l2d_model_stop_all_motions(self.ptr) }
    }

    pub fn is_finished(&self, handle: MotionHandle) -> bool {
        unsafe { ffi::l2d_model_is_finished(self.ptr, handle.0) != 0 }
    }

    pub fn has_playing_motion(&self) -> bool {
        unsafe { ffi::l2d_model_has_playing_motion(self.ptr) != 0 }
    }

    pub fn set_parameter(&mut self, id: &str, value: f32, weight: f32) {
        let id = ffi::CStringGuard::new(id);
        unsafe { ffi::l2d_model_set_parameter(self.ptr, id.as_ptr(), value, weight) }
    }

    pub fn get_parameter(&self, id: &str) -> f32 {
        let id = ffi::CStringGuard::new(id);
        unsafe { ffi::l2d_model_get_parameter(self.ptr, id.as_ptr()) }
    }

    pub fn set_part_opacity(&mut self, id: &str, opacity: f32) {
        let id = ffi::CStringGuard::new(id);
        unsafe { ffi::l2d_model_set_part_opacity(self.ptr, id.as_ptr(), opacity) }
    }

    /// 复位夏目叠层/换装参数到作者默认值（互动动作结束后调用，见 C++ 侧注释）。
    pub fn reset_overlay_params(&mut self) {
        unsafe { ffi::l2d_model_reset_overlay_params(self.ptr) }
    }

    /// 每帧守卫：非互动/非登场期间把叠层参数强制写回隐藏态（Idle 动作
    /// Idle_6 会把 Param36/37 拉出隐藏态导致静止时叠层显示发灰，见
    /// docs/live2d-native-runtime.md；C++ 侧与 reset 共用隐藏态表）。
    pub fn force_overlay_hidden(&mut self) {
        unsafe { ffi::l2d_model_force_overlay_hidden(self.ptr) }
    }

    /// 互动/登场动作结束后开始叠层/换装参数的平滑回落：捕获各参数当前
    /// 值（动作曲线留下的换装显隐态），此后由 step_overlay_settle 向隐藏
    /// 态 smoothstep 缓动。替代一次性硬写——后者让换装部件在单帧内消失
    /// 回穿，视觉上是"闪一下"（2026-08-23 桌宠实机反馈）。duration<=0
    /// 时 C++ 侧退化为立即复位。
    pub fn begin_overlay_settle(&mut self, duration_seconds: f32) {
        unsafe { ffi::l2d_model_begin_overlay_settle(self.ptr, duration_seconds) }
    }

    /// 推进回落动画（须在 model.update 之后调用）。返回 true 表示本帧仍在
    /// 回落中，调用方应跳过硬性隐藏守卫；false 表示已结束或未激活。
    pub fn step_overlay_settle(&mut self, delta_time_seconds: f32) -> bool {
        unsafe { ffi::l2d_model_step_overlay_settle(self.ptr, delta_time_seconds) != 0 }
    }

    /// TEMP DIAG: 把所有参数重置为 moc3 默认值。
    pub fn reset_all_parameters(&mut self) {
        unsafe { ffi::l2d_model_reset_all_parameters(self.ptr) }
    }

    pub fn get_part_opacity(&self, id: &str) -> f32 {
        let id = ffi::CStringGuard::new(id);
        unsafe { ffi::l2d_model_get_part_opacity(self.ptr, id.as_ptr()) }
    }

    pub fn set_eye_blink_enabled(&mut self, enabled: bool) {
        unsafe { ffi::l2d_model_set_eye_blink_enabled(self.ptr, enabled as i32) }
    }

    pub fn set_opacity(&mut self, opacity: f32) {
        unsafe { ffi::l2d_model_set_opacity(self.ptr, opacity) }
    }

    pub fn update(&mut self, delta_time_seconds: f32) {
        unsafe { ffi::l2d_model_update(self.ptr, delta_time_seconds) }
    }

    pub fn canvas_width(&self) -> f32 {
        unsafe { ffi::l2d_model_canvas_width(self.ptr) }
    }

    pub fn canvas_height(&self) -> f32 {
        unsafe { ffi::l2d_model_canvas_height(self.ptr) }
    }

    pub fn drawable_count(&self) -> i32 {
        unsafe { ffi::l2d_model_drawable_count(self.ptr) }
    }

    pub fn drawable_index(&self, id: &str) -> Option<i32> {
        let id = ffi::CStringGuard::new(id);
        let index = unsafe { ffi::l2d_model_drawable_index(self.ptr, id.as_ptr()) };
        (index >= 0).then_some(index)
    }

    /// Copy the drawable snapshot. Call after `update`.
    pub fn drawables(&self) -> Vec<Drawable> {
        let count = self.drawable_count().max(0) as usize;
        let mut out = Vec::with_capacity(count);
        self.drawables_into(&mut out);
        out
    }

    /// Refresh a caller-owned drawable snapshot without reallocating each
    /// positions/UV/index/mask vector on every frame.
    pub fn drawables_into(&self, out: &mut Vec<Drawable>) {
        let count = self.drawable_count().max(0) as usize;
        out.truncate(count);
        while out.len() < count {
            out.push(Drawable::default());
        }
        for (index, drawable) in out.iter_mut().enumerate() {
            self.drawable_at_into(index as i32, drawable);
            if self.hidden_drawables.contains(&(index as i32)) {
                drawable.visible = false;
                drawable.opacity = 0.0;
            }
        }
    }

    /// Bounding box of all drawables (visible or not) in canvas units. The
    /// fit must be stable across motion states: authored motions toggle
    /// per-part visibility, and a visible-only bbox would shift the character
    /// mid-animation (the "click flicker" symptom). Some old (Cubism 3)
    /// models have vertices whose unit differs from the canvas size, so
    /// content-fit must use this rather than the canvas size.
    pub fn content_bounds(&self) -> ([f32; 2], [f32; 2]) {
        self.drawable_bounds(false)
            .unwrap_or_else(|| {
                let half_width = (self.canvas_width().abs() * 0.5).max(0.5);
                let half_height = (self.canvas_height().abs() * 0.5).max(0.5);
                ([-half_width, -half_height], [half_width, half_height])
            })
    }

    fn drawable_bounds(&self, visible_only: bool) -> Option<([f32; 2], [f32; 2])> {
        let mut min = [f32::MAX, f32::MAX];
        let mut max = [f32::MIN, f32::MIN];
        let mut found = false;
        unsafe {
            for index in 0..self.drawable_count().max(0) {
                if visible_only && ffi::l2d_model_drawable_visible(self.ptr, index) == 0 {
                    continue;
                }
                let vertex_count = ffi::l2d_model_drawable_vertex_count(self.ptr, index);
                let positions_ptr = ffi::l2d_model_drawable_positions(self.ptr, index);
                let positions = slice_from_ffi(positions_ptr as *const [f32; 2], vertex_count);
                for p in positions {
                    if !p[0].is_finite() || !p[1].is_finite() {
                        continue;
                    }
                    found = true;
                    min[0] = min[0].min(p[0]);
                    min[1] = min[1].min(p[1]);
                    max[0] = max[0].max(p[0]);
                    max[1] = max[1].max(p[1]);
                }
            }
        }
        found.then_some((min, max))
    }

    fn drawable_at_into(&self, index: i32, drawable: &mut Drawable) {
        unsafe {
            let vertex_count = ffi::l2d_model_drawable_vertex_count(self.ptr, index);
            let index_count = ffi::l2d_model_drawable_index_count(self.ptr, index);
            let positions_ptr = ffi::l2d_model_drawable_positions(self.ptr, index);
            let uvs_ptr = ffi::l2d_model_drawable_uvs(self.ptr, index);
            let indices_ptr = ffi::l2d_model_drawable_indices(self.ptr, index);
            let mask_count = ffi::l2d_model_drawable_mask_count(self.ptr, index);
            let masks_ptr = ffi::l2d_model_drawable_masks(self.ptr, index);
            let mut multiply = [0f32; 4];
            let mut screen = [0f32; 4];
            ffi::l2d_model_drawable_multiply_color(self.ptr, index, multiply.as_mut_ptr());
            ffi::l2d_model_drawable_screen_color(self.ptr, index, screen.as_mut_ptr());

            let positions = slice_from_ffi(positions_ptr as *const [f32; 2], vertex_count);
            let uvs = slice_from_ffi(uvs_ptr as *const [f32; 2], vertex_count);
            let vertex_count = positions.len().min(uvs.len());
            let indices = if vertex_count == 0 {
                &[]
            } else {
                slice_from_ffi(indices_ptr, index_count)
            };
            let masks = slice_from_ffi(masks_ptr, mask_count);

            drawable.index = index;
            drawable.vertex_count = vertex_count;
            drawable.positions.resize(vertex_count, [0.0; 2]);
            drawable
                .positions
                .copy_from_slice(&positions[..vertex_count]);
            drawable.uvs.resize(vertex_count, [0.0; 2]);
            drawable.uvs.copy_from_slice(&uvs[..vertex_count]);
            drawable.indices.resize(indices.len(), 0);
            drawable.indices.copy_from_slice(indices);
            drawable.masks.resize(masks.len(), 0);
            drawable.masks.copy_from_slice(masks);
            drawable.opacity = ffi::l2d_model_drawable_opacity(self.ptr, index);
            drawable.culling = ffi::l2d_model_drawable_culling(self.ptr, index) != 0;
            drawable.texture_index =
                u32::try_from(ffi::l2d_model_drawable_texture_index(self.ptr, index))
                    .unwrap_or(u32::MAX);
            drawable.visible = ffi::l2d_model_drawable_visible(self.ptr, index) != 0;
            drawable.render_order = ffi::l2d_model_drawable_render_order(self.ptr, index);
            drawable.color_blend = ffi::l2d_model_drawable_color_blend(self.ptr, index);
            drawable.alpha_blend = ffi::l2d_model_drawable_alpha_blend(self.ptr, index);
            drawable.multiply_color = multiply;
            drawable.screen_color = screen;
            drawable.inverted_mask = ffi::l2d_model_drawable_inverted_mask(self.ptr, index) != 0;
        }
    }

    /// Hit test in canvas space (official bounding-box semantics).
    pub fn hit_test(&self, hit_area_id: &str, canvas_x: f32, canvas_y: f32) -> bool {
        let id = ffi::CStringGuard::new(hit_area_id);
        unsafe { ffi::l2d_model_hit_test(self.ptr, id.as_ptr(), canvas_x, canvas_y) != 0 }
    }

    pub fn parameter_index(&self, id: &str) -> Option<i32> {
        let id = ffi::CStringGuard::new(id);
        let index = unsafe { ffi::l2d_model_parameter_index(self.ptr, id.as_ptr()) };
        (index >= 0).then_some(index)
    }
}

impl Drop for Model {
    fn drop(&mut self) {
        unsafe { ffi::l2d_model_destroy(self.ptr) }
    }
}

/// model3.json subset needed to enumerate assets and hit areas.
#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "PascalCase")]
pub struct Model3Json {
    #[serde(default)]
    pub version: Option<serde_json::Value>,
    #[serde(default)]
    pub file_references: Option<FileReferences>,
    #[serde(default)]
    pub groups: Vec<Group>,
    #[serde(default)]
    pub hit_areas: Vec<HitArea>,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "PascalCase")]
pub struct FileReferences {
    #[serde(default)]
    pub moc: Option<String>,
    #[serde(default)]
    pub textures: Vec<String>,
    #[serde(default)]
    pub physics: Option<String>,
    #[serde(default)]
    pub pose: Option<String>,
    #[serde(default)]
    pub expressions: Vec<ExpressionRef>,
    #[serde(default)]
    pub motions: std::collections::HashMap<String, Vec<MotionRef>>,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "PascalCase")]
pub struct ExpressionRef {
    pub name: String,
    pub file: String,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "PascalCase")]
pub struct MotionRef {
    pub file: String,
    #[serde(default)]
    pub fade_in_time: Option<f32>,
    #[serde(default)]
    pub fade_out_time: Option<f32>,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "PascalCase")]
pub struct Group {
    #[serde(default)]
    pub target: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub ids: Vec<String>,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(rename_all = "PascalCase")]
pub struct HitArea {
    pub name: String,
    pub id: String,
}

/// Transform for canvas->screen coordinates (used by renderer and hit tests).
///
/// Cubism Core reports drawable vertices in *canvas space with the origin at
/// the canvas center and Y pointing up*, already normalized by pixelsPerUnit.
/// Mapping to screen/clip space is a uniform scale + a translation that puts
/// the fitted content's center at the screen center. Models whose character is
/// offset inside the canvas (Live2DViewerEX 解包工坊模型常见，如夏目
/// 内容包围盒中心显著偏右) must center on the content bbox center rather
/// than the canvas origin, otherwise the character hugs the stage edge.
#[derive(Clone, Copy, Debug)]
pub struct ViewTransform {
    pub scale: f32,
    /// Canvas-space center of the fitted content. `fit_content` derives it
    /// from the vertex bbox; `fit` keeps the canvas origin (0, 0).
    pub center_x: f32,
    pub center_y: f32,
}

impl ViewTransform {
    /// Fit the canvas into (width x height) preserving aspect ratio.
    pub fn fit(
        canvas_w: f32,
        canvas_h: f32,
        width: f32,
        height: f32,
        scale_override: Option<f32>,
    ) -> Self {
        let scale = scale_override.unwrap_or((width / canvas_w).min(height / canvas_h));
        Self {
            scale,
            center_x: 0.0,
            center_y: 0.0,
        }
    }

    /// Fit the *content* (vertex bbox) into (width x height), centered on the
    /// bbox center. Works for old Cubism 3 models whose vertex unit differs
    /// from the canvas size and for models whose character is offset inside
    /// the canvas (both must render centered, matching the static portrait).
    pub fn fit_content(
        bounds: ([f32; 2], [f32; 2]),
        width: f32,
        height: f32,
        padding: f32,
    ) -> Self {
        let (min, max) = bounds;
        let w = (max[0] - min[0]).max(1e-6);
        let h = (max[1] - min[1]).max(1e-6);
        let scale = ((width * (1.0 - padding)) / w).min((height * (1.0 - padding)) / h);
        Self {
            scale,
            center_x: (min[0] + max[0]) * 0.5,
            center_y: (min[1] + max[1]) * 0.5,
        }
    }

    pub fn canvas_to_screen(&self, x: f32, y: f32, width: f32, height: f32) -> (f32, f32) {
        (
            width * 0.5 + (x - self.center_x) * self.scale,
            height * 0.5 - (y - self.center_y) * self.scale,
        )
    }

    pub fn screen_to_canvas(&self, x: f32, y: f32, width: f32, height: f32) -> (f32, f32) {
        (
            (x - width * 0.5) / self.scale + self.center_x,
            (height * 0.5 - y) / self.scale + self.center_y,
        )
    }

    /// Model canvas coordinate -> clip space (x right, y up).
    pub fn canvas_to_clip(&self, x: f32, y: f32, width: f32, height: f32) -> [f32; 2] {
        [
            (x - self.center_x) / width * 2.0 * self.scale,
            (y - self.center_y) / height * 2.0 * self.scale,
        ]
    }

    pub fn as_uniform(&self, width: f32, height: f32) -> [f32; 4] {
        [
            2.0 * self.scale / width,
            2.0 * self.scale / height,
            -self.center_x * 2.0 * self.scale / width,
            -self.center_y * 2.0 * self.scale / height,
        ]
    }

    /// Debug: same as `as_uniform` plus an extra clip-space X shift.
    pub fn as_uniform_shifted(&self, width: f32, height: f32, x_shift: f32) -> [f32; 4] {
        [
            2.0 * self.scale / width,
            2.0 * self.scale / height,
            x_shift - self.center_x * 2.0 * self.scale / width,
            -self.center_y * 2.0 * self.scale / height,
        ]
    }
}

/// Load a model3.json from bytes.
pub fn parse_model3(json: &[u8]) -> Result<Model3Json, String> {
    serde_json::from_slice(json).map_err(|e| format!("model3.json parse failed: {e}"))
}

pub fn blend_mode_name(color_blend: i32) -> &'static str {
    match color_blend {
        ffi::L2D_COLOR_BLEND_NORMAL => "Normal",
        ffi::L2D_COLOR_BLEND_ADD_COMPATIBLE => "Add(compat)",
        ffi::L2D_COLOR_BLEND_MULTIPLY_COMPATIBLE => "Multiply(compat)",
        ffi::L2D_COLOR_BLEND_ADD => "Add",
        ffi::L2D_COLOR_BLEND_ADD_GLOW => "AddGlow",
        ffi::L2D_COLOR_BLEND_DARKEN => "Darken",
        ffi::L2D_COLOR_BLEND_MULTIPLY => "Multiply",
        ffi::L2D_COLOR_BLEND_COLOR_BURN => "ColorBurn",
        ffi::L2D_COLOR_BLEND_LINEAR_BURN => "LinearBurn",
        ffi::L2D_COLOR_BLEND_LIGHTEN => "Lighten",
        ffi::L2D_COLOR_BLEND_SCREEN => "Screen",
        ffi::L2D_COLOR_BLEND_COLOR_DODGE => "ColorDodge",
        ffi::L2D_COLOR_BLEND_OVERLAY => "Overlay",
        ffi::L2D_COLOR_BLEND_SOFT_LIGHT => "SoftLight",
        ffi::L2D_COLOR_BLEND_HARD_LIGHT => "HardLight",
        ffi::L2D_COLOR_BLEND_LINEAR_LIGHT => "LinearLight",
        ffi::L2D_COLOR_BLEND_HUE => "Hue",
        ffi::L2D_COLOR_BLEND_COLOR => "Color",
        _ => "Unknown",
    }
}
