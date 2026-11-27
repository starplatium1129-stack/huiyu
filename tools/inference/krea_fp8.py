"""Optional CUDA kernels preserving the Krea converter's BF16 rounding."""
import subprocess

import torch
import triton
import triton.language as tl
from triton.errors import TritonError


def _missing_kernel(error):
    return isinstance(error, (TritonError, FileNotFoundError, subprocess.CalledProcessError)) or any(
        marker in str(error).lower() for marker in ("c compiler", "failed to compile", "cannot find ptxas"))


@triton.jit
def _pack(X, Y, SCALE, count, BLOCK: tl.constexpr):
    col = tl.program_id(0) * BLOCK + tl.arange(0, BLOCK)
    scale = tl.load(SCALE)
    x = tl.load(X + col, col < count, 0).to(tl.float32)
    reciprocal = tl.div_rn(1., scale.to(tl.bfloat16).to(tl.float32))
    scaled = (x * reciprocal).to(tl.bfloat16).to(tl.float32)
    clipped = tl.minimum(tl.maximum(scaled, -448.), 448.)
    tl.store(Y + col, tl.where(scaled == scaled, clipped, scaled), col < count)


@triton.jit
def _expand(W, Y, scale, count, BLOCK: tl.constexpr):
    col = tl.program_id(0) * BLOCK + tl.arange(0, BLOCK)
    w = tl.load(W + col, col < count).to(tl.float32)
    tl.store(Y + col, w * scale, col < count)


class PackedKernels:
    def __init__(self):
        self.can_pack = self.can_expand = True

    def pack(self, rows, scale):
        if not self.can_pack or not rows.is_contiguous() or rows.numel() < 65536:
            return None
        packed = torch.empty_like(rows, dtype=torch.float8_e4m3fn)
        try:
            _pack[(triton.cdiv(rows.numel(), 2048),)](rows, packed, scale, rows.numel(), 2048)
        except (TritonError, FileNotFoundError, subprocess.CalledProcessError, RuntimeError) as error:
            if not _missing_kernel(error):
                raise
            self.can_pack = False
        else:
            return packed, scale
        return None

    def expand(self, weight, scale):
        if not self.can_expand or not weight.is_cuda or not weight.is_contiguous():
            return None
        out = torch.empty_like(weight, dtype=torch.bfloat16)
        try:
            _expand[(triton.cdiv(weight.numel(), 2048),)](weight, out, scale, weight.numel(), 2048)
        except (TritonError, FileNotFoundError, subprocess.CalledProcessError, RuntimeError) as error:
            if not _missing_kernel(error):
                raise
            self.can_expand = False
        else:
            return out
        return None
