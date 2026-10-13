"""Anima image preparation/output and manual-mask blocks for Diffusers 0.41.0.

Prepare/after-step integration adapted from Hugging Face Diffusers (Apache-2.0):
Copyright 2026 The HuggingFace Team. All rights reserved.
https://github.com/huggingface/diffusers/tree/v0.41.0/src/diffusers/modular_pipelines/anima
https://github.com/huggingface/diffusers/blob/v0.41.0/src/diffusers/pipelines/flux/pipeline_flux_inpaint.py
Licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0).
Distributed on an AS IS BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.
No ComfyUI implementation or sampler-equivalence claim.
"""
import os
from pathlib import Path
import tempfile
import time


def save_png(image, path):
    """Atomically save lossless PNG; retry default compression above 32 MiB."""
    started = time.perf_counter()
    output = Path(path).expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=output.parent, suffix=".png", delete=False) as file:
            temporary = Path(file.name)
        image.save(temporary, format="PNG", compress_level=4)
        size = temporary.stat().st_size
        if size > 32 * 1024 * 1024:
            # Level 4 can be larger than the previous Pillow default. Retry that
            # default before the host applies its unchanged output-size bound.
            image.save(temporary, format="PNG", compress_level=6)
            size = temporary.stat().st_size
        os.replace(temporary, output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    return dict(outputSaveSeconds=time.perf_counter() - started, outputBytes=size)


def resize_image(image, size, *, red_only=False):
    """Shared geometry; manual masks resize only the converted RGB red channel."""
    from PIL import Image
    ratio = min(size[0] / image.width, size[1] / image.height)
    fitted = (max(1, int(image.width * ratio)), max(1, int(image.height * ratio)))
    # Borrow already-normalized RGB pixels read-only; the returned canvas owns
    # its pixels and deliberately does not inherit input EXIF/info metadata.
    # Straight RGBA to RGB only drops alpha; red-only may read the same R.
    converted = (image if image.mode == "RGB" or (red_only and image.mode == "RGBA")
        else image.convert("RGB"))
    if red_only:
        # Keep palette/CMYK and premultiplied modes on the original RGB conversion.
        # Pillow 11.3 Lanczos resamples each 8-bit RGB/L band independently.
        converted = converted.getchannel("R")
    resized = (converted if converted.size == fitted else
        converted.resize(fitted, Image.Resampling.LANCZOS))
    del converted
    canvas = Image.new("L" if red_only else "RGB", size, "black")
    canvas.paste(resized, ((size[0] - fitted[0]) // 2, (size[1] - fitted[1]) // 2))
    return canvas


def resize_mask(mask, size):
    """Hires mask uses nearest-exact; retain fractional alpha without uint8."""
    import numpy as np
    import torch
    values = torch.as_tensor(np.asarray(mask, dtype=np.float32))[None, None]
    return torch.nn.functional.interpolate(values, size=(size[1], size[0]),
        mode="nearest-exact")[0, 0].numpy()


def prepare_images(image, mask_path, size, grow):
    """The workflow reads resized mask RGB red; alpha is a separate LoadImage output."""
    import numpy as np
    from PIL import Image, ImageOps
    try:
        with Image.open(mask_path) as source:
            if source.format not in {"PNG", "JPEG", "WEBP"} or getattr(source, "n_frames", 1) != 1:
                raise ValueError("Mask must be one PNG, JPEG or WebP image")
            if source.width * source.height > 4096 * 4096:
                raise ValueError("Mask must be at most 16 megapixels")
            ImageOps.exif_transpose(source, in_place=True)
            if source.size != image.size:
                raise ValueError("Mask dimensions must match the oriented input image")
            red = np.array(resize_image(source, size, red_only=True), dtype=np.float32) / 255
    except (OSError, Image.DecompressionBombError) as exc:
        raise ValueError(f"Cannot decode mask image: {exc}") from exc
    del source  # Retire decoded pixels and any ImageFile decoder before Torch/growth.
    return resize_image(image, size), _prepare_effective_mask(red, size, grow)


def _prepare_effective_mask(mask, size, grow):
    """Repeated five-neighbour dilation gives tapered/diamond corners."""
    import numpy as np
    values = resize_mask(mask, size)
    for _ in range(grow):
        padded = np.pad(values, 1, mode="edge")
        # All neighbours read the previous round from padded. Reuse our owned
        # resized output in the same reduction order, without a five-image stack.
        np.maximum(padded[1:-1, 1:-1], padded[:-2, 1:-1], out=values)
        np.maximum(values, padded[2:, 1:-1], out=values)
        np.maximum(values, padded[1:-1, :-2], out=values)
        np.maximum(values, padded[1:-1, 2:], out=values)
        del padded
    if not np.any(values > 0):
        raise ValueError("Mask has no editable pixels")
    return values


def masked_blocks():
    """Replace supported modular leaves before pipeline initialization."""
    import numpy as np
    import torch
    from diffusers.utils.torch_utils import randn_tensor
    from diffusers.modular_pipelines.modular_pipeline_utils import InputParam, OutputParam
    from diffusers.modular_pipelines.anima.before_denoise import AnimaImg2ImgPrepareLatentsStep
    from diffusers.modular_pipelines.anima.denoise import AnimaLoopBeforeDenoiser, AnimaLoopAfterDenoiser
    from diffusers.modular_pipelines.anima.modular_blocks_anima import AnimaAutoBlocks

    class MaskedPrepare(AnimaImg2ImgPrepareLatentsStep):
        @property
        def inputs(self):
            return super().inputs + [InputParam("mask_image", required=True)]

        @property
        def intermediate_outputs(self):
            return super().intermediate_outputs + [OutputParam("mask_noise"), OutputParam("latent_mask")]

        @torch.no_grad()
        def __call__(self, components, state):
            block = self.get_block_state(state)
            image_latents = block.image_latents.to(device=components._execution_device, dtype=torch.float32)
            if image_latents.ndim != 5 or image_latents.shape[2] != 1:
                raise ValueError("Masked Anima requires single-frame B,C,1,H,W image latents")
            # Draw exactly once, at the same point and precision as stock img2img.
            block.mask_noise = (randn_tensor(image_latents.shape, generator=block.generator,
                device=components._execution_device, dtype=torch.float32) if block.latents is None
                else block.latents.to(device=components._execution_device, dtype=torch.float32))
            mask = torch.from_numpy(np.asarray(block.mask_image, dtype=np.float32))[None, None, None]
            block.latent_mask = torch.nn.functional.interpolate(mask, size=image_latents.shape[-3:],
                mode="trilinear", align_corners=False).to(device=image_latents.device)
            timestep = block.timesteps[:1].repeat(image_latents.shape[0])
            block.latents = components.scheduler.scale_noise(image_latents, timestep, block.mask_noise)
            block.padding_mask = block.latents.new_zeros(1, 1, block.height, block.width, dtype=block.dtype)
            self.set_block_state(state, block)
            return components, state

    class MaskedBefore(AnimaLoopBeforeDenoiser):
        @property
        def inputs(self):
            return super().inputs + [InputParam(name, required=True) for name in
                ("image_latents", "mask_noise", "latent_mask")]

        @property
        def intermediate_outputs(self):
            return super().intermediate_outputs + [OutputParam("masked_input")]

        @torch.no_grad()
        def __call__(self, components, block, i, t):
            components, block = super().__call__(components, block, i, t)
            sigma = components.scheduler.sigmas[i].to(block.latents.device)
            reference = block.image_latents.float().to(block.latents.device)
            noisy_reference = (1 - sigma) * reference + sigma * block.mask_noise
            block.masked_input = block.latent_mask * block.latents + (1 - block.latent_mask) * noisy_reference
            block.latent_model_input = block.masked_input.to(block.dtype)
            return components, block

    class MaskedAfter(AnimaLoopAfterDenoiser):
        @property
        def inputs(self):
            return super().inputs + [InputParam(name, required=True) for name in
                ("image_latents", "masked_input", "latent_mask")]

        @torch.no_grad()
        def __call__(self, components, block, i, t):
            sigma = components.scheduler.sigmas[i].to(block.latents.device)
            denoised = block.masked_input - sigma * block.noise_pred.float()
            denoised = block.latent_mask * denoised + (1 - block.latent_mask) * block.image_latents.to(block.latents.device).float()
            # The scheduler integrates the original state, while its prediction
            # includes the clean protected reference. RES history sees this D.
            block.noise_pred = (block.latents.float() - denoised) / sigma
            return super().__call__(components, block, i, t)

    blocks = AnimaAutoBlocks()
    core = blocks.sub_blocks["denoise"].sub_blocks["img2img"]
    core.sub_blocks["prepare_latents"] = MaskedPrepare()
    core.sub_blocks["denoise"].sub_blocks["before_denoiser"] = MaskedBefore()
    core.sub_blocks["denoise"].sub_blocks["after_denoiser"] = MaskedAfter()
    return blocks
