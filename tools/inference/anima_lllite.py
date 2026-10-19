"""Fixed Anima Base Sketch LLLite v2; task-owned weights and removable pre-hooks.

Architecture/math adapted from InvokeAI v6.14.2 control_net_lllite.py,
AnimaControlNetLLLite / LLLiteModuleDiT / _Conditioning1 (Apache-2.0),
originally kohya-ss/sd-scripts. https://github.com/invoke-ai/InvokeAI/blob/v6.14.2/invokeai/backend/anima/control_net_lllite.py
Copyright kohya-ss and InvokeAI contributors. Apache License 2.0:
https://www.apache.org/licenses/LICENSE-2.0 ; distributed AS IS, without warranties.
Changes: exact official Sketch checkpoint, 28 Q-only targets, outer module
pre-hooks retain PEFT and Diffusers offload forwards; no class/global patching.
Weight license is separately specified by kohya-ss/Anima-LLLite.
"""
import math
from pathlib import Path

import torch
from torch import nn
from torch.nn import functional as F

FILE = "anima-lllite-any-test-like-v2.safetensors"
BYTES = 16_403_008
SHA256 = "8863424f04a2445815a827b22cbda557a085d2752e05fab54a2b303821a9e3b2"


class Residual(nn.Module):
    def __init__(self):
        super().__init__()
        self.norm1, self.norm2 = nn.GroupNorm(8, 64), nn.GroupNorm(8, 64)
        self.conv1, self.conv2 = nn.Conv2d(64, 64, 3, padding=1), nn.Conv2d(64, 64, 3, padding=1)

    def forward(self, x):
        return x + self.conv2(F.silu(self.norm2(self.conv1(F.silu(self.norm1(x))))))


class Conditioning(nn.Module):
    def __init__(self):
        super().__init__()
        self.conv1, self.norm1 = nn.Conv2d(3, 32, 4, stride=4), nn.GroupNorm(8, 32)
        self.conv2, self.norm2 = nn.Conv2d(32, 32, 3, padding=1), nn.GroupNorm(8, 32)
        self.conv3, self.norm3 = nn.Conv2d(32, 64, 4, stride=4), nn.GroupNorm(8, 64)
        self.resblocks = nn.ModuleList([Residual() for _ in range(6)])
        self.proj, self.out_norm = nn.Conv2d(64, 32, 1), nn.LayerNorm(32)

    def forward(self, x):
        x = F.silu(self.norm3(self.conv3(F.silu(self.norm2(self.conv2(F.silu(self.norm1(self.conv1(x)))))))))
        for block in self.resblocks:
            x = block(x)
        return self.out_norm(self.proj(x).flatten(2).transpose(1, 2).contiguous())


class QueryDelta(nn.Module):
    def __init__(self):
        super().__init__()
        self.down, self.mid = nn.Linear(2048, 64), nn.Linear(96, 64)
        self.cond_to_film, self.up = nn.Linear(32, 128), nn.Linear(64, 2048)
        self.depth_embed = nn.Parameter(torch.zeros(32))

    def forward(self, x, cond):
        if x.ndim != 3 or x.shape[1] != cond.shape[1] or x.shape[2] != 2048:
            raise ValueError("Sketch query tokens do not match the conditioning image")
        if x.shape[0] != cond.shape[0]:
            if x.shape[0] % cond.shape[0]:
                raise ValueError("Sketch conditioning batch does not match the image batch")
            cond = cond.repeat(x.shape[0] // cond.shape[0], 1, 1)
        local = cond.to(device=x.device, dtype=self.down.weight.dtype) + self.depth_embed
        gamma, beta = self.cond_to_film(local).chunk(2, dim=-1)
        h = self.mid(torch.cat([local, F.silu(self.down(x.to(self.down.weight.dtype)))], dim=-1))
        return self.up(F.silu(h * (1 + gamma) + beta)).to(x.dtype)


class Sketch(nn.Module):
    def __init__(self):
        super().__init__()
        self.conditioning1 = Conditioning()
        self.queries = nn.ModuleList([QueryDelta() for _ in range(28)])
        self.handles, self.cond = [], None
        self.multiplier = 0.0

    def bind(self, transformer):
        if len(transformer.transformer_blocks) != 28:
            raise ValueError("The official Sketch adapter requires a 28-layer Anima Base architecture")
        try:
            for index, block in enumerate(transformer.transformer_blocks):
                target = block.attn1.to_q
                base = target.get_base_layer() if hasattr(target, "get_base_layer") else target
                if not isinstance(base, nn.Linear) or (base.in_features, base.out_features) != (2048, 2048):
                    raise ValueError("Sketch requires the ordinary 2048-channel Anima Q projection")
                def before(module, args, index=index):
                    if not self.multiplier:
                        return None
                    if self.cond is None or not args:
                        raise ValueError("Sketch image conditioning has not been prepared")
                    x = args[0]
                    return (x + self.queries[index](x, self.cond) * self.multiplier, *args[1:])
                self.handles.append(target.register_forward_pre_hook(before))
        except BaseException:
            self.close()
            raise

    def prepare(self, image, latent_shape, dtype, device):
        latent_h, latent_w = latent_shape[-2:]
        size = (math.ceil(latent_h / 2) * 16, math.ceil(latent_w / 2) * 16)
        rgb = torch.frombuffer(bytearray(image.tobytes()), dtype=torch.uint8)
        rgb = rgb.view(image.height, image.width, 3).permute(2, 0, 1).unsqueeze(0).float() / 255
        if rgb.shape[-2:] != size:
            rgb = F.interpolate(rgb, size=size, mode="bicubic", align_corners=False).clamp_(0, 1)
        self.cond = self.conditioning1((rgb * 2 - 1).to(device=device, dtype=dtype))

    def close(self):
        for handle in reversed(self.handles):
            handle.remove()
        self.handles.clear()
        self.cond = None
        self.multiplier = 0.0


def load(path, tools, lease, check):
    from safetensors import safe_open
    path = Path(path)
    if path.name != FILE or path.stat().st_size != BYTES:
        raise ValueError("Expected the official 16,403,008-byte Anima LLLite Sketch v2 checkpoint")
    check()
    digest = lease.acquire(path, tools("native_hash").file_sha256)
    if digest != SHA256:
        raise ValueError("Sketch checkpoint SHA256 does not match the fixed official model")
    model = Sketch()
    expected = {}
    for name, tensor in model.state_dict().items():
        if name.startswith("conditioning1."):
            saved = "lllite_conditioning1." + name.removeprefix("conditioning1.")
        else:
            index, tail = name.removeprefix("queries.").split(".", 1)
            saved = f"lllite_dit_blocks_{index}_self_attn_q_proj.{tail}"
        expected[saved] = (name, tuple(tensor.shape))
    values = {}
    with safe_open(str(path), framework="pt", device="cpu") as source:
        if set(source.keys()) != set(expected):
            raise ValueError("Sketch must contain exactly the fixed 3-channel, 28-layer Q-only v2 tensors")
        for saved, (target, shape) in expected.items():
            if tuple(source.get_slice(saved).get_shape()) != shape:
                raise ValueError(f"Unsupported Sketch tensor shape: {saved}")
            values[target] = source.get_tensor(saved)
    model.load_state_dict(values, strict=True)
    if lease.cached:
        if not lease.valid():
            raise ValueError("Sketch identity protection changed during loading")
    elif tools("native_hash").file_sha256(path) != digest:
        raise ValueError("Sketch checkpoint changed during loading")
    check()
    return model.eval().requires_grad_(False)
