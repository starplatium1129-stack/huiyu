"""Optional eager inference kernels for MOSS SiTU and rotary embeddings."""
import subprocess

import torch
import triton
import triton.language as tl
from triton.errors import TritonError
from triton.language.extra import libdevice


def _missing_kernel(error):
    return isinstance(error, (TritonError, FileNotFoundError, subprocess.CalledProcessError)) or any(
        s in str(error).lower() for s in ("c compiler", "failed to compile", "cannot find ptxas"))


@triton.jit
def _rope_kernel(Q, K, ROPE, OQ, OK, HEADS: tl.constexpr, DIM: tl.constexpr, RSTRIDE: tl.constexpr):
    token = tl.program_id(0)
    head = tl.program_id(1)
    col = tl.arange(0, DIM)
    base = (token * HEADS + head) * DIM
    partner = base + (col ^ (DIM // 2))
    sin = tl.load(ROPE + token * RSTRIDE + col).to(tl.float32)
    cos = tl.load(ROPE + token * RSTRIDE + DIM + col).to(tl.float32)
    signed_sin = tl.where(col < DIM // 2, -sin, sin)
    dtype: tl.constexpr = OQ.dtype.element_ty
    q0 = (tl.load(Q + base + col).to(tl.float32) * cos).to(dtype).to(tl.float32)
    q1 = (tl.load(Q + partner).to(tl.float32) * signed_sin).to(dtype).to(tl.float32)
    k0 = (tl.load(K + base + col).to(tl.float32) * cos).to(dtype).to(tl.float32)
    k1 = (tl.load(K + partner).to(tl.float32) * signed_sin).to(dtype).to(tl.float32)
    tl.store(OQ + base + col, q0 + q1)
    tl.store(OK + base + col, k0 + k1)


class FusedRoPE:
    def __init__(self, eager):
        self.eager = eager
        self.enabled = True
        self.calls = 0

    def __call__(self, q, k, rope):
        if (not torch.compiler.is_compiling() and self.enabled and torch.is_inference_mode_enabled()
                and q.is_cuda and q.dtype == k.dtype == rope.dtype == torch.bfloat16
                and q.is_contiguous() and k.is_contiguous() and q.shape == k.shape and q.shape[0] == 1
                and q.shape[-1] == 128 and rope.shape == (1, q.shape[1], 1, 256) and rope.stride(-1) == 1):
            _, tokens, heads, dim = q.shape
            oq, ok = torch.empty_like(q), torch.empty_like(k)
            try:
                _rope_kernel[(tokens, heads)](q, k, rope, oq, ok, heads, dim, rope.stride(1),
                                               enable_fp_fusion=False)
            except (TritonError, FileNotFoundError, subprocess.CalledProcessError, RuntimeError) as error:
                if not _missing_kernel(error):
                    raise
                self.enabled = False
                del oq, ok
            else:
                self.calls += 1
                return oq, ok
        return self.eager(q, rope), self.eager(k, rope)


@triton.jit
def _situ_kernel(HIDDEN, GATE, OUT, WIDTH: tl.constexpr, STRIDE: tl.constexpr, BLOCK: tl.constexpr):
    row = tl.program_id(0)
    col = tl.program_id(1) * BLOCK + tl.arange(0, BLOCK)
    offset = row * STRIDE + col
    hidden = tl.load(HIDDEN + offset, mask=col < WIDTH, other=0).to(tl.float32)
    gate = tl.load(GATE + offset, mask=col < WIDTH, other=0).to(tl.float32)
    dtype: tl.constexpr = OUT.dtype.element_ty
    # Round at the same points as the separate BF16 PyTorch operations.
    g = (gate / 4.0).to(dtype).to(tl.float32)
    g = libdevice.tanh(g).to(dtype).to(tl.float32)
    g = (4.0 * g).to(dtype).to(tl.float32)
    sigmoid = tl.div_rn(1.0, 1.0 + libdevice.exp(-gate)).to(dtype).to(tl.float32)
    g = (g * sigmoid).to(dtype).to(tl.float32)
    h = (hidden / 25.0).to(dtype).to(tl.float32)
    h = libdevice.tanh(h).to(dtype).to(tl.float32)
    h = (25.0 * h).to(dtype).to(tl.float32)
    tl.store(OUT + row * WIDTH + col, g * h, mask=col < WIDTH)


class FusedSiTU:
    def __init__(self, eager):
        self.eager = eager
        self.enabled = True
        self.calls = 0

    def __call__(self, hidden, gate):
        # The compiled-block mode already fuses pointwise operations. Only the
        # eager, single-image BF16 path uses this kernel; no autograd mutation.
        if (torch.compiler.is_compiling() or not self.enabled or not torch.is_inference_mode_enabled()
                or not hidden.is_cuda or hidden.dtype != torch.bfloat16 or hidden.ndim != 3
                or hidden.shape[0] != 1 or hidden.stride(-1) != 1 or gate.stride() != hidden.stride()):
            return self.eager(hidden, gate)
        rows, width = hidden.shape[1:]
        output = torch.empty(hidden.shape, dtype=hidden.dtype, device=hidden.device)
        try:
            _situ_kernel[(rows, triton.cdiv(width, 512))](hidden, gate, output, width, hidden.stride(1), 512,
                                                          enable_fp_fusion=False)
        except (TritonError, FileNotFoundError, subprocess.CalledProcessError, RuntimeError) as exc:
            if not _missing_kernel(exc):
                raise
            self.enabled = False
        else:
            self.calls += 1
            return output
        del output
        return self.eager(hidden, gate)
