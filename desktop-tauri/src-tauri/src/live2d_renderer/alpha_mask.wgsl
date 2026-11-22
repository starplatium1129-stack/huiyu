@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> alpha: array<u32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
    let extent = textureDimensions(source);
    let words_per_row = (extent.x + 31u) / 32u;
    if (invocation.x >= words_per_row || invocation.y >= extent.y) { return; }

    let start_x = invocation.x * 32u;
    let count = min(32u, extent.x - start_x);
    var word = 0u;
    for (var bit = 0u; bit < count; bit++) {
        let point = vec2<i32>(i32(start_x + bit), i32(invocation.y));
        if (textureLoad(source, point, 0).a > 8.0 / 255.0) {
            word |= 1u << bit;
        }
    }
    alpha[invocation.y * words_per_row + invocation.x] = word;
}
