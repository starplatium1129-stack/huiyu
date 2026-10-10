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


def prepare_images(image, mask_path, size, grow):
    """One effective mask for both denoising and pixel preservation; white edits."""
    from PIL import Image, ImageChops, ImageOps
    try:
        with Image.open(mask_path) as source:
            if source.format not in {"PNG", "JPEG", "WEBP"} or getattr(source, "n_frames", 1) != 1:
                raise ValueError("Mask must be one PNG, JPEG or WebP image")
            if source.width * source.height > 4096 * 4096:
                raise ValueError("Mask must be at most 16 megapixels")
            source = ImageOps.exif_transpose(source)
            if source.size != image.size:
                raise ValueError("Mask dimensions must match the oriented input image")
            rgba = source.convert("RGBA")
            # Transparent paint/erased pixels preserve even when RGB remains white.
            mask = ImageChops.multiply(rgba.convert("L"), rgba.getchannel("A"))
    except (OSError, Image.DecompressionBombError) as exc:
        raise ValueError(f"Cannot decode mask image: {exc}") from exc
    return prepare_mask(image, mask, size, grow)


def prepare_mask(image, mask, size, grow):
    """Shared effective mask for manual and locally segmented inputs."""
    from PIL import Image, ImageFilter
    mask = mask.resize(size, Image.Resampling.NEAREST)
    if grow:
        mask = mask.filter(ImageFilter.MaxFilter(2 * grow + 1))
    if mask.getbbox() is None:
        raise ValueError("Mask has no editable pixels")
    return image.resize(size, Image.Resampling.LANCZOS), mask


def composite(generated, original, mask):
    from PIL import Image
    if generated.size != original.size or mask.size != original.size:
        raise ValueError("Generated image and effective mask dimensions differ")
    return Image.composite(generated.convert("RGB"), original.convert("RGB"), mask)


def blend_latents(scheduler, latents, image_latents, noise, mask, timesteps, index):
    """Restore protected latents at next sigma, clean reference on the last step."""
    reference = image_latents.to(device=latents.device, dtype=latents.dtype)
    if index + 1 < len(timesteps):
        timestep = timesteps[index + 1:index + 2].repeat(reference.shape[0])
        reference = scheduler.scale_noise(reference, timestep, noise)
    return (1 - mask) * reference + mask * latents


def masked_blocks():
    """Replace supported modular leaves before pipeline initialization."""
    import numpy as np
    import torch
    from diffusers.utils.torch_utils import randn_tensor
    from diffusers.modular_pipelines.modular_pipeline_utils import InputParam, OutputParam
    from diffusers.modular_pipelines.anima.before_denoise import AnimaImg2ImgPrepareLatentsStep
    from diffusers.modular_pipelines.anima.denoise import AnimaLoopAfterDenoiser
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
            mask = torch.from_numpy(np.array(block.mask_image, dtype=np.float32) / 255).unsqueeze(0).unsqueeze(0)
            mask = torch.nn.functional.interpolate(mask, size=image_latents.shape[-2:], mode="nearest")
            block.latent_mask = mask.unsqueeze(2).to(device=image_latents.device, dtype=torch.float32)
            timestep = block.timesteps[:1].repeat(image_latents.shape[0])
            block.latents = components.scheduler.scale_noise(image_latents, timestep, block.mask_noise)
            block.padding_mask = block.latents.new_zeros(1, 1, block.height, block.width, dtype=block.dtype)
            self.set_block_state(state, block)
            return components, state

    class MaskedAfter(AnimaLoopAfterDenoiser):
        @property
        def inputs(self):
            return super().inputs + [InputParam(name, required=True) for name in
                ("image_latents", "mask_noise", "latent_mask", "timesteps")]

        @torch.no_grad()
        def __call__(self, components, block, i, t):
            components, block = super().__call__(components, block, i, t)
            block.latents = blend_latents(components.scheduler, block.latents, block.image_latents,
                block.mask_noise, block.latent_mask, block.timesteps, i)
            return components, block

    blocks = AnimaAutoBlocks()
    core = blocks.sub_blocks["denoise"].sub_blocks["img2img"]
    core.sub_blocks["prepare_latents"] = MaskedPrepare()
    core.sub_blocks["denoise"].sub_blocks["after_denoiser"] = MaskedAfter()
    return blocks
