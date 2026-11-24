"""Direct pixel output of the released two-step pi-H3 INT8 ConvRot adapter.

Architecture and RGB codec references (Apache-2.0, Hansheng Chen):
Lakonik/ComfyUI-piFlow@4355cc4, Lakonik/LakonLab@2ee2b33.
The native worker streams the eight Sol pixel-refiner layers independently of
the denoiser, using PyTorch SDPA over the actual (un-padded) shifted windows.
"""
from contextlib import ExitStack, contextmanager
from math import prod

import torch
from torch.nn import functional as F

from huiyu_worker_lifecycle import load_sibling

quant = load_sibling("moss_int8")
DIM, HEADS, HEAD_DIM = 2048, 32, 64
BLOCK, WINDOW, PATCH = 5, 16, 16
EPS = 1e-5


@contextmanager
def capture(transformer, frames, height, width):
    """Retain only the second pass's generated video features, on the host."""
    chunks, tail = divmod(frames, 17)
    if tail != 5 or height % 32 or width % 32:
        raise ValueError("pi-H3 DWD requires 17n+5 frames and a 32-pixel canvas grid")
    grid = (chunks * BLOCK + 2, height // 32, width // 32)
    state = dict(head=transformer._huiyu_dwd, grid=grid, frames=frames, passes=0)
    target = None

    def begin(_module, _args, kwargs):
        nonlocal target
        state["passes"] += 1
        if state["passes"] == 2:
            # FL2VA prepends the encoded keyframe rows to video_indices.
            target = kwargs["video_indices"][-prod(grid):]
            if target.numel() != prod(grid):
                raise ValueError("pi-H3 DWD target rows disagree with the output canvas")

    def take(_module, args):
        if target is None:
            return
        hidden, temb, indices = args
        rows = indices.index_select(0, target)
        if hidden.shape[0] != 1 or not torch.all(rows == rows[0]):
            raise ValueError("pi-H3 DWD requires a single generated video at one noise level")
        state["features"] = hidden[0].index_select(0, target).detach().cpu()
        state["temb"] = temb[rows[0]].detach().cpu()

    with ExitStack() as hooks:
        hooks.callback(transformer.register_forward_pre_hook(begin, with_kwargs=True).remove)
        hooks.callback(transformer.norm_out.register_forward_pre_hook(take).remove)
        try:
            yield state
        finally:
            state.clear()


def _weights(source, prefix, shapes, quantized=()):
    tensors = {}
    for key, shape in shapes.items():
        tensors[key] = source.take(prefix + key, shape, "F16")
    for key, inputs, outputs in quantized:
        path = prefix + key
        source.quantization(path)
        tensors[key + ".weight"] = source.take(path + ".weight", (outputs, inputs), "I8")
        tensors[key + ".weight_scale"] = source.take(path + ".weight_scale", (outputs, 1), "F32")
        tensors[key + ".bias"] = source.take(path + ".bias", (outputs,), "F16")
    return tensors


class Decoder:
    """Plain file-backed CPU tensors: DiT placement never uploads the head."""
    def __init__(self, source, backend, control, eps):
        self.backend, self.eps = backend, eps
        self.mod = _weights(source, "dwd_norm_out.linear.", {"weight": (10752, 8), "bias": (10752,)})
        prefix = "dwd_pixel_refiner."
        self.outer = _weights(source, prefix, {
            "feature_expand.weight": (4 * DIM, 5376), "feature_expand.bias": (4 * DIM,),
            "first_frame_proj_out.weight": (768, DIM), "first_frame_proj_out.bias": (768,),
            "proj_out.weight": (3072, DIM), "proj_out.bias": (3072,),
            "register_tokens": (1, 4, DIM), "norm_out.weight": (DIM,), "norm_out.bias": (DIM,),
        })
        self.layers = []
        for index in range(8):
            control.check()
            self.layers.append(_weights(source, f"{prefix}blocks.{index}.",
                {key: (DIM,) for key in ("norm1.weight", "norm2.weight", "scale1", "scale2")},
                (("attn.to_qkv", DIM, 3 * DIM), ("attn.to_out", DIM, DIM),
                 ("ff.w1", DIM, 8 * DIM), ("ff.w2", 4 * DIM, DIM))))


def _on_device(tensors, device):
    return {key: tensor.to(device, dtype=torch.bfloat16 if tensor.dtype == torch.float16 else tensor.dtype)
            for key, tensor in tensors.items()}


def _linear(x, tensors, key, backend=None):
    weight, bias = tensors[key + ".weight"], tensors[key + ".bias"]
    if backend is None:
        return F.linear(x, weight, bias)
    scale = tensors[key + ".weight_scale"]
    if backend == "kitchen":
        return torch.ops.comfy_kitchen.int8_linear(x.contiguous(), weight, scale, None, 2, True, 256).add_(bias)
    return quant.torch_int8_linear(x, weight, scale).add_(bias)


def _geometry(height, width, shifted, device):
    """Spatial row groups of equal length can use the same unmasked SDPA call."""
    from diffusers.models.autoencoders.autoencoder_kl_minimax_h3 import MiniMaxH3VideoRotaryPosEmbed
    st, s = (2, WINDOW // 2) if shifted else (0, 0)
    axes = [((torch.arange(n, device=device) + shift) % period + 0.5) * (2 / period) - 1
            for n, shift, period in ((BLOCK, st, BLOCK), (height, s, WINDOW), (width, s, WINDOW))]
    coords = torch.stack(torch.meshgrid(*axes, indexing="ij"), -1).reshape(1, -1, 3)
    cos, sin = MiniMaxH3VideoRotaryPosEmbed(48).to(device)(coords)
    rope = (cos[0, :, :, :24].bfloat16(), sin[0, :, :, :24].bfloat16())
    rows = torch.arange(height * width, device=device).view(height, width)
    groups = {}
    for y in range(-s, height, WINDOW):
        for x in range(-s, width, WINDOW):
            window = rows[max(y, 0):y + WINDOW, max(x, 0):x + WINDOW].reshape(-1)
            groups.setdefault(window.numel(), []).append(window)
    return rope, [torch.stack(group) for group in groups.values()]


def _attention(q, k, v):
    # (windows, tokens, heads, channels)
    return F.scaled_dot_product_attention(q.transpose(1, 2), k.transpose(1, 2),
                                          v.transpose(1, 2)).transpose(1, 2)


def _post(x, attn, weights, backend, control):
    """Complete both residuals a few rows at a time to bound MLP workspace."""
    for start in range(0, len(x), 1024):
        control.check()
        region = x[start:start + 1024]
        update = _linear(attn[start:start + 1024].reshape(-1, DIM), weights, "attn.to_out", backend)
        region.add_(update * weights["scale1"])
        norm = F.rms_norm(region.float(), (DIM,), weights["norm2.weight"].float(), EPS).to(region.dtype)
        gate, up = _linear(norm, weights, "ff.w1", backend).chunk(2, -1)
        region.add_(_linear(F.silu(gate).mul_(up), weights, "ff.w2", backend) * weights["scale2"])


def _native_qkv(x, registers, rope, weights, backend, control):
    pixels = x.reshape(-1, DIM)
    count = len(pixels)
    rows = torch.cat([pixels, registers])
    qkv = rows.new_empty((len(rows), HEADS, 3, HEAD_DIM))
    for start in range(0, len(rows), 1024):
        control.check()
        norm = F.rms_norm(rows[start:start + 1024].float(), (DIM,), weights["norm1.weight"].float(), EPS)
        block = _linear(norm.to(x.dtype), weights, "attn.to_qkv", backend).reshape(-1, HEADS, 3, HEAD_DIM)
        end = min(start + len(block), count)
        for part in (0, 1):
            value = F.rms_norm(block[:, :, part].float(), (HEAD_DIM,), eps=EPS).to(x.dtype)
            if start < end:
                cos, sin = (r[start:end] for r in rope)
                first, second = value[:end - start, :, :48].chunk(2, -1)
                a, b = first * cos - second * sin, second * cos + first * sin
                first.copy_(a)
                second.copy_(b)
            block[:, :, part].copy_(value)
        qkv[start:start + len(block)] = block
    q, k, v = qkv.unbind(2)
    # Global queries see their own entire unshifted block, including registers.
    out = _attention(q[None, count:], k[None], v[None])[0]
    _post(registers, out, weights, backend, control)
    return qkv[:count], qkv[count:]


def _refine(x, globals_, weights, backend, geometry, shifted, control):
    t, h, w, _ = x.shape
    area = h * w
    rope, groups = geometry
    cached = {}
    for window_start in range(-2 if shifted else 0, t, BLOCK):
        start, end = max(0, window_start), min(t, window_start + BLOCK)
        token_parts, global_parts = [], []
        for b in range(start // BLOCK, (end - 1) // BLOCK + 1):
            # Each native block is projected once per layer. Shifted windows
            # straddle at most two native blocks; keep their original K/Vs.
            if b not in cached:
                cached[b] = _native_qkv(x[b * BLOCK:(b + 1) * BLOCK], globals_[b], rope, weights, backend, control)
            qkv, gqkv = cached[b]
            token_parts.append(qkv[max(0, start - b * BLOCK) * area:(end - b * BLOCK) * area])
            global_parts.append(gqkv)
        qkv = torch.cat(token_parts) if len(token_parts) == 2 else token_parts[0]
        gk, gv = torch.cat(global_parts)[:, :, 1:].unbind(2)
        output = x.new_empty(((end - start) * area, DIM))
        times = torch.arange(end - start, device=x.device) * area
        for spatial_rows in groups:
            for group in spatial_rows.split(4):
                control.check()
                ids = (group[:, None, :] + times[None, :, None]).flatten(1)
                q, k, v = qkv[ids].unbind(3)
                k = torch.cat([k, gk.expand(len(group), -1, -1, -1)], 1)
                v = torch.cat([v, gv.expand(len(group), -1, -1, -1)], 1)
                output[ids] = _attention(q, k, v).flatten(2)
        _post(x[start:end].view(-1, DIM), output, weights, backend, control)
        cached = {b: entry for b, entry in cached.items() if (b + 1) * BLOCK > end}


@torch.inference_mode()
def decode(captured, control, device):
    if captured.get("passes") != 2 or "features" not in captured:
        raise ValueError("pi-H3 DWD did not capture the final features of two denoiser passes")
    head, (t, h, w) = captured["head"], captured["grid"]
    # The compressed time-embedding curve is shared with the main denoiser.
    # The released DWD norm uses its own SiLU, scale first, and affine-free LN.
    temb = captured.pop("temb").float()
    scale, shift = F.linear(F.silu(temb), head.mod["weight"].float(), head.mod["bias"].float()).chunk(2)
    scale, shift = scale.to(device, torch.bfloat16), shift.to(device, torch.bfloat16)
    outer = _on_device(head.outer, device)
    x = torch.empty((t, 2 * h, 2 * w, DIM), device=device, dtype=torch.bfloat16)
    features = captured.pop("features").view(t, h, w, -1)
    for index, frame in enumerate(features):
        control.check()
        norm = F.layer_norm(frame.to(device), (5376,), eps=head.eps).mul_(1 + scale).add_(shift)
        expanded = _linear(norm, outer, "feature_expand").view(h, w, 2, 2, DIM)
        x[index] = expanded.permute(0, 2, 1, 3, 4).reshape(2 * h, 2 * w, DIM)
    del features, frame, norm, expanded
    registers = torch.cat([outer["register_tokens"][0], x.new_zeros((1, DIM))]).repeat((t + BLOCK - 1) // BLOCK, 1, 1)
    geometry = [_geometry(2 * h, 2 * w, shifted, device) for shifted in (False, True)]
    for index, source in enumerate(head.layers):
        control.check()
        _refine(x, registers, _on_device(source, device), head.backend, geometry[index % 2], index % 2, control)

    mean = x.new_tensor((-0.03, -0.088, -0.188), dtype=torch.float32)
    std = x.new_tensor((0.458, 0.448, 0.45), dtype=torch.float32)
    # Keep the finished clip in the encoder's RGB24 format. A 10 s high-resolution
    # clip would otherwise occupy several GB of host memory after refinement.
    pixels = torch.empty(captured["frames"], h * 32, w * 32, 3, dtype=torch.uint8, device="cpu")
    offset = 0
    for i, frame in enumerate(x):
        control.check()
        count = 4 if i % BLOCK else 1
        key = "first_frame_proj_out" if count == 1 else "proj_out"
        norm = F.layer_norm(frame, (DIM,), outer["norm_out.weight"], outer["norm_out.bias"], EPS)
        rgb = _linear(norm, outer, key).view(2 * h, 2 * w, 3, count, PATCH, PATCH)
        rgb = rgb.permute(3, 0, 4, 1, 5, 2).reshape(count, h * 32, w * 32, 3).float()
        if not torch.isfinite(rgb).all():
            raise ValueError("pi-H3 DWD produced non-finite RGB pixels")
        rgb.mul_(std).add_(mean).clamp_(-1, 1).add_(1).mul_(127.5).round_()
        pixels[offset:offset + count].copy_(rgb.to(torch.uint8))
        offset += count
    if offset != len(pixels):
        raise ValueError("pi-H3 DWD frame count does not match H3 audio/video geometry")
    return pixels.numpy()
