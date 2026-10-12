"""Torch RCAS from AMD FidelityFX FSR1's MIT FsrRcasF reference.

Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
See RCAS_LICENSE.txt for the complete permission notice and pinned provenance.
https://github.com/GPUOpen-Effects/FidelityFX-FSR/blob/a21ffb8f6c13233ba336352bdff293894c706575/ffx-fsr/ffx_fsr1.h#L682-L767

The product variant independently follows its KJ workflow's functional math:
five-point extrema, RGB minimum lobe, reflect borders, epsilon stabilization,
strength before limiting, reciprocal normalization. This differs from AMD's
shader reference; no Comfy/KJ source code or runtime is included.
"""
import math


def rcas(images, strength=0.75):
    """Sharpen finite display-referred RGB [N,3,H,W] tensors already in [0,1].

    CPU/CUDA float16, bfloat16 and float32 are supported. Shape, dtype and device
    are preserved; input is never modified. Strength must be a finite scalar in
    [0,1]: 0 returns the original tensor exactly, 1 is maximum RCAS, and 0.75 is
    the product workflow's sharpening strength.

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
        padded = functional.pad(center, (1, 1, 1, 1), mode="reflect")
        north, south = padded[:, :, :-2, 1:-1], padded[:, :, 2:, 1:-1]
        west, east = padded[:, :, 1:-1, :-2], padded[:, :, 1:-1, 2:]
        minimum = torch.minimum(torch.minimum(torch.minimum(torch.minimum(north, south), west), east), center)
        maximum = torch.maximum(torch.maximum(torch.maximum(torch.maximum(north, south), west), east), center)
        lower_limit = -minimum / (4 * maximum + 1e-6)
        upper_limit = -(1 - maximum) / (4 * (1 - minimum) + 1e-6)
        lobe = (torch.maximum(lower_limit, upper_limit).amin(dim=1, keepdim=True) * strength).clamp(-.1875, 0)
        result = (center + ((north + south) + east + west) * lobe) * (1 + 4 * lobe).reciprocal()
        return result.clamp(0, 1).to(dtype=images.dtype)
