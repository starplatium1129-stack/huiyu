// Anima / gfx1150, 128-wide BF16 heads. Q/K and outputs use contiguous
// [batch, sequence, heads, 128] storage. Cosine and sine are FP32 [sequence, 128].
// Launch 128 threads per block, four 32-lane waves. Grid Y selects Q or K.
// Device-only build with ROCm clang++ (no host C++ runtime is needed):
// clang++ -x hip --offload-device-only -nogpuinc -nogpulib --offload-arch=gfx1150
//         -O3 -ffp-contract=off fused_qk_rope.hip -o fused_qk_rope.hsaco
// clang-offload-bundler -unbundle -type=o -targets=hipv4-amdgcn-amd-amdhsa--gfx1150
//         -input=fused_qk_rope.hsaco -output=anima_qk_gfx1150.co

extern "C" __attribute__((global, amdgpu_flat_work_group_size(128, 128))) void anima_qk_rms_rope(
    const __bf16* query, const __bf16* key,
    const __bf16* query_weight, const __bf16* key_weight,
    const float* cosine, const float* sine,
    __bf16* query_out, __bf16* key_out,
    int rows, int sequence, int heads, float query_eps, float key_eps) {
    const int thread = __builtin_amdgcn_workitem_id_x();
    const int row = __builtin_amdgcn_workgroup_id_x() * 4 + thread / 32;
    if (row >= rows) return;

    const int lane = thread % 32;
    const bool for_key = __builtin_amdgcn_workgroup_id_y() != 0;
    const auto* input = (for_key ? key : query) + static_cast<long long>(row) * 128;
    const auto* weight = for_key ? key_weight : query_weight;
    auto* output = (for_key ? key_out : query_out) + static_cast<long long>(row) * 128;
    const int position = (row / heads) % sequence;
    const int angle_offset = position * 128;

    float values[4];
    float squares = 0.0f;
    #pragma unroll
    for (int part = 0; part < 4; ++part) {
        values[part] = static_cast<float>(input[lane + part * 32]);
        squares += values[part] * values[part];
    }
    for (int distance = 16; distance > 0; distance /= 2) {
        const int neighbor_bits = __builtin_amdgcn_ds_bpermute((lane ^ distance) * 4,
                                                                __builtin_bit_cast(int, squares));
        squares += __builtin_bit_cast(float, neighbor_bits);
    }
    const float inverse_rms = __builtin_amdgcn_rsqf(squares * (1.0f / 128.0f) + (for_key ? key_eps : query_eps));

    // Diffusers rounds to BF16 before multiplying by the learned RMS weight,
    // then rounds again before the FP32 rotation.
    #pragma unroll
    for (int part = 0; part < 4; ++part) {
        const int col = lane + part * 32;
        const __bf16 normalized = static_cast<__bf16>(values[part] * inverse_rms);
        const __bf16 weighted = static_cast<__bf16>(static_cast<float>(normalized) * static_cast<float>(weight[col]));
        values[part] = static_cast<float>(weighted);
    }
    #pragma unroll
    for (int part = 0; part < 4; ++part) {
        const int col = lane + part * 32;
        const float rotated = part < 2 ? -values[part + 2] : values[part - 2];
        const float result = values[part] * cosine[angle_offset + col] + rotated * sine[angle_offset + col];
        output[col] = static_cast<__bf16>(result);
    }
}
