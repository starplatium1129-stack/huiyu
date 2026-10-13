"""Explicit, pinned Cosmos execution modes; LoRA fusion is separately opt-in."""
import importlib.metadata
import importlib.util
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


def configure(transformer):
    mode = validate()
    from diffusers.models.transformers.transformer_cosmos import CosmosAttnProcessor2_0
    for block in transformer.transformer_blocks:
        for attn in (block.attn1, block.attn2):
            if type(attn.processor) is CosmosAttnProcessor2_0:
                attn.set_processor(_CosmosProcessor())
    if mode == "native":
        return
    import torch
    from diffusers.models.attention_dispatch import attention_backend
    if torch.cuda.get_device_capability(0) != (8, 9):
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
            block.forward = torch.compile(block.forward, fullgraph=False, mode="default")


class _CosmosProcessor:
    """Pinned Cosmos math without copying K/V when their repeat factor is one.

    Adapted from Diffusers 0.41.0 transformer_cosmos.py (Apache-2.0).
    Copyright 2025 The NVIDIA Team and The HuggingFace Team. All rights reserved.
    License: ANIMA_CONVERSION_LICENSE.txt (Apache-2.0); distributed AS IS.
    https://github.com/huggingface/diffusers/blob/v0.41.0/src/diffusers/models/transformers/transformer_cosmos.py
    """
    def __call__(self, attn, hidden_states, encoder_hidden_states=None,
                 attention_mask=None, image_rotary_emb=None):
        from diffusers.models.attention_dispatch import dispatch_attention_fn
        from diffusers.models.embeddings import apply_rotary_emb
        encoder = hidden_states if encoder_hidden_states is None else encoder_hidden_states
        query = attn.to_q(hidden_states).unflatten(2, (attn.heads, -1)).transpose(1, 2)
        key = attn.to_k(encoder).unflatten(2, (attn.heads, -1)).transpose(1, 2)
        value = attn.to_v(encoder).unflatten(2, (attn.heads, -1)).transpose(1, 2)
        query, key = attn.norm_q(query), attn.norm_k(key)
        if image_rotary_emb is not None:
            query = apply_rotary_emb(query, image_rotary_emb, use_real=True, use_real_unbind_dim=-2)
            key = apply_rotary_emb(key, image_rotary_emb, use_real=True, use_real_unbind_dim=-2)
        key_repeats, value_repeats = query.size(3) // key.size(3), query.size(3) // value.size(3)
        if key_repeats != 1:
            key = key.repeat_interleave(key_repeats, dim=3)
        if value_repeats != 1:
            value = value.repeat_interleave(value_repeats, dim=3)
        result = dispatch_attention_fn(query.transpose(1, 2), key.transpose(1, 2), value.transpose(1, 2),
                                       attn_mask=attention_mask, dropout_p=0.0, is_causal=False)
        result = result.flatten(2, 3).type_as(query)
        return attn.to_out[1](attn.to_out[0](result))
