"""Torch RCAS from AMD FidelityFX FSR1's MIT FsrRcasF reference.

Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
See RCAS_LICENSE.txt for the complete permission notice and pinned provenance.
https://github.com/GPUOpen-Effects/FidelityFX-FSR/blob/a21ffb8f6c13233ba336352bdff293894c706575/ffx-fsr/ffx_fsr1.h#L682-L767

This is a float32 tensor port, not bit-identical shader emulation: ordinary
division replaces GPU reciprocal approximations; borders replicate; singular
black/white endpoints use zero lobe limits; output is clamped to display range.
The optional FSR_RCAS_DENOISE path is disabled. No Comfy/KJ code is included.
"""
import math


def rcas(images, strength=0.75):
    """Sharpen finite display-referred RGB [N,3,H,W] tensors already in [0,1].

    CPU/CUDA float16, bfloat16 and float32 are supported. Shape, dtype and device
    are preserved; input is never modified. Strength must be a finite scalar in
    [0,1]: 0 returns the original tensor exactly, 1 is maximum RCAS, and 0.75 is
    a candidate amplitude (AMD sharpness stops = -log2(strength), about 0.415).
    This parameter is not a claim of parity with any ComfyUI node's slider.

    Pixel range/finite checks belong to the decoder boundary; this function
    performs metadata-only validation, without GPU readbacks or implicit sync.
    Positive-strength calculations use float32 and do not build autograd state.
    """
    import torch
    from torch.nn import functional as functional

    if (isinstance(strength, bool) or not isinstance(strength, (int, float))
            or not math.isfinite(strength) or not 0 <= strength <= 1):
        raise ValueError("RCAS strength must be a finite number in [0,1]")
    if (not isinstance(images, torch.Tensor) or images.ndim != 4 or images.shape[1] != 3
            or any(size <= 0 for size in images.shape)
            or images.dtype not in (torch.float16, torch.bfloat16, torch.float32)
            or images.device.type not in ("cpu", "cuda")):
        raise ValueError("RCAS requires a nonempty CPU/CUDA floating RGB [N,3,H,W] tensor")
    if strength == 0:
        return images
    with torch.no_grad():
        center = images.float()
        padded = functional.pad(center, (1, 1, 1, 1), mode="replicate")
        north, south = padded[:, :, :-2, 1:-1], padded[:, :, 2:, 1:-1]
        west, east = padded[:, :, 1:-1, :-2], padded[:, :, 1:-1, 2:]
        minimum = torch.minimum(torch.minimum(north, south), torch.minimum(west, east))
        maximum = torch.maximum(torch.maximum(north, south), torch.maximum(west, east))
        # For valid [0,1] inputs, these guards only define the degenerate black
        # and white ring denominators. They do not soften ordinary contrast.
        tiny = torch.finfo(torch.float32).tiny
        hit_min = torch.minimum(minimum, center) / (4 * maximum).clamp_min(tiny)
        hit_max = (1 - torch.maximum(maximum, center)) / (4 * minimum - 4).clamp_max(-tiny)
        # One shared RGB lobe, as in FsrRcasF; independent channel lobes would
        # alter the reference's color-limiting behavior.
        lobe = torch.maximum(-hit_min, hit_max).amax(dim=1, keepdim=True)
        lobe = lobe.clamp(min=-0.1875, max=0) * strength
        result = (center + lobe * (north + west + south + east)) / (1 + 4 * lobe)
        return result.clamp(0, 1).to(dtype=images.dtype)
