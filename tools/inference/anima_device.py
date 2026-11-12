"""Select the accelerator once per Anima worker."""
from functools import lru_cache
import os
import re

GIB = 1024 ** 3


@lru_cache(maxsize=1)
def select():
    import torch

    requested = os.environ.get("HUIYU_ANIMA_DEVICE", "auto")
    if requested == "auto":
        kind, index = ("cuda" if torch.cuda.is_available() else "xpu"), 0
    else:
        match = re.fullmatch(r"(cuda|xpu)(?::([0-9]{1,3}))?", requested)
        if not match:
            raise ValueError("HUIYU_ANIMA_DEVICE must be auto, cuda[:index] or xpu[:index]")
        kind, index = match[1], int(match[2] or 0)
    api = getattr(torch, kind, None)
    if api is None or not api.is_available() or index >= api.device_count():
        target = "accelerator" if requested == "auto" else f"{kind}:{index} device"
        raise ValueError(f"No usable {target}. Install a compatible CUDA, ROCm or Intel XPU PyTorch build.")
    return Device(torch, api, torch.device(kind, index))


class Device:
    def __init__(self, torch, api, device):
        self.api, self.device = api, device
        api.set_device(device)
        properties = api.get_device_properties(device)
        self.name = properties.name
        self.backend = "xpu" if device.type == "xpu" else "rocm" if torch.version.hip else "cuda"
        self.arch = getattr(properties, "gcnArchName", "").split(":", 1)[0]
        self.shared = self.arch.startswith("gfx115") or bool(getattr(properties, "is_integrated_gpu", False))
        if self.backend == "rocm":
            # PyTorch's HIP availability check alone also returns true on RDNA2.
            modern_radeon = self.arch.startswith(("gfx11", "gfx12"))
            native_bf16 = (modern_radeon or self.arch.startswith(("gfx90a", "gfx94", "gfx95"))) and self._rocm_bf16(torch)
            if modern_radeon:
                # Keep AMD's MIOpen autotuning off the short single-image VAE path.
                torch.backends.cudnn.enabled = False
        else:
            native_bf16 = api.is_bf16_supported(including_emulation=False)
        # FP16 latents can overflow on ROCm. Preserve the exponent range
        # with FP32 if this accelerator cannot execute BF16.
        fallback = torch.float32 if self.backend == "rocm" else torch.float16
        self.dtype = torch.bfloat16 if native_bf16 else fallback
        self.memory_policy = self._memory_policy(os.environ.get("HUIYU_INFERENCE_MEMORY", "auto"), torch)

    def _rocm_bf16(self, torch):
        try:
            values = torch.ones((16, 16), dtype=torch.bfloat16, device=self.device)
            return bool(torch.isfinite(values @ values).all())
        except (RuntimeError, NotImplementedError):
            return False

    def _memory_policy(self, requested, torch):
        if requested != "auto":
            return requested
        if self.backend == "xpu" or self.shared:
            return "offload"
        if self.backend == "rocm" and (self.dtype == torch.float32 or self.api.mem_get_info(self.device)[0] < 12 * GIB):
            return "offload"
        return "resident"

    def diagnostic(self):
        return dict(backend=self.backend, device=str(self.device), deviceName=self.name,
                    architecture=self.arch or None, sharedMemory=self.shared,
                    dtype=str(self.dtype).split(".")[-1])
