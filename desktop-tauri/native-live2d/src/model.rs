//! Safe wrapper around the native Live2D model (motions, expressions,
//! physics, pose, eye blink, parameters, drawables, hit tests).

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;

mod manifest;
pub use manifest::{ExpressionRef, FileReferences, Group, HitArea, Model3Json, MotionRef, parse_model3};

use crate::ffi::{self, l2d_model as L2dModelOpaque};

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

fn ensure_framework() -> Result<(), String> {
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
    model_id: u64,
    pub(crate) position_revision: u64,
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
    static_drawables: Vec<Drawable>,
    drawable_frame: Vec<ffi::DrawableFrame>,
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
        let count = unsafe { ffi::l2d_model_drawable_count(ptr).max(0) };
        let mut model = Model {
            ptr,
            id,
            hidden_drawables: Vec::new(),
            static_drawables: Vec::new(),
            drawable_frame: vec![ffi::DrawableFrame::default(); count as usize],
        };
        model.static_drawables = (0..count).map(|index| model.drawable_static(index)).collect();
        model.refresh_drawable_frame();
        Ok(model)
    }

    /// Drawables in `ids` are dropped from the painted frame (opacity 0 and
    /// invisible in the drawable snapshot). The Core model state is untouched:
    /// hit areas, motions and content bounds keep their authored behavior.
    pub fn set_hidden_drawables(&mut self, ids: &[i32]) {
        self.hidden_drawables = ids.iter().copied().collect();
    }

    /// Stable identity for renderer-side GPU caches.
    ///
    /// The native model can be replaced in the same Rust storage slot, so a
    /// pointer address alone is not sufficient to invalidate cached buffers.
    pub(crate) fn cache_key(&self) -> u64 {
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

    pub fn is_finished(&self, handle: MotionHandle) -> bool {
        unsafe { ffi::l2d_model_is_finished(self.ptr, handle.0) != 0 }
    }

    pub fn set_parameter(&mut self, id: &str, value: f32, weight: f32) {
        let id = ffi::CStringGuard::new(id);
        unsafe { ffi::l2d_model_set_parameter(self.ptr, id.as_ptr(), value, weight) }
    }

    pub fn get_parameter(&self, id: &str) -> f32 {
        let id = ffi::CStringGuard::new(id);
        unsafe { ffi::l2d_model_get_parameter(self.ptr, id.as_ptr()) }
    }

    pub fn set_parameter_by_index(&mut self, index: i32, value: f32, weight: f32) {
        unsafe { ffi::l2d_model_set_parameter_by_index(self.ptr, index, value, weight) }
    }

    pub fn get_parameter_by_index(&self, index: i32) -> f32 {
        unsafe { ffi::l2d_model_get_parameter_by_index(self.ptr, index) }
    }

    /// TEMP DIAG: 把所有参数重置为 moc3 默认值。
    pub fn reset_all_parameters(&mut self) {
        unsafe { ffi::l2d_model_reset_all_parameters(self.ptr) }
    }

    pub fn update(&mut self, delta_time_seconds: f32) {
        unsafe { ffi::l2d_model_update(self.ptr, delta_time_seconds) };
        self.refresh_drawable_frame();
    }

    fn refresh_drawable_frame(&mut self) {
        unsafe { ffi::l2d_model_drawable_frame(self.ptr, self.drawable_frame.as_mut_ptr(), self.drawable_frame.len()) }
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

    /// Refresh a caller-owned snapshot. Static mesh attributes are copied
    /// only when the model changes, and positions only when Core moves a mesh.
    pub fn drawables_into(&self, out: &mut Vec<Drawable>) {
        let count = self.static_drawables.len();
        out.resize_with(count, Drawable::default);
        for (index, drawable) in out.iter_mut().enumerate() {
            if drawable.model_id != self.id {
                drawable.clone_from(&self.static_drawables[index]);
            }
            let frame = self.drawable_frame[index];
            if drawable.position_revision != frame.position_revision {
                let positions = unsafe {
                    slice_from_ffi(ffi::l2d_model_drawable_positions(self.ptr, index as i32) as *const [f32; 2],
                        drawable.vertex_count as i32)
                };
                drawable.positions.clear();
                drawable.positions.extend_from_slice(positions);
                drawable.position_revision = frame.position_revision;
            }
            let hidden = self.hidden_drawables.contains(&(index as i32));
            drawable.visible = frame.visible != 0 && !hidden;
            drawable.opacity = if hidden { 0.0 } else { frame.opacity };
            drawable.render_order = frame.render_order;
            drawable.multiply_color = frame.multiply_color;
            drawable.screen_color = frame.screen_color;
        }
    }

    /// Bounding box of all drawables (visible or not) in canvas units. The
    /// fit must be stable across motion states: authored motions toggle
    /// per-part visibility, and a visible-only bbox would shift the character
    /// mid-animation (the "click flicker" symptom). Some old (Cubism 3)
    /// models have vertices whose unit differs from the canvas size, so
    /// content-fit must use this rather than the canvas size.
    pub fn content_bounds(&self) -> ([f32; 2], [f32; 2]) {
        self.drawable_bounds()
            .unwrap_or_else(|| {
                let half_width = (self.canvas_width().abs() * 0.5).max(0.5);
                let half_height = (self.canvas_height().abs() * 0.5).max(0.5);
                ([-half_width, -half_height], [half_width, half_height])
            })
    }

    fn drawable_bounds(&self) -> Option<([f32; 2], [f32; 2])> {
        let mut min = [f32::MAX, f32::MAX];
        let mut max = [f32::MIN, f32::MIN];
        let mut found = false;
        unsafe {
            for index in 0..self.drawable_count().max(0) {
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

    fn drawable_static(&self, index: i32) -> Drawable {
        unsafe {
            let vertex_count = ffi::l2d_model_drawable_vertex_count(self.ptr, index);
            let positions = slice_from_ffi(
                ffi::l2d_model_drawable_positions(self.ptr, index) as *const [f32; 2], vertex_count);
            let uvs = slice_from_ffi(
                ffi::l2d_model_drawable_uvs(self.ptr, index) as *const [f32; 2], vertex_count);
            let vertex_count = positions.len().min(uvs.len());
            let indices = if vertex_count == 0 {
                &[]
            } else {
                slice_from_ffi(ffi::l2d_model_drawable_indices(self.ptr, index),
                    ffi::l2d_model_drawable_index_count(self.ptr, index))
            };
            let masks = slice_from_ffi(ffi::l2d_model_drawable_masks(self.ptr, index),
                ffi::l2d_model_drawable_mask_count(self.ptr, index));
            Drawable {
                model_id: self.id,
                index,
                vertex_count,
                uvs: uvs[..vertex_count].to_vec(),
                indices: indices.to_vec(),
                masks: masks.to_vec(),
                culling: ffi::l2d_model_drawable_culling(self.ptr, index) != 0,
                texture_index: u32::try_from(ffi::l2d_model_drawable_texture_index(self.ptr, index)).unwrap_or(u32::MAX),
                color_blend: ffi::l2d_model_drawable_color_blend(self.ptr, index),
                alpha_blend: ffi::l2d_model_drawable_alpha_blend(self.ptr, index),
                inverted_mask: ffi::l2d_model_drawable_inverted_mask(self.ptr, index) != 0,
                ..Drawable::default()
            }
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
    /// from the vertex bbox.
    pub center_x: f32,
    pub center_y: f32,
}

impl ViewTransform {
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

    /// Model-to-clip uniform with an extra clip-space X shift.
    pub fn as_uniform_shifted(&self, width: f32, height: f32, x_shift: f32) -> [f32; 4] {
        [
            2.0 * self.scale / width,
            2.0 * self.scale / height,
            x_shift - self.center_x * 2.0 * self.scale / width,
            -self.center_y * 2.0 * self.scale / height,
        ]
    }
}

pub(crate) fn blend_mode_name(color_blend: i32) -> &'static str {
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
