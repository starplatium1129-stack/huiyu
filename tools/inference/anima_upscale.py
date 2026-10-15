"""Fixed local Remacri RRDB 4x, adapted from Apache-2.0 BasicSR.

Copyright 2018-2022 BasicSR Authors. See REMACRI_LICENSE.txt for the full
license, pinned source and modifications. No ComfyUI/KJ code is included.
Only the checked 23-block, nf64/gc32 RGB model is accepted; no pickle, model
discovery, download, guessed configuration or package installation occurs.
"""
from pathlib import Path
import time

WEIGHT_NAME = "4x_foolhardy_Remacri.safetensors"
EXECUTION_REVISION = "remacri-no-single-cat-packed-v1"
MAX_CPU_CACHE_BYTES = 128 * 1024 * 1024


class CpuCache:
    """One validated CPU weight set; pass-local modules alone own CUDA weights."""
    def __init__(self, *, lease=None):
        self.lease = lease
        self.clear()

    def clear(self, *, keep_identity=False):
        self.identity, self.weights = None, None
        if not keep_identity and self.lease is not None:
            self.lease.close()


def _file_identity(path):
    info = path.stat()
    # Metadata detects replacement during reads; cache reuse ALSO requires SHA256.
    return (str(path.resolve(strict=True)), info.st_dev, info.st_ino, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns)


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
            # A singleton cat only copies this 64-channel feature map.
            features = [value, self.activation(self.conv1(value))]
            for index in range(2, 5):
                features.append(self.activation(getattr(self, f"conv{index}")(torch.cat(features, dim=1))))
            # The packed tensor owns its data. Release the four dense features
            # before conv5, then its input before the unchanged residual math.
            packed = torch.cat(features, dim=1)
            del features
            residual = self.conv5(packed)
            del packed
            return value + residual * .2

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
            # Release each old feature before the next convolution allocates its
            # output. Keep the exact FP32 operator order and tensor layouts.
            feature = functional.interpolate(feature, scale_factor=2, mode="nearest")
            feature = self.activation(self.conv_up1(feature))
            feature = functional.interpolate(feature, scale_factor=2, mode="nearest")
            feature = self.activation(self.conv_up2(feature))
            feature = self.activation(self.conv_hr(feature))
            return self.conv_last(feature)

    return Remacri()


def _key_mapping():
    modules = {"model.0": "conv_first", "model.1.sub.23": "conv_body",
               "model.3": "conv_up1", "model.6": "conv_up2", "model.8": "conv_hr", "model.10": "conv_last"}
    for block in range(23):
        for dense in range(1, 4):
            for conv in range(1, 6):
                modules[f"model.1.sub.{block}.RDB{dense}.conv{conv}.0"] = f"body.{block}.rdb{dense}.conv{conv}"
    return {f"{source}.{part}": f"{target}.{part}" for source, target in modules.items() for part in ("weight", "bias")}


def load_remacri(path, device="cpu", *, upload, report, cache=None, identity=None, check=None):
    """Load only the host-selected fixed local filename, strictly as FP32."""
    import torch
    from safetensors import safe_open

    started = time.perf_counter()
    path = Path(path)
    if not path.is_absolute() or path.name != WEIGHT_NAME or not path.is_file():
        raise ValueError(f"Remacri requires an existing absolute local {WEIGHT_NAME}")
    device = torch.device(device)
    if device.type not in ("cpu", "cuda"):
        raise ValueError("Remacri supports only CPU or CUDA")
    with torch.device("meta"):
        model = _network()
    hit = cache is not None and identity is not None and cache.identity == identity
    if hit:
        state = cache.weights
    else:
        if cache is not None:
            cache.clear(keep_identity=True)
        expected, mapping = model.state_dict(), _key_mapping()
        # Checkpoint tensors are strictly F32, regardless of the default meta dtype.
        weight_bytes = sum(value.numel() for value in expected.values()) * 4
        if cache is not None and weight_bytes > MAX_CPU_CACHE_BYTES:
            raise ValueError("Remacri CPU weights exceed the 128 MiB cache limit")
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
                if check is not None:
                    check()
                value = source.get_tensor(original)
                if not bool(torch.isfinite(value).all()):
                    raise ValueError(f"Nonfinite Remacri weights: {original}")
                # Cache owns bounded CPU allocations, never an open checkpoint mapping.
                state[target] = value.clone() if cache is not None else value
        if cache is not None and identity is not None:
            cache.identity, cache.weights = identity, state
    model.load_state_dict(state, strict=True, assign=True)
    model.eval().requires_grad_(False)
    report.update(readWallSeconds=time.perf_counter() - started, cacheHit=hit)
    if check is not None:
        check()
    started = time.perf_counter()
    observation = {}
    if device.type != "cuda" or not upload([model], target_device=device, observation=observation):
        model.to(device=device, dtype=torch.float32)
        observation["strategy"] = "module-to"
    report.update(uploadWallSeconds=time.perf_counter() - started, upload=observation)
    return model


def run(images, path, device, *, tools, expected, error, cache=None, check=None):
    """Own one checked upscaler only for this pass; keep profile byte fences."""
    model = None
    try:
        if check is not None:
            check()
        path = Path(path)
        started = time.perf_counter()
        before = _file_identity(path)
        fingerprint = tools("native_hash").file_sha256 if cache is not None or expected is not None else None
        lease = cache.lease if cache is not None else None
        digest = lease.acquire(path, fingerprint) if lease is not None else (fingerprint(path) if fingerprint is not None else None)
        protected = lease is not None and lease.cached
        if before != _file_identity(path) or (expected is not None and digest != expected):
            raise error("MODEL_CHANGED", "Upscaler bytes changed after profile validation")
        report = {"executionRevision": EXECUTION_REVISION,
                  "loading": {"fingerprintWallSeconds": time.perf_counter() - started}}
        model = load_remacri(path, device=device, upload=tools("native_upload").try_packed_upload,
                            report=report["loading"], cache=cache, identity=(*before, digest), check=check)
        started = time.perf_counter()
        after = digest if protected else (fingerprint(path) if fingerprint is not None else None)
        if before != _file_identity(path) or after != digest or (protected and not lease.valid()):
            raise error("MODEL_CHANGED", "Upscaler bytes changed while loading")
        report["loading"]["fingerprintWallSeconds"] += time.perf_counter() - started
        if check is not None:
            check()
        result = upscale_4x(model, images, tiling=tools("anima_tiling"), report=report, check=check)
        if check is not None:
            check()
        if protected and not lease.valid():
            raise error("MODEL_CHANGED", "Upscaler protection changed during the pass")
        return result, report
    except BaseException:
        if cache is not None:
            cache.clear()
        raise
    finally:
        # No CUDA module is retained between passes, including failed/cancelled ones.
        model = None


def upscale_4x(model, images, *, tile_size=512, overlap=32, tiling=None, report=None, check=None):
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
    def predict(patch):
        if check is not None:
            check()
        return model(patch.to(device=parameter.device, dtype=torch.float32))
    with torch.no_grad(), torch.autocast(device_type=parameter.device.type, enabled=False):
        while True:
            try:
                output = tiling.stitch(images, predict,
                    tile=tile_size, overlap=overlap, scale=4, channels=3, report=report)
                return output.clamp_(0, 1)
            except torch.cuda.OutOfMemoryError:
                if parameter.device.type != "cuda" or tile_size <= 128:
                    raise
            # Leave the exception scope before releasing the allocator: the
            # failed stitch's traceback must not retain tile activations.
            torch.cuda.empty_cache()
            tile_size //= 2
