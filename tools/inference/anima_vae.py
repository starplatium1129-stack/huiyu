"""Single-frame Qwen VAE boundaries for the Anima product workflow.

Public encode/decode retain pinned Diffusers offload hooks. Raw single-frame
operations use the existing Apache-2.0 model modules with no video feature cache.
Normal inference precedes one CUDA-OOM-only spatial feather fallback; latent
normalization and display conversion are FP32, not BF16 component arithmetic.
Model integration adapted from Diffusers 0.41 (Apache-2.0), Copyright 2026
The HuggingFace Team; license text is retained in ANIMA_CONVERSION_LICENSE.txt.
"""
from contextlib import contextmanager
from math import prod


def _decode_tile(vae, latents):
    return vae.decoder(vae.post_quant_conv(latents), feat_cache=None, feat_idx=[0])


def _encode_tile(vae, pixels):
    return vae.quant_conv(vae.encoder(pixels, feat_cache=None, feat_idx=[0]))


def _decode_size(latents):
    import torch
    height, width = latents.shape[-2:]
    free, total = torch.cuda.mem_get_info(latents.device)
    reclaimable = max(0, torch.cuda.memory_reserved(latents.device) - torch.cuda.memory_allocated(latents.device))
    coefficient = 2200 * 64 * latents.element_size()
    budget = min(coefficient * height * width, int(total * .8), free + reclaimable)
    size = 32
    while size * 2 <= max(height, width) and coefficient * min(height, size * 2) * min(width, size * 2) <= budget:
        size *= 2
    return size


def _perform(vae, values, kind, tiling):
    import torch
    if values.ndim != 5 or values.shape[0] != 1 or values.shape[2] != 1:
        raise ValueError("Anima VAE requires one single-frame [1,C,1,H,W] tensor")
    operation = _encode_tile if kind == "encode" else _decode_tile
    event = dict(kind=kind, mode="full", tileSize=0, overlap=0, tileCount=1, outputDevice=values.device.type)
    try:
        output = operation(vae, values)
    except torch.cuda.OutOfMemoryError:
        if values.device.type != "cuda":
            raise
    else:
        vae._huiyu_vae_events.append(event)
        return output
    # The failed operation's traceback is gone before the fallback allocation.
    vae.clear_cache()
    torch.cuda.empty_cache()
    size = 256 if kind == "encode" else _decode_size(values)
    event["mode"] = "tiled"
    output = tiling.stitch(values[:, :, 0],
        lambda patch: operation(vae, patch.unsqueeze(2))[:, :, 0],
        tile=size, overlap=size // 4, scale=1 / 8 if kind == "encode" else 8,
        channels=32 if kind == "encode" else 3, report=event).unsqueeze(2)
    vae._huiyu_vae_events.append(event)
    return output


@contextmanager
def _single_frame(vae, kind, tiling):
    import torch
    from diffusers.models.autoencoders.autoencoder_kl_qwenimage import AutoencoderKLQwenImage, QwenImageCausalConv3d, QwenImageRMS_norm
    from diffusers.models.autoencoders.vae import DecoderOutput
    if type(vae) is not AutoencoderKLQwenImage:
        raise ValueError("Anima VAE boundary requires the exact pinned QwenImage implementation")
    forwards = []
    for module in vae.modules():
        forward, owned_forward = module.forward, "forward" in module.__dict__
        if type(module) is QwenImageCausalConv3d:
            def frame_conv(values, cache_x=None, *, layer=module, original=forward):
                if (values.shape[2] == 1 and cache_x is None and layer.dilation[0] == 1
                        and layer._padding[4] == layer.kernel_size[0] - 1 and layer._padding[5] == 0
                        and layer._padding[0] == layer._padding[1] and layer._padding[2] == layer._padding[3]):
                    return torch.nn.functional.conv3d(values, layer.weight[:, :, -1:], layer.bias,
                        stride=layer.stride, padding=(0, layer._padding[2], layer._padding[0]),
                        dilation=layer.dilation, groups=layer.groups)
                return original(values, cache_x)
            replacement_forward = frame_conv
        elif type(module) is QwenImageRMS_norm:
            def frame_norm(values, *, layer=module):
                normalized = torch.nn.functional.normalize(values, dim=1 if layer.channel_first else -1)
                if (type(values) is torch.Tensor and type(normalized) is torch.Tensor
                        and normalized.layout == torch.strided and normalized.is_contiguous()
                        and normalized.device.type in ("cpu", "cuda")
                        and normalized.dtype in (torch.float16, torch.bfloat16, torch.float32)
                        and not torch.is_grad_enabled() and not torch.is_autocast_enabled(normalized.device.type)
                        and layer.channel_first and normalized.ndim in (4, 5)
                        and normalized.stride() == tuple(prod(normalized.shape[i + 1:]) for i in range(normalized.ndim))
                        and type(layer.gamma) is torch.nn.Parameter
                        and layer.gamma.dtype == normalized.dtype and layer.gamma.device == normalized.device
                        and layer.gamma.shape == (normalized.shape[1],) + (1,) * (normalized.ndim - 2)
                        and type(layer.scale) is float and type(layer.bias) is float and layer.bias == 0.0):
                    # normalize allocated this private buffer. Preserve each
                    # multiply/add and its dtype rounding without full-size outputs.
                    return normalized.mul_(layer.scale).mul_(layer.gamma).add_(layer.bias)
                return normalized * layer.scale * layer.gamma + layer.bias
            replacement_forward = frame_norm
        else:
            continue
        forwards.append((module, forward, owned_forward))
        module.forward = replacement_forward
    name = "_encode" if kind == "encode" else "_decode"
    original, owned = getattr(vae, name), name in vae.__dict__
    if kind == "encode":
        replacement = lambda values: _perform(vae, values, kind, tiling)
    else:
        def replacement(values, return_dict=True):
            output = _perform(vae, values, kind, tiling)
            return DecoderOutput(sample=output) if return_dict else (output,)
    setattr(vae, name, replacement)
    try:
        yield
    finally:
        if owned:
            setattr(vae, name, original)
        else:
            delattr(vae, name)
        for module, forward, owned_forward in forwards:
            if owned_forward:
                module.forward = forward
            else:
                del module.forward
        vae.clear_cache()


def _statistics(vae, values):
    import torch
    shape = (1, vae.config.z_dim, 1, 1, 1)
    return [torch.tensor(getattr(vae.config, name), device=values.device, dtype=torch.float32).reshape(shape)
            for name in ("latents_mean", "latents_std")]


def _preprocess(processor, image, *, height, width):
    import torch
    from diffusers.image_processor import VaeImageProcessor
    if (type(processor) is VaeImageProcessor and type(image) is torch.Tensor
            and image.layout == torch.strided and image.dtype == torch.float32
            and image.device.type in ("cpu", "cuda") and not image.requires_grad
            and image.ndim == 4 and image.shape[:2] == (1, 3)
            and image.shape[-2] > 0 and image.shape[-1] > 0
            and (image.is_contiguous() or image.is_contiguous(memory_format=torch.channels_last))
            and processor.config.vae_latent_channels != 3
            and processor.config.do_normalize and not processor.config.do_binarize):
        size = processor.get_default_height_width(image, height=height, width=width)
        if (not processor.config.do_resize or size == tuple(image.shape[-2:])) and not bool(image.min() < 0):
            # Keep cat: it canonicalizes some singleton-batch tensor layouts.
            # The same-size nearest resize preserves its values/layout. Reuse
            # this private buffer for the pinned FP32 multiply/subtract order.
            pixels = torch.cat([image], dim=0)
            return pixels.mul_(2.0).sub_(1.0)
    # Preserve resizing, negative-input warnings and all nonstandard processors.
    return processor.preprocess(image, height=height, width=width)


def encode(pipeline, image, tiling, *, height, width):
    import torch
    pixels = _preprocess(pipeline.image_processor, image, height=height, width=width)
    pixels = pixels.unsqueeze(2).to(device=pipeline._execution_device, dtype=pipeline.vae.dtype)
    with torch.no_grad(), _single_frame(pipeline.vae, "encode", tiling):
        raw = pipeline.vae.encode(pixels).latent_dist.mode().float()
    mean, std = _statistics(pipeline.vae, raw)
    normalized = (raw - mean) / std
    if not bool(torch.isfinite(normalized).all()):
        raise ValueError("VAE encoded nonfinite image latents")
    return normalized.to(pipeline._execution_device)


def upscale_latents(vae, latents, size):
    import torch
    mean, std = _statistics(vae, latents)
    # The workflow interpolates raw VAE latents between sampler process_out/in.
    raw = latents.float() * std + mean
    raw = torch.nn.functional.interpolate(raw[:, :, 0], size=(size[1] // 8, size[0] // 8),
        mode="bicubic", align_corners=False).unsqueeze(2)
    return (raw - mean) / std


def apply_blocks(blocks, tiling):
    import torch
    from diffusers.image_processor import VaeImageProcessor
    from diffusers.modular_pipelines.anima.modular_blocks_anima import AnimaAutoBlocks
    from diffusers.modular_pipelines.anima.encoders import AnimaImg2ImgVaeEncoderStep
    from diffusers.modular_pipelines.anima.decoders import AnimaVaeDecoderStep, AnimaProcessImagesOutputStep
    class Encoder(AnimaImg2ImgVaeEncoderStep):
        @torch.no_grad()
        def __call__(self, components, state):
            block = self.get_block_state(state)
            block.height, block.width = block.height or components.default_height, block.width or components.default_width
            block.image_latents = encode(components, block.image, tiling, height=block.height, width=block.width)
            self.set_block_state(state, block)
            return components, state
    class Decoder(AnimaVaeDecoderStep):
        @torch.no_grad()
        def __call__(self, components, state):
            block = self.get_block_state(state)
            latents = block.latents.float()
            mean, std = _statistics(components.vae, latents)
            raw = (latents * std + mean).to(components.vae.dtype)
            with _single_frame(components.vae, "decode", tiling):
                block.images = components.vae.decode(raw, return_dict=False)[0][:, :, 0].float()
            self.set_block_state(state, block)
            return components, state
    class Postprocess(AnimaProcessImagesOutputStep):
        @torch.no_grad()
        def __call__(self, components, state):
            block = self.get_block_state(state)
            processor = components.image_processor
            if (block.output_type != "pt" or type(processor) is not VaeImageProcessor
                    or not processor.config.do_normalize or type(block.images) is not torch.Tensor
                    or block.images.dtype != torch.float32):
                return super().__call__(components, state)
            # Preserve the pinned multiply/add/clamp order and the raw decoder
            # tensor; only reuse the private result instead of two full images.
            pixels = block.images * 0.5
            pixels.add_(0.5).clamp_(0, 1)
            block.images = pixels
            self.set_block_state(state, block)
            return components, state
    blocks = AnimaAutoBlocks() if blocks is None else blocks
    blocks.sub_blocks["vae_encoder"].sub_blocks["vae_encoder"] = Encoder()
    blocks.sub_blocks["decode"].sub_blocks["decode"] = Decoder()
    blocks.sub_blocks["decode"].sub_blocks["postprocess"] = Postprocess()
    return blocks
