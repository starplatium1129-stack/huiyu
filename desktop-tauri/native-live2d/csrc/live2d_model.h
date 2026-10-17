/*
 * C API for the native Live2D runtime (Cubism SDK for Native 5-r.5).
 *
 * Thin C++ glue over the official framework so Rust can drive motion playback,
 * expressions, physics, pose, eye blink and hit tests with official behavior.
 */
#ifndef LIVE2D_MODEL_C_API_H
#define LIVE2D_MODEL_C_API_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct l2d_model l2d_model;


/* Blend types as reported by Cubism Core (Live2DCubismCore.h). */
#define L2D_COLOR_BLEND_NORMAL 0

#define L2D_ALPHA_BLEND_OVER 0

/* 0 on success, nonzero on failure. */
int l2d_initialize(void);

l2d_model* l2d_model_create(const uint8_t* moc_data, size_t moc_size,
                            const uint8_t* model3_data, size_t model3_size);
void l2d_model_destroy(l2d_model* m);

/* Asset loading: call before playback. group/index mirror model3.json order. */
int l2d_model_add_motion(l2d_model* m, const char* group, int index,
                         const uint8_t* json, size_t size);
int l2d_model_add_expression(l2d_model* m, const char* name,
                             const uint8_t* json, size_t size);
int l2d_model_load_physics(l2d_model* m, const uint8_t* json, size_t size);
int l2d_model_load_pose(l2d_model* m, const uint8_t* json, size_t size);

/* Playback. Returns opaque handle (>0) or 0 when the motion could not start. */
int64_t l2d_model_start_motion(l2d_model* m, const char* group, int index, int priority);
int64_t l2d_model_start_expression(l2d_model* m, const char* name, int priority);
int l2d_model_is_finished(l2d_model* m, int64_t handle);

/* Parameters. */
void l2d_model_set_parameter(l2d_model* m, const char* id, float value, float weight);
float l2d_model_get_parameter(l2d_model* m, const char* id);
/* TEMP DIAG: reset every parameter to its moc3 default value. */
void l2d_model_reset_all_parameters(l2d_model* m);

/* Runtime control. */
void l2d_model_update(l2d_model* m, float delta_time_seconds);

/* Model info. */
float l2d_model_canvas_width(l2d_model* m);
float l2d_model_canvas_height(l2d_model* m);
int l2d_model_parameter_index(l2d_model* m, const char* id);
int l2d_model_drawable_count(l2d_model* m);
int l2d_model_drawable_index(l2d_model* m, const char* id);

/* Drawable snapshot accessors (pointers valid until the next update call). */
int l2d_model_drawable_vertex_count(l2d_model* m, int index);
const float* l2d_model_drawable_positions(l2d_model* m, int index);
const float* l2d_model_drawable_uvs(l2d_model* m, int index);
const uint16_t* l2d_model_drawable_indices(l2d_model* m, int index);
int l2d_model_drawable_index_count(l2d_model* m, int index);
float l2d_model_drawable_opacity(l2d_model* m, int index);
int l2d_model_drawable_culling(l2d_model* m, int index);
int l2d_model_drawable_texture_index(l2d_model* m, int index);
int l2d_model_drawable_visible(l2d_model* m, int index);
int l2d_model_drawable_render_order(l2d_model* m, int index);
int l2d_model_drawable_color_blend(l2d_model* m, int index);
int l2d_model_drawable_alpha_blend(l2d_model* m, int index);
void l2d_model_drawable_multiply_color(l2d_model* m, int index, float* rgba);
void l2d_model_drawable_screen_color(l2d_model* m, int index, float* rgba);
int l2d_model_drawable_mask_count(l2d_model* m, int index);
const int* l2d_model_drawable_masks(l2d_model* m, int index);
int l2d_model_drawable_inverted_mask(l2d_model* m, int index);

/* Hit test (canvas space, bbox semantics like the official CubismUserModel::IsHit). */
int l2d_model_hit_test(l2d_model* m, const char* hit_area_id, float canvas_x, float canvas_y);

#ifdef __cplusplus
}
#endif

#endif /* LIVE2D_MODEL_C_API_H */
