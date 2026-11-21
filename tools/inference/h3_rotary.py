"""Fuse only the two BF16 products and sum in Diffusers' partial H3 RoPE."""
from contextlib import contextmanager
import sys
import weakref

import torch

try:
    import triton
    import triton.language as tl
    from triton.errors import TritonError
except (ImportError, OSError):
    triton = None


if triton is not None:
    from huiyu_worker_lifecycle import load_sibling
    _round_bf16 = load_sibling("h3_modulation")._round_bf16

    @triton.jit
    def _rotate(X, Cos, Sin, Out, length, heads, vectors, xb, xs, xh, xd,
                WIDTH: tl.constexpr, ROTARY: tl.constexpr, GROUP: tl.constexpr):
        # Each vector is one head at one actual packed position (B, S, H, D).
        vec = tl.program_id(0).to(tl.int64) * GROUP + tl.arange(0, GROUP)
        col = tl.arange(0, WIDTH)
        sample = vec // (length * heads)
        pos = vec // heads % length
        head = vec % heads
        base = sample * xb + pos * xs + head * xh
        live = vec[:, None] < vectors
        rotated = col[None, :] < ROTARY
        x = tl.load(X + base[:, None] + col[None, :] * xd, live, 0)
        # Split within the ROTARY-channel prefix, never across the full head.
        partner = tl.where(col < ROTARY // 2, col + ROTARY // 2, col - ROTARY // 2)
        other = tl.load(X + base[:, None] + partner[None, :] * xd, live & rotated, 0).to(tl.float32)
        other = tl.where(col[None, :] < ROTARY // 2, -other, other)
        table = pos[:, None] * ROTARY + col[None, :]
        cosine = tl.load(Cos + table, live & rotated, 0).to(tl.float32)
        sine = tl.load(Sin + table, live & rotated, 0).to(tl.float32)
        a = _round_bf16(x.to(tl.float32) * cosine).to(tl.float32)
        b = _round_bf16(other * sine).to(tl.float32)
        result = _round_bf16(a + b)
        tl.store(Out + vec[:, None] * WIDTH + col[None, :], tl.where(rotated, result, x), live)


class _Rotary:
    def __init__(self, original):
        self.original = original
        self.disabled = None
        self.sources = None
        self.tables = None
        self.stats = dict(kernel=None, calls=0, eagerCalls=0, verifiedCalls=0, verifiedRows=0)

    def fallback(self, x, cos, sin, reason):
        self.stats["eagerCalls"] += 1
        self.stats["lastFallbackReason"] = reason
        return self.original(x, cos, sin)

    def __call__(self, x, cos, sin):
        if self.disabled:
            return self.fallback(x, cos, sin, self.disabled)
        if (not x.is_cuda or torch.version.hip or torch.is_grad_enabled() or torch.compiler.is_compiling()
                or x.ndim != 4 or not x.numel() or x.dtype != torch.bfloat16 or x.size(-1) != 128
                or cos.shape != (x.size(1), 96) or sin.shape != cos.shape
                or cos.dtype not in (torch.float32, torch.bfloat16) or sin.dtype != cos.dtype
                or cos.device != x.device or sin.device != x.device):
            return self.fallback(x, cos, sin, "unsupported-layout")
        # The pinned transformer holds these same two position tensors across
        # its fifty blocks. Use its own dtype conversion once per actual pair.
        if self.sources is None or self.sources[0]() is not cos or self.sources[1]() is not sin:
            self.tables = (cos.to(x.dtype).contiguous(), sin.to(x.dtype).contiguous())
            self.sources = (weakref.ref(cos), weakref.ref(sin))
        length, heads, width = x.shape[1:]
        vectors = x.size(0) * length * heads
        group = 8
        output = torch.empty(x.shape, device=x.device, dtype=x.dtype)
        try:
            with torch.cuda.device(x.device):
                _rotate[(triton.cdiv(vectors, group),)](x, *self.tables, output, length, heads, vectors,
                                                        *x.stride(), width, 96, group,
                                                        enable_fp_fusion=False, num_warps=4)
        except (TritonError, ImportError, OSError) as exc:
            self.disabled = type(exc).__name__
        except RuntimeError as exc:
            if not any(s in str(exc).lower() for s in (
                "no kernel image", "no active drivers", "cannot find a working triton",
                "failed to find c compiler", "could not find module",
            )):
                raise
            self.disabled = "triton-unavailable"
        if self.disabled:
            del output
            return self.fallback(x, cos, sin, self.disabled)
        if self.stats["verifiedCalls"] < 2:
            # The first Q and K use real model activations. Exercise disjoint
            # positions, every head, and the 32 unchanged channels bit-for-bit.
            positions = sorted({0, min(31, length - 1), length // 8, length // 2, length - 1})
            rows = torch.tensor(positions, device=x.device, dtype=torch.long)
            reference = self.original(x.index_select(1, rows), cos.index_select(0, rows), sin.index_select(0, rows))
            actual = output.index_select(1, rows)
            if not torch.equal(reference.view(torch.int16), actual.view(torch.int16)):
                self.disabled = "reference-mismatch"
                del output
                return self.fallback(x, cos, sin, self.disabled)
            self.stats["verifiedCalls"] += 1
            self.stats["verifiedRows"] += len(positions)
        self.stats["calls"] += 1
        self.stats["kernel"] = "triton-cuda-bf16"
        return output


@contextmanager
def rotary(transformer):
    """Limit replacement of the defining module's helper to this worker request."""
    module = sys.modules[type(transformer).__module__]
    original = getattr(module, "_apply_rotary_emb", None)
    runner = _Rotary(original)
    if (getattr(module, "MiniMaxH3Transformer3DModel", None) is not type(transformer)
            or original is None or getattr(original, "__module__", None) != module.__name__):
        runner.stats["lastFallbackReason"] = "unsupported-model"
        yield runner.stats
        return
    if triton is None:
        runner.disabled = "triton-unavailable"
    module._apply_rotary_emb = runner
    try:
        yield runner.stats
    finally:
        module._apply_rotary_emb = original
