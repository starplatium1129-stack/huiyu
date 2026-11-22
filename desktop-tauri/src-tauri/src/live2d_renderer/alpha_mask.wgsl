@group(0) @binding(0) var source: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> alpha: array<u32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) invocation: vec3<u32>) {
    let extent = textureDimensions(source);
    let mask = (extent + vec2<u32>(3u)) / 4u;
    let first = invocation.x * 4u;
    if (first >= mask.x * mask.y) { return; }

    var word = 0u;
    for (var channel = 0u; channel < 4u; channel++) {
        let index = first + channel;
        if (index >= mask.x * mask.y) { break; }
        let origin = vec2<u32>(index % mask.x, index / mask.x) * 4u;
        let end = min(origin + vec2<u32>(4u), extent);
        var maximum = 0.0;
        for (var y = origin.y; y < end.y; y++) {
            for (var x = origin.x; x < end.x; x++) {
                maximum = max(maximum, textureLoad(source, vec2<i32>(i32(x), i32(y)), 0).a);
            }
        }
        word |= u32(round(maximum * 255.0)) << (channel * 8u);
    }
    alpha[invocation.x] = word;
}
