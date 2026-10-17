//! Raw FFI bindings to the C++ glue (csrc/live2d_model.cpp).

#![allow(clippy::missing_safety_doc)]

use std::ffi::{c_char, c_float, c_int, c_uchar, c_ushort};

#[repr(C)]
pub struct l2d_model {
    _private: [u8; 0],
}

pub const L2D_COLOR_BLEND_NORMAL: c_int = 0;
pub const L2D_COLOR_BLEND_ADD_COMPATIBLE: c_int = 1;
pub const L2D_COLOR_BLEND_MULTIPLY_COMPATIBLE: c_int = 2;
pub const L2D_COLOR_BLEND_ADD: c_int = 3;
pub const L2D_COLOR_BLEND_ADD_GLOW: c_int = 4;
pub const L2D_COLOR_BLEND_DARKEN: c_int = 5;
pub const L2D_COLOR_BLEND_MULTIPLY: c_int = 6;
pub const L2D_COLOR_BLEND_COLOR_BURN: c_int = 7;
pub const L2D_COLOR_BLEND_LINEAR_BURN: c_int = 8;
pub const L2D_COLOR_BLEND_LIGHTEN: c_int = 9;
pub const L2D_COLOR_BLEND_SCREEN: c_int = 10;
pub const L2D_COLOR_BLEND_COLOR_DODGE: c_int = 11;
pub const L2D_COLOR_BLEND_OVERLAY: c_int = 12;
pub const L2D_COLOR_BLEND_SOFT_LIGHT: c_int = 13;
pub const L2D_COLOR_BLEND_HARD_LIGHT: c_int = 14;
pub const L2D_COLOR_BLEND_LINEAR_LIGHT: c_int = 15;
pub const L2D_COLOR_BLEND_HUE: c_int = 16;
pub const L2D_COLOR_BLEND_COLOR: c_int = 17;


pub const L2D_PRIORITY_IDLE: c_int = 1;
pub const L2D_PRIORITY_NORMAL: c_int = 2;
pub const L2D_PRIORITY_FORCE: c_int = 3;

extern "C" {
    pub fn l2d_initialize() -> c_int;
    pub fn l2d_model_create(
        moc_data: *const c_uchar,
        moc_size: usize,
        model3_data: *const c_uchar,
        model3_size: usize,
    ) -> *mut l2d_model;
    pub fn l2d_model_destroy(m: *mut l2d_model);
    pub fn l2d_model_add_motion(
        m: *mut l2d_model,
        group: *const c_char,
        index: c_int,
        json: *const c_uchar,
        size: usize,
    ) -> c_int;
    pub fn l2d_model_add_expression(
        m: *mut l2d_model,
        name: *const c_char,
        json: *const c_uchar,
        size: usize,
    ) -> c_int;
    pub fn l2d_model_load_physics(m: *mut l2d_model, json: *const c_uchar, size: usize) -> c_int;
    pub fn l2d_model_load_pose(m: *mut l2d_model, json: *const c_uchar, size: usize) -> c_int;
    pub fn l2d_model_start_motion(
        m: *mut l2d_model,
        group: *const c_char,
        index: c_int,
        priority: c_int,
    ) -> i64;
    pub fn l2d_model_start_expression(
        m: *mut l2d_model,
        name: *const c_char,
        priority: c_int,
    ) -> i64;
    pub fn l2d_model_is_finished(m: *mut l2d_model, handle: i64) -> c_int;
    pub fn l2d_model_set_parameter(
        m: *mut l2d_model,
        id: *const c_char,
        value: c_float,
        weight: c_float,
    );
    pub fn l2d_model_get_parameter(m: *mut l2d_model, id: *const c_char) -> c_float;
    pub fn l2d_model_reset_all_parameters(m: *mut l2d_model);
    pub fn l2d_model_update(m: *mut l2d_model, delta_time_seconds: c_float);
    pub fn l2d_model_canvas_width(m: *mut l2d_model) -> c_float;
    pub fn l2d_model_canvas_height(m: *mut l2d_model) -> c_float;
    pub fn l2d_model_parameter_index(m: *mut l2d_model, id: *const c_char) -> c_int;
    pub fn l2d_model_drawable_count(m: *mut l2d_model) -> c_int;
    pub fn l2d_model_drawable_index(m: *mut l2d_model, id: *const c_char) -> c_int;
    pub fn l2d_model_drawable_vertex_count(m: *mut l2d_model, index: c_int) -> c_int;
    pub fn l2d_model_drawable_positions(m: *mut l2d_model, index: c_int) -> *const c_float;
    pub fn l2d_model_drawable_uvs(m: *mut l2d_model, index: c_int) -> *const c_float;
    pub fn l2d_model_drawable_indices(m: *mut l2d_model, index: c_int) -> *const c_ushort;
    pub fn l2d_model_drawable_index_count(m: *mut l2d_model, index: c_int) -> c_int;
    pub fn l2d_model_drawable_opacity(m: *mut l2d_model, index: c_int) -> c_float;
    pub fn l2d_model_drawable_culling(m: *mut l2d_model, index: c_int) -> c_int;
    pub fn l2d_model_drawable_texture_index(m: *mut l2d_model, index: c_int) -> c_int;
    pub fn l2d_model_drawable_visible(m: *mut l2d_model, index: c_int) -> c_int;
    pub fn l2d_model_drawable_render_order(m: *mut l2d_model, index: c_int) -> c_int;
    pub fn l2d_model_drawable_color_blend(m: *mut l2d_model, index: c_int) -> c_int;
    pub fn l2d_model_drawable_alpha_blend(m: *mut l2d_model, index: c_int) -> c_int;
    pub fn l2d_model_drawable_multiply_color(m: *mut l2d_model, index: c_int, rgba: *mut c_float);
    pub fn l2d_model_drawable_screen_color(m: *mut l2d_model, index: c_int, rgba: *mut c_float);
    pub fn l2d_model_drawable_mask_count(m: *mut l2d_model, index: c_int) -> c_int;
    pub fn l2d_model_drawable_masks(m: *mut l2d_model, index: c_int) -> *const c_int;
    pub fn l2d_model_drawable_inverted_mask(m: *mut l2d_model, index: c_int) -> c_int;
    pub fn l2d_model_hit_test(
        m: *mut l2d_model,
        hit_area_id: *const c_char,
        canvas_x: c_float,
        canvas_y: c_float,
    ) -> c_int;
}

/// C string helper: NUL-terminated copy kept alive for the call duration.
pub struct CStringGuard {
    bytes: Vec<u8>,
}

impl CStringGuard {
    pub fn new(s: &str) -> Self {
        let mut bytes = Vec::with_capacity(s.len() + 1);
        bytes.extend_from_slice(s.as_bytes());
        bytes.push(0);
        Self { bytes }
    }

    pub fn as_ptr(&self) -> *const c_char {
        self.bytes.as_ptr() as *const c_char
    }
}
