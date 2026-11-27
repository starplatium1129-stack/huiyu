"""Use the image-only VAE path of the pinned QWEN-Manga workflow."""
from math import ceil
from types import MethodType

import torch
import torch.nn.functional as F


def _rows(operation, image, scale, halo, *, add_to=None):
    # The upstream Wan image VAE selects cuDNN's convolution shape from this
    # row budget. Include neighboring input rows through the full receptive field.
    strips = ceil(image.numel() * scale**2 / 2**24)
    if strips <= 1 and add_to is None:
        return operation(image)
    height = image.size(-2)
    rows = ceil(height / strips)
    output = add_to
    for start in range(0, height, rows):
        stop = min(start + rows, height)
        top, bottom = max(0, start - halo), min(height, stop + halo)
        region = operation(image[..., top:bottom, :])
        if output is None:
            output = region.new_empty((*region.shape[:-2], height * scale, region.size(-1)))
        dest = output[..., start * scale:stop * scale, :]
        values = region[..., (start - top) * scale:(stop - top) * scale, :]
        if add_to is None:
            dest.copy_(values)
        else:
            dest.add_(values)
    return output


def _residual(block, x, feat_cache=None, feat_idx=None):
    def region(chunk):
        hidden = block.conv1(block.nonlinearity(block.norm1(chunk)))
        hidden = block.conv2(block.dropout(block.nonlinearity(block.norm2(hidden))))
        return hidden.add_(block.conv_shortcut(chunk))

    return _rows(region, x, scale=1, halo=2)


def _upsample(layers, x):
    def region(chunk):
        return layers[1](F.interpolate(chunk, scale_factor=2, mode="nearest-exact"))

    return _rows(region, x, scale=2, halo=1)


def _up_block(block, x, feat_cache=None, feat_idx=None, first_chunk=False):
    hidden = x
    for residual in block.resnets:
        hidden = residual(hidden)
    if block.upsampler is not None:
        hidden = block.upsampler(hidden)
    if block.avg_shortcut is not None:
        return _rows(lambda rows: block.avg_shortcut(rows, first_chunk=first_chunk), x,
                     scale=block.avg_shortcut.factor_s, halo=0, add_to=hidden)
    return hidden


def _rms(layer, x):
    # Wan rounds the norm in the activation dtype before scaling each channel.
    return F.normalize(x, dim=1 if layer.channel_first else -1) * layer.scale * layer.gamma.to(x) + layer.bias


def _attention(layer, x):
    from torch.nn.attention import SDPBackend, sdpa_kernel

    image = x.squeeze(2)
    projected = layer.to_qkv(layer.norm(image))
    q, k, v = (part.flatten(2).transpose(1, 2).unsqueeze(1).contiguous()
               for part in projected.chunk(3, dim=1))
    if q.is_cuda and q.numel() >= 128 * 1024:
        order = [SDPBackend.FLASH_ATTENTION, SDPBackend.CUDNN_ATTENTION,
                 SDPBackend.EFFICIENT_ATTENTION, SDPBackend.MATH]
        with sdpa_kernel(order, set_priority=True):
            context = F.scaled_dot_product_attention(q, k, v)
    else:
        context = F.scaled_dot_product_attention(q, k, v)
    return layer.proj(context.squeeze(1).transpose(1, 2).reshape_as(image)).unsqueeze(2) + x


def disable_video_cache(vae):
    # All callers are still-image pipelines. This also covers each spatial
    # tile and keeps the original decoder's first_chunk and placement hooks.
    def without_video_cache(module, args, kwargs):
        if kwargs.get("feat_cache") is not None:
            return args, {**kwargs, "feat_cache": None}

    for component in (vae.encoder, vae.decoder):
        component.register_forward_pre_hook(without_video_cache, with_kwargs=True)


def configure(vae):
    from diffusers.models.autoencoders.autoencoder_kl_qwenimage21 import (
        QwenImage21AttentionBlock, QwenImage21CausalConv3d, QwenImage21ResidualBlock,
        QwenImage21Resample, QwenImage21ResidualUpBlock, QwenImage21RMS_norm,
    )

    # Match Comfy's CUDA workaround for the affected cuDNN releases on the
    # managed PyTorch runtime, including its separate BF16 bias addition.
    torch_version = tuple(map(int, torch.__version__.split(".")[:2]))
    separate_bias = ((2, 9) <= torch_version <= (2, 10) and torch.version.cuda is not None
                     and 91002 <= (torch.backends.cudnn.version() or 0) < 91500)

    def convolution(layer, x, cache_x=None):
        # Upstream checkpoint kernels have a singleton time dimension. Keep it
        # for cuDNN and pass spatial padding to convolution rather than F.pad.
        weight = layer.weight.unsqueeze(2)
        padding = (0, layer._padding[2], layer._padding[0])
        stride, dilation = (1, *layer.stride), (1, *layer.dilation)
        if separate_bias and x.is_cuda and weight.dtype in (torch.bfloat16, torch.float16):
            result = torch.cudnn_convolution(x, weight, padding, stride, dilation, layer.groups,
                                             benchmark=False, deterministic=False, allow_tf32=True)
            if layer.bias is not None:
                result.add_(layer.bias.view(1, -1, 1, 1, 1))
            return result
        return F.conv3d(x, weight, layer.bias, stride, padding, dilation, layer.groups)

    for layer in vae.modules():
        if isinstance(layer, QwenImage21CausalConv3d):
            layer.forward = MethodType(convolution, layer)
        elif isinstance(layer, QwenImage21RMS_norm):
            layer.forward = MethodType(_rms, layer)
        elif isinstance(layer, QwenImage21ResidualBlock):
            layer.forward = MethodType(_residual, layer)
        elif isinstance(layer, QwenImage21ResidualUpBlock):
            layer.forward = MethodType(_up_block, layer)
        elif isinstance(layer, QwenImage21Resample) and layer.mode.startswith("upsample"):
            layer.resample.forward = MethodType(_upsample, layer.resample)
        elif isinstance(layer, QwenImage21AttentionBlock):
            layer.forward = MethodType(_attention, layer)
