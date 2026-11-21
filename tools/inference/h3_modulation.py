"""Indexed BF16 AdaLN for the pinned H3 denoiser, with its original RMSNorm."""
from functools import wraps
import weakref

import torch

try:
    import triton
    import triton.language as tl
    from triton.errors import TritonError
except (ImportError, OSError):
    triton = None


if triton is not None:
    @triton.jit
    def _round_bf16(value):
        # Keep eager's FP32 opmath followed by explicit BF16 round-to-nearest,
        # including at the boundary between a multiplication and an addition.
        return tl.inline_asm_elementwise("cvt.rn.bf16.f32 $0, $1;", "=h,f", [value],
                                         dtype=tl.bfloat16, is_pure=True, pack=1)

    @triton.jit
    def _indexed(X, Table, Extra, Ids, Y, length, table_rows, table_stride, extra_stride,
                 WIDTH: tl.constexpr, TILE: tl.constexpr, GATED: tl.constexpr):
        row = tl.program_id(0).to(tl.int64)
        col = tl.program_id(1) * TILE + tl.arange(0, TILE)
        offset = row * WIDTH + col
        active = col < WIDTH
        group = tl.load(Ids + row % length)
        valid = active & (group >= 0) & (group < table_rows)
        x = tl.load(X + offset, active, 0).to(tl.float32)
        factor = tl.load(Table + group * table_stride + col, valid, 0).to(tl.float32)
        if GATED:
            addend = tl.load(Extra + offset, active, 0).to(tl.float32)
        else:
            # Eager rounds 1 + scale before multiplication.
            factor = _round_bf16(1.0 + factor).to(tl.float32)
            addend = tl.load(Extra + group * extra_stride + col, valid, 0).to(tl.float32)
        # Eager also rounds the product before the final BF16 addition.
        product = _round_bf16(x * factor).to(tl.float32)
        tl.store(Y + offset, _round_bf16(product + addend), active)


class _State:
    def __init__(self):
        self.disabled = "triton-unavailable" if triton is None else None
        self.bound = 0
        self.begin()

    def begin(self):
        self.ids = None
        self.bounds = None
        self.stats = dict(kernel=None, boundBlocks=self.bound, scaleShiftCalls=0, gatedResidualCalls=0, eagerCalls=0)
        if self.disabled:
            self.stats["lastFallbackReason"] = self.disabled
        return self.stats

    def available(self, x, table, extra, ids, gated):
        if self.disabled:
            return self.disabled
        if not x.is_cuda or torch.version.hip:
            return "unsupported-execution"
        if (x.ndim != 3 or not x.numel() or not x.is_contiguous() or x.dtype != torch.bfloat16
                or table.ndim != 2 or table.size(1) != x.size(-1) or table.stride(1) != 1
                or ids.shape != (x.size(1),) or not ids.is_contiguous() or ids.dtype != torch.long
                or table.dtype != x.dtype or extra.dtype != x.dtype
                or table.device != x.device or extra.device != x.device or ids.device != x.device):
            return "unsupported-layout"
        if gated:
            if extra.shape != x.shape or not extra.is_contiguous():
                return "unsupported-layout"
        elif extra.shape != table.shape or extra.stride(1) != 1:
            return "unsupported-layout"
        # One shared index tensor is produced for all fifty blocks in a pass.
        # Check it once, leaving the pinned pipeline's invalid-index error to eager.
        if self.ids is None or self.ids() is not ids:
            self.bounds = torch.stack(torch.aminmax(ids)).tolist()
            self.ids = weakref.ref(ids)
        if self.bounds[0] < 0 or self.bounds[1] >= table.size(0):
            return "invalid-row"
        return None

    def apply(self, x, table, extra, ids, *, gated):
        reason = self.available(x, table, extra, ids, gated)
        if reason is None:
            result = torch.empty_like(x)
            width, tile = x.size(-1), 1024
            grid = (x.size(0) * x.size(1), triton.cdiv(width, tile))
            try:
                with torch.cuda.device(x.device):
                    _indexed[grid](x, table, extra, ids, result, x.size(1), table.size(0),
                                   table.stride(0), extra.stride(0), width, tile, gated,
                                   num_warps=4, enable_fp_fusion=False)
            except (TritonError, ImportError, OSError) as exc:
                self.disabled = reason = type(exc).__name__
                del result
            except RuntimeError as exc:
                # Missing toolchains/images can fall back before completing this
                # operation. A device fault or exhausted allocator must propagate.
                if not any(s in str(exc).lower() for s in (
                    "no kernel image", "no active drivers", "cannot find a working triton",
                    "failed to find c compiler", "could not find module",
                )):
                    raise
                self.disabled = reason = "triton-unavailable"
                del result
            else:
                self.stats["kernel"] = "triton-cuda-bf16"
                self.stats["gatedResidualCalls" if gated else "scaleShiftCalls"] += 1
                return result
        self.stats["eagerCalls"] += 1
        self.stats["lastFallbackReason"] = reason
        if gated:
            return extra + table.index_select(0, ids) * x
        return x * (1.0 + table.index_select(0, ids)) + extra.index_select(0, ids)


def bind(block, state):
    """Install before offload hooks, leaving child modules and their calls intact."""
    original = block.forward
    if (type(block).__name__ != "MiniMaxH3TransformerBlock"
            or getattr(original, "__func__", None) is not type(block).forward):
        return False

    @wraps(original)
    def forward(hidden_states, temb, adaln_indices, rotary_emb, attention_mask=None):
        if block.training or torch.is_grad_enabled() or torch.compiler.is_compiling():
            return original(hidden_states, temb, adaln_indices, rotary_emb, attention_mask)
        shift_a, scale_a, gate_a, shift_f, scale_f, gate_f = block.adaln_proj(temb)
        normalized = state.apply(block.norm1(hidden_states), scale_a, shift_a, adaln_indices, gated=False)
        attention = block.attn(normalized, rotary_emb, attention_mask)
        del normalized
        hidden_states = state.apply(attention, gate_a, hidden_states, adaln_indices, gated=True)
        del attention
        normalized = state.apply(block.norm2(hidden_states), scale_f, shift_f, adaln_indices, gated=False)
        feed_forward = block.ff(normalized)
        del normalized
        return state.apply(feed_forward, gate_f, hidden_states, adaln_indices, gated=True)

    block.forward = forward
    return True


def install(transformer):
    if hasattr(transformer, "_huiyu_h3_modulation") or type(transformer).__name__ != "MiniMaxH3Transformer3DModel":
        return
    state = _State()
    state.bound = sum(bind(block, state) for block in transformer.transformer_blocks)
    state.stats["boundBlocks"] = state.bound
    transformer._huiyu_h3_modulation = state


def begin(transformer):
    """Request-scoped counters; attach the returned live dictionary before sampling."""
    state = getattr(transformer, "_huiyu_h3_modulation", None)
    return state.begin() if state is not None else None
