"""Explicit, pinned Cosmos execution modes; LoRA fusion is separately opt-in."""
import importlib.metadata
import importlib.util
from functools import lru_cache
import os
from pathlib import Path

MODE = os.environ.get("HUIYU_INFERENCE_ACCELERATION", "native")
PINS = {"sageattention": "2.2.0+cu128torch2.8.0.post3", "triton-windows": "3.4.0.post21"}


def validate():
    if os.environ.get("DIFFUSERS_ATTN_BACKEND") not in (None, "native"):
        raise ValueError("Use HUIYU_INFERENCE_ACCELERATION instead of overriding DIFFUSERS_ATTN_BACKEND")
    if MODE not in ("native", "sage", "compiled-sage", "compiled-fused-sage"):
        raise ValueError("HUIYU_INFERENCE_ACCELERATION must be native, sage, compiled-sage or compiled-fused-sage")
    if MODE != "native":
        if os.name != "nt":
            raise ValueError("This Sage candidate is validated only with the pinned Windows runtime")
        for name, expected in PINS.items():
            if importlib.metadata.version(name) != expected:
                raise ValueError(f"{name}=={expected} is required by this acceleration candidate")
        from sageattention import sageattn
    return MODE


def configure(transformer, execution, tools, device):
    mode = validate()
    if mode != "native" and device.backend != "cuda":
        raise ValueError("Select native acceleration for AMD ROCm or Intel XPU")
    from diffusers.models.transformers.transformer_cosmos import CosmosAttnProcessor2_0
    # Sage modes already require this exact Triton wheel and the SM89 runtime.
    # Native mode keeps its dependency-free PyTorch path.
    fused = tools("worker_lifecycle").load_sibling("anima_fused") if mode != "native" else None
    attention = _rocm_attention if device.backend == "rocm" else None
    execution.kernel_backend = "triton-cosmos-v1" if fused is not None else "rocm-bounded-sdpa" if attention else "pytorch"
    for block in transformer.transformer_blocks:
        for attn in (block.attn1, block.attn2):
            if type(attn.processor) is CosmosAttnProcessor2_0:
                attn.set_processor(_CosmosProcessor(fused, attention))
        if fused is not None:
            for norm in (block.norm1, block.norm2, block.norm3):
                fused.bind_adaln(norm)
    if fused is not None:
        fused.bind_adaln(transformer.norm_out)
    if mode == "native":
        return
    import torch
    from diffusers.models.attention_dispatch import attention_backend
    if torch.cuda.get_device_capability(device.device) != (8, 9):
        raise ValueError("This Sage candidate requires the validated Ada SM89 device family")
    original = transformer.forward

    def forward(*args, **kwargs):
        # Only Cosmos: the conditioner has masks unsupported by this backend.
        with attention_backend("sage"):
            return original(*args, **kwargs)

    transformer.forward = forward
    if mode == "compiled-fused-sage":
        # -I workers load only a bundled sibling. The resident applies fusion
        # after LoRA loading and restores it before changing adapters/scales.
        spec = importlib.util.spec_from_file_location("huiyu_anima_lora_fusion", Path(__file__).with_name("anima_lora_fusion.py"))
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        transformer._huiyu_lora_fusion = helper.LoraFusionState()
    if mode in ("compiled-sage", "compiled-fused-sage"):
        for block in transformer.transformer_blocks:
            # TeaCache later wraps this callable, not a compiled Tea decision.
            # The PEFT modules remain in place; Dynamo guards the fused branch
            # or the original active adapters/scales before reusing its graph.
            block.forward = execution.compile_block(block.forward)


@lru_cache(maxsize=8)
def _rocm_flash_available(device, dtype, head_dim):
    import torch
    from torch.nn.attention import SDPBackend, sdpa_kernel

    if dtype not in (torch.float16, torch.bfloat16) or not torch.backends.cuda.is_flash_attention_available():
        return False
    # Check the wheel's actual kernel before allowing it on the full canvas.
    try:
        sample = torch.ones((1, 1, 16, head_dim), device=device, dtype=dtype)
        args = torch.backends.cuda.SDPAParams(sample, sample, sample, None, 0., False, False)
        if not torch.backends.cuda.can_use_flash_attention(args):
            return False
        with sdpa_kernel(SDPBackend.FLASH_ATTENTION):
            result = torch.nn.functional.scaled_dot_product_attention(sample, sample, sample)
        return torch.isfinite(result).all().item()
    except (RuntimeError, NotImplementedError):
        return False


def _rocm_attention(query, key, value, mask):
    import torch
    from torch.nn.attention import SDPBackend, sdpa_kernel

    attention = torch.nn.functional.scaled_dot_product_attention
    if mask is None and _rocm_flash_available(query.device, query.dtype, query.shape[-1]):
        args = torch.backends.cuda.SDPAParams(query, key, value, None, 0., False, False)
        if torch.backends.cuda.can_use_flash_attention(args):
            with sdpa_kernel(SDPBackend.FLASH_ATTENTION):
                return attention(query, key, value)
    # Bound the FP32 score matrix on wheels without a compatible fused kernel.
    # Each query still attends to the complete key sequence.
    rows = max(1, (32 * 1024 ** 2) // (4 * query.shape[0] * query.shape[1] * key.shape[-2]))
    with sdpa_kernel(SDPBackend.MATH):
        if rows >= query.shape[-2]:
            return attention(query, key, value, attn_mask=mask)
        result = query.new_empty((*query.shape[:-1], value.shape[-1]))
        key, value = key.float(), value.float()
        for start in range(0, query.shape[-2], rows):
            end = start + rows
            tile_mask = mask[..., start:end, :] if mask is not None and mask.ndim > 1 and mask.shape[-2] > 1 else mask
            if tile_mask is not None and tile_mask.dtype != torch.bool:
                tile_mask = tile_mask.float()
            result[..., start:end, :] = attention(query[..., start:end, :].float(), key, value, attn_mask=tile_mask)
        return result


class _CosmosProcessor:
    """Pinned Cosmos math without copying K/V when their repeat factor is one.

    Adapted from Diffusers 0.41.0 transformer_cosmos.py (Apache-2.0).
    Copyright 2025 The NVIDIA Team and The HuggingFace Team. All rights reserved.
    License: ANIMA_CONVERSION_LICENSE.txt (Apache-2.0); distributed AS IS.
    https://github.com/huggingface/diffusers/blob/v0.41.0/src/diffusers/models/transformers/transformer_cosmos.py
    """
    def __init__(self, fused, attention=None):
        self.fused, self.attention = fused, attention

    def __call__(self, attn, hidden_states, encoder_hidden_states=None,
                 attention_mask=None, image_rotary_emb=None):
        from diffusers.models.attention_dispatch import dispatch_attention_fn
        from diffusers.models.embeddings import apply_rotary_emb
        encoder = hidden_states if encoder_hidden_states is None else encoder_hidden_states
        query = attn.to_q(hidden_states).unflatten(2, (attn.heads, -1)).transpose(1, 2)
        key = attn.to_k(encoder).unflatten(2, (attn.heads, -1)).transpose(1, 2)
        value = attn.to_v(encoder).unflatten(2, (attn.heads, -1)).transpose(1, 2)
        fused = (self.fused.rms_rope(query, key, attn.norm_q, attn.norm_k, image_rotary_emb)
                 if self.fused is not None and image_rotary_emb is not None else None)
        if fused is not None:
            query, key = fused
        else:
            query, key = attn.norm_q(query), attn.norm_k(key)
            if image_rotary_emb is not None:
                query = apply_rotary_emb(query, image_rotary_emb, use_real=True, use_real_unbind_dim=-2)
                key = apply_rotary_emb(key, image_rotary_emb, use_real=True, use_real_unbind_dim=-2)
        key_repeats, value_repeats = query.size(3) // key.size(3), query.size(3) // value.size(3)
        if key_repeats != 1:
            key = key.repeat_interleave(key_repeats, dim=3)
        if value_repeats != 1:
            value = value.repeat_interleave(value_repeats, dim=3)
        if self.attention is not None:
            result = self.attention(query, key, value, attention_mask).transpose(1, 2)
        else:
            result = dispatch_attention_fn(query.transpose(1, 2), key.transpose(1, 2), value.transpose(1, 2),
                                           attn_mask=attention_mask, dropout_p=0.0, is_causal=False)
        result = result.flatten(2, 3).type_as(query)
        return attn.to_out[1](attn.to_out[0](result))
