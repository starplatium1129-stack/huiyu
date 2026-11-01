"""Cosmos inference kernels for the existing pinned Anima Triton environment.

Math/modulation follow Apache-2.0 Diffusers 0.41 transformer_cosmos.py and
normalization.py (2025 NVIDIA/HuggingFace; ANIMA_CONVERSION_LICENSE.txt).
ComfyUI b0b7435's Cosmos path motivates the fusion boundaries; no ComfyUI or
Kitchen code/runtime is imported. Keep intermediate FP16/BF16 rounding points.
torch.library.triton_op keeps the kernels visible to PyTorch 2.8 compilation.
"""
import torch
import triton
import triton.language as tl


@triton.jit
def _rms_rope(X, W, COS, SIN, Y, sequence, xb, xh, xs, xd, yb, yh, ys, yd,
              HEADS: tl.constexpr, D: tl.constexpr, EPS: tl.constexpr):
    row = tl.program_id(0)
    col = tl.arange(0, D)
    batch = row // (sequence * HEADS)
    head = row % HEADS
    position = (row // HEADS) % sequence
    x = tl.load(X + batch * xb + head * xh + position * xs + col * xd).to(tl.float32)
    inverse = tl.rsqrt(tl.sum(x * x, axis=0) / D + EPS)
    # Diffusers casts the normalized value before multiplying the norm weight.
    normalized = (x * inverse).to(Y.dtype.element_ty).to(tl.float32)
    normalized = (normalized * tl.load(W + col).to(tl.float32)).to(Y.dtype.element_ty).to(tl.float32)
    other = tl.gather(normalized, (col + D // 2) % D, 0)
    rotated = tl.where(col < D // 2, -other, other)
    cos = tl.load(COS + position * D + col).to(tl.float32)
    sin = tl.load(SIN + position * D + col).to(tl.float32)
    tl.store(Y + batch * yb + head * yh + position * ys + col * yd, normalized * cos + rotated * sin)


@triton.jit
def _adaln(X, SCALE, SHIFT, Y, sequence, xb, xs, xd, yb, ys, yd, scale_stride, scale_col, shift_stride, shift_col,
           D: tl.constexpr, BLOCK: tl.constexpr, EPS: tl.constexpr):
    row = tl.program_id(0)
    batch = row // sequence
    position = row % sequence
    col = tl.arange(0, BLOCK)
    x = tl.load(X + batch * xb + position * xs + col * xd, col < D, 0).to(tl.float32)
    mean = tl.sum(x, axis=0) / D
    centered = tl.where(col < D, x - mean, 0.)
    inverse = tl.rsqrt(tl.sum(centered * centered, axis=0) / D + EPS)
    # Preserve LayerNorm output, (1 + scale), multiply and add rounding.
    normalized = (centered * inverse).to(Y.dtype.element_ty).to(tl.float32)
    scale = tl.load(SCALE + batch * scale_stride + col * scale_col, col < D, 0).to(tl.float32)
    shift = tl.load(SHIFT + batch * shift_stride + col * shift_col, col < D, 0).to(tl.float32)
    factor = (1. + scale).to(Y.dtype.element_ty).to(tl.float32)
    product = (normalized * factor).to(Y.dtype.element_ty).to(tl.float32)
    tl.store(Y + batch * yb + position * ys + col * yd, product + shift, col < D)


# A diagnostic may reload bundled helpers in the same process. Reuse these
# versioned registrations rather than replacing a live compiler's operators.
if not hasattr(torch.ops.huiyu_anima, "rms_rope_v1"):
    @torch.library.triton_op("huiyu_anima::rms_rope_v1", mutates_args={})
    def rms_rope_op(x: torch.Tensor, weight: torch.Tensor, cos: torch.Tensor,
                    sin: torch.Tensor, eps: float) -> torch.Tensor:
        output = torch.empty_like(x)
        batch, heads, sequence, dim = x.shape
        torch.library.wrap_triton(_rms_rope)[(batch * sequence * heads,)](
            x, weight, cos, sin, output, sequence, *x.stride(), *output.stride(), heads, dim, eps,
            num_warps=4, enable_fp_fusion=False)
        return output

if not hasattr(torch.ops.huiyu_anima, "adaln_v1"):
    @torch.library.triton_op("huiyu_anima::adaln_v1", mutates_args={})
    def adaln_op(x: torch.Tensor, scale: torch.Tensor, shift: torch.Tensor, eps: float) -> torch.Tensor:
        output = torch.empty_like(x)
        batch, sequence, dim = x.shape
        torch.library.wrap_triton(_adaln)[(batch * sequence,)](
            x, scale, shift, output, sequence, *x.stride(), *output.stride(),
            scale.stride(0), scale.stride(1), shift.stride(0), shift.stride(1),
            dim, triton.next_power_of_2(dim), eps, num_warps=4, enable_fp_fusion=False)
        return output


def rms_rope(query, key, norm_q, norm_k, rope):
    from diffusers.models.normalization import RMSNorm
    if (torch.is_grad_enabled() or query.device.type != "cuda" or query.dtype not in (torch.float16, torch.bfloat16)
            or query.shape != key.shape or key.dtype != query.dtype or key.device != query.device
            or query.ndim != 4 or query.shape[-1] not in (64, 128)):
        return None
    batch, heads, sequence, dim = query.shape
    if query.stride(-1) != 1 or key.stride(-1) != 1:
        return None
    cos, sin = rope
    if any(value.shape != (sequence, dim) or not value.is_contiguous() or value.device != query.device
           or value.dtype != torch.float32 for value in (cos, sin)):
        return None
    for norm in (norm_q, norm_k):
        if (type(norm) is not RMSNorm or norm.bias is not None or norm.weight is None
                or norm.weight.shape != (dim,) or norm.weight.dtype != query.dtype
                or norm.weight.device != query.device or not norm.weight.is_contiguous()):
            return None
    return (torch.ops.huiyu_anima.rms_rope_v1(query, norm_q.weight, cos, sin, norm_q.eps),
            torch.ops.huiyu_anima.rms_rope_v1(key, norm_k.weight, cos, sin, norm_k.eps))


def bind_adaln(module):
    from diffusers.models.transformers.transformer_cosmos import CosmosAdaLayerNorm, CosmosAdaLayerNormZero
    if (type(module) not in (CosmosAdaLayerNorm, CosmosAdaLayerNormZero)
            or type(module.norm) is not torch.nn.LayerNorm or module.norm.elementwise_affine):
        return
    original = module.forward
    final = type(module) is CosmosAdaLayerNorm

    def forward(hidden_states, embedded_timestep, temb=None):
        if (torch.is_grad_enabled() or hidden_states.device.type != "cuda"
                or hidden_states.dtype not in (torch.float16, torch.bfloat16)
                or hidden_states.ndim != 3 or embedded_timestep.ndim != 2
                or not hidden_states.is_contiguous() or hidden_states.shape[-1] > 8192):
            return original(hidden_states, embedded_timestep, temb)
        embedded = module.linear_2(module.linear_1(module.activation(embedded_timestep)))
        if temb is not None:
            embedded = embedded + (temb[..., :2 * module.embedding_dim] if final else temb)
        parts = embedded.chunk(2 if final else 3, dim=-1)
        shift, scale = parts[:2]
        if shift.dtype != hidden_states.dtype or shift.shape != (hidden_states.shape[0], hidden_states.shape[-1]):
            # Keep the already evaluated modulation and the original arithmetic.
            output = module.norm(hidden_states) * (1 + scale.unsqueeze(1)) + shift.unsqueeze(1)
        else:
            output = torch.ops.huiyu_anima.adaln_v1(hidden_states, scale, shift, module.norm.eps)
        return output if final else (output, parts[2].unsqueeze(1))

    module.forward = forward
