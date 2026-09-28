// Live2D drawable shaders — port of the official Cubism GLES2 renderer
// semantics: premultiplied alpha output, mask channel sampling, multiply and
// screen colors, per-drawable opacity.

struct Uniforms {
    transform: vec4<f32>,     // [sx, sy, tx, ty] canvas -> clip
    multiply_color: vec4<f32>,
    screen_color: vec4<f32>,
    misc: vec4<f32>,          // x = opacity, y = has_mask, z = inverted_mask, w = unused
};

@group(0) @binding(0) var color_tex: texture_2d<f32>;
@group(0) @binding(1) var color_sampler: sampler;
@group(1) @binding(0) var mask_tex: texture_2d<f32>;
@group(1) @binding(1) var mask_sampler: sampler;
@group(2) @binding(0) var<uniform> u: Uniforms;

struct VsOut {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) mask_uv: vec2<f32>,
};

@vertex
fn vs_main(@location(0) pos: vec2<f32>, @location(1) uv: vec2<f32>) -> VsOut {
    var out: VsOut;
    out.position = vec4<f32>(
        pos.x * u.transform.x + u.transform.z,
        pos.y * u.transform.y + u.transform.w,
        0.0,
        1.0,
    );
    out.uv = uv;
    // Mask textures are rendered in the same viewport as the main pass, so a
    // drawable samples the mask channel with its own clip-space position
    // normalized to 0..1 (the official renderer's v_maskUv). Texture V runs
    // downward while clip Y runs upward, so the V axis is inverted here.
    out.mask_uv = vec2<f32>(out.position.x * 0.5 + 0.5, 0.5 - out.position.y * 0.5);
    return out;
}

// The asset loader supplies straight-alpha PNG/WebP bytes. Convert them to
// premultiplied output here because the pipelines use premultiplied blending.
fn shade_standard(in: VsOut, masked: bool) -> vec4<f32> {
    let tex = textureSample(color_tex, color_sampler, in.uv);
    let opacity = u.misc.x;
    let multiply = u.multiply_color;
    var mask_a = 1.0;
    if (masked) {
        mask_a = textureSample(mask_tex, mask_sampler, in.mask_uv).r;
        if (u.misc.z > 0.5) {
            mask_a = 1.0 - mask_a;
        }
    }
    let multiplied = tex.rgb * multiply.rgb;
    let screened = multiplied + u.screen_color.rgb - multiplied * u.screen_color.rgb;
    let a = tex.a * opacity * multiply.a * mask_a;
    let rgb = screened * a;
    return vec4<f32>(rgb, a);
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4<f32> {
    return shade_standard(in, false);
}

@fragment
fn fs_masked(in: VsOut) -> @location(0) vec4<f32> {
    return shade_standard(in, true);
}

@fragment
fn fs_multiply(in: VsOut) -> @location(0) vec4<f32> {
    return shade_standard(in, false);
}

@fragment
fn fs_multiply_masked(in: VsOut) -> @location(0) vec4<f32> {
    return shade_standard(in, true);
}

// Mask channel render: coverage from texture alpha. The official renderer
// ignores the drawable's opacity while generating mask channels
// (opacity only applies to the main pass), so mask sources with opacity 0
// still contribute their shape.
@fragment
fn fs_mask(in: VsOut) -> @location(0) vec4<f32> {
    let tex = textureSample(color_tex, color_sampler, in.uv);
    let a = tex.a;
    // R8 stores coverage in red; One / OneMinusSrc computes a + dst * (1-a).
    return vec4<f32>(a, a, a, a);
}

// Fullscreen blit for 2x supersampled rendering: sample the offscreen
// supersample texture with linear filtering and write the downscaled frame
// into the swapchain surface. The 2x downsample acts as SSAA (clean edges)
// and keeps texture detail crisp at non-integer display scales, matching the
// browser wl-live2d path (pixi resolution: 2).
@vertex
fn vs_blit(@builtin(vertex_index) vi: u32) -> VsOut {
    var pos = vec2<f32>(0.0, 0.0);
    if (vi == 0u) {
        pos = vec2<f32>(-1.0, -1.0);
    } else if (vi == 1u) {
        pos = vec2<f32>(3.0, -1.0);
    } else {
        pos = vec2<f32>(-1.0, 3.0);
    }
    var out: VsOut;
    out.position = vec4<f32>(pos, 0.0, 1.0);
    out.uv = vec2<f32>(pos.x * 0.5 + 0.5, 0.5 - pos.y * 0.5);
    out.mask_uv = vec2<f32>(0.0, 0.0);
    return out;
}

@fragment
fn fs_blit(in: VsOut) -> @location(0) vec4<f32> {
    return textureSample(color_tex, color_sampler, in.uv);
}
