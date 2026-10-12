"""Fixed local Remacri RRDB 4x, adapted from Apache-2.0 BasicSR.

Copyright 2018-2022 BasicSR Authors. See REMACRI_LICENSE.txt for the full
license, pinned source and modifications. No ComfyUI/KJ code is included.
Only the checked 23-block, nf64/gc32 RGB model is accepted; no pickle, model
discovery, download, guessed configuration or package installation occurs.
"""
from pathlib import Path

WEIGHT_NAME = "4x_foolhardy_Remacri.safetensors"


def _network():
    """Exact scale-4 subset of BasicSR rrdbnet_arch.py; caller supplies weights."""
    import torch
    from torch import nn
    from torch.nn import functional as functional

    class DenseBlock(nn.Module):
        def __init__(self):
            super().__init__()
            for index in range(1, 6):
                setattr(self, f"conv{index}", nn.Conv2d(64 + (index - 1) * 32, 32 if index < 5 else 64, 3, 1, 1))
            self.activation = nn.LeakyReLU(.2, inplace=True)

        def forward(self, value):
            features = [value]
            for index in range(1, 5):
                features.append(self.activation(getattr(self, f"conv{index}")(torch.cat(features, dim=1))))
            return value + self.conv5(torch.cat(features, dim=1)) * .2

    class ResidualBlock(nn.Module):
        def __init__(self):
            super().__init__()
            self.rdb1, self.rdb2, self.rdb3 = DenseBlock(), DenseBlock(), DenseBlock()

        def forward(self, value):
            return value + self.rdb3(self.rdb2(self.rdb1(value))) * .2

    class Remacri(nn.Module):
        def __init__(self):
            super().__init__()
            self.conv_first = nn.Conv2d(3, 64, 3, 1, 1)
            self.body = nn.Sequential(*(ResidualBlock() for _ in range(23)))
            self.conv_body = nn.Conv2d(64, 64, 3, 1, 1)
            self.conv_up1 = nn.Conv2d(64, 64, 3, 1, 1)
            self.conv_up2 = nn.Conv2d(64, 64, 3, 1, 1)
            self.conv_hr = nn.Conv2d(64, 64, 3, 1, 1)
            self.conv_last = nn.Conv2d(64, 3, 3, 1, 1)
            self.activation = nn.LeakyReLU(.2, inplace=True)

        def forward(self, image):
            feature = self.conv_first(image)
            feature = feature + self.conv_body(self.body(feature))
            feature = self.activation(self.conv_up1(functional.interpolate(feature, scale_factor=2, mode="nearest")))
            feature = self.activation(self.conv_up2(functional.interpolate(feature, scale_factor=2, mode="nearest")))
            return self.conv_last(self.activation(self.conv_hr(feature)))

    return Remacri()


def _key_mapping():
    modules = {"model.0": "conv_first", "model.1.sub.23": "conv_body",
               "model.3": "conv_up1", "model.6": "conv_up2", "model.8": "conv_hr", "model.10": "conv_last"}
    for block in range(23):
        for dense in range(1, 4):
            for conv in range(1, 6):
                modules[f"model.1.sub.{block}.RDB{dense}.conv{conv}.0"] = f"body.{block}.rdb{dense}.conv{conv}"
    return {f"{source}.{part}": f"{target}.{part}" for source, target in modules.items() for part in ("weight", "bias")}


def load_remacri(path, device="cpu"):
    """Load only the host-selected fixed local filename, strictly as FP32."""
    import torch
    from safetensors import safe_open

    path = Path(path)
    if not path.is_absolute() or path.name != WEIGHT_NAME or not path.is_file():
        raise ValueError(f"Remacri requires an existing absolute local {WEIGHT_NAME}")
    device = torch.device(device)
    if device.type not in ("cpu", "cuda"):
        raise ValueError("Remacri supports only CPU or CUDA")
    with torch.device("meta"):
        model = _network()
    expected, mapping = model.state_dict(), _key_mapping()
    with safe_open(str(path), framework="pt", device="cpu") as source:
        keys = set(source.keys())
        if keys != set(mapping):
            missing, extra = sorted(set(mapping) - keys), sorted(keys - set(mapping))
            raise ValueError(f"Unsupported Remacri keys; missing={missing[:3]}, unexpected={extra[:3]}")
        # Validate the complete header before reading any tensor payload.
        for original, target in mapping.items():
            value = source.get_slice(original)
            if value.get_dtype() != "F32" or tuple(value.get_shape()) != tuple(expected[target].shape):
                raise ValueError(f"Remacri requires the exact FP32 tensor shape: {original}")
        state = {}
        for original, target in mapping.items():
            value = source.get_tensor(original)
            if not bool(torch.isfinite(value).all()):
                raise ValueError(f"Nonfinite Remacri weights: {original}")
            state[target] = value
    model.load_state_dict(state, strict=True, assign=True)
    return model.eval().requires_grad_(False).to(device=device, dtype=torch.float32)


def upscale_4x(model, images, *, tile_size=512, overlap=32, tiling=None, report=None):
    """FP32 RRDB tiles with CPU feather assembly; CUDA OOM retries 256/128."""
    import torch
    if (not isinstance(images, torch.Tensor) or images.ndim != 4 or images.shape[1] != 3
            or any(size <= 0 for size in images.shape)
            or images.dtype not in (torch.float16, torch.bfloat16, torch.float32)
            or images.device.type not in ("cpu", "cuda")):
        raise ValueError("Remacri requires a nonempty CPU/CUDA floating RGB [N,3,H,W] tensor")
    if tile_size not in (128, 256, 512) or overlap != 32 or tiling is None:
        raise ValueError("Remacri requires 512/256/128 tiles, overlap 32 and the bundled tiling helper")
    parameter = next(model.parameters())
    if parameter.dtype != torch.float32 or parameter.device.type not in ("cpu", "cuda"):
        raise ValueError("Remacri model must be FP32 on CPU/CUDA")
    report = {} if report is None else report
    with torch.no_grad(), torch.autocast(device_type=parameter.device.type, enabled=False):
        while True:
            try:
                output = tiling.stitch(images, lambda patch: model(patch.to(device=parameter.device, dtype=torch.float32)),
                    tile=tile_size, overlap=overlap, scale=4, channels=3, report=report)
                return output.clamp_(0, 1)
            except torch.cuda.OutOfMemoryError:
                if parameter.device.type != "cuda" or tile_size <= 128:
                    raise
            # Leave the exception scope before releasing the allocator: the
            # failed stitch's traceback must not retain tile activations.
            torch.cuda.empty_cache()
            tile_size //= 2
