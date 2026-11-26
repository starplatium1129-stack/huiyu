@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> alpha: array<u32>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
    let source_extent = textureDimensions(source);
    let extent = (source_extent + vec2<u32>(1u)) / 2u;
    let words_per_row = (extent.x + 31u) / 32u;
    if (invocation.x >= words_per_row || invocation.y >= extent.y) { return; }

    let start_x = invocation.x * 32u;
    let count = min(32u, extent.x - start_x);
    var word = 0u;
    for (var bit = 0u; bit < count; bit++) {
        let point = vec2<u32>(start_x + bit, invocation.y) * 2u;
        let last = source_extent - vec2<u32>(1u);
        let bottom_right = min(point + vec2<u32>(1u), last);
        let threshold = 8.0 / 255.0;
        if (textureLoad(source, vec2<i32>(point), 0).a > threshold
            && textureLoad(source, vec2<i32>(i32(bottom_right.x), i32(point.y)), 0).a > threshold
            && textureLoad(source, vec2<i32>(i32(point.x), i32(bottom_right.y)), 0).a > threshold
            && textureLoad(source, vec2<i32>(bottom_right), 0).a > threshold) {
            word |= 1u << bit;
        }
    }
    alpha[invocation.y * words_per_row + invocation.x] = word;
}
