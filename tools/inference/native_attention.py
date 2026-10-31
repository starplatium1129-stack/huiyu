"""Task-scoped attention dispatch using installed SageAttention or PyTorch.

Model weights remain BF16. SageAttention uses the same attention kernels as the
local Comfy baseline; masked calls keep PyTorch's exact mask semantics.
"""
from contextlib import contextmanager
import importlib.util


@contextmanager
def inference_attention(enabled):
    if not enabled:
        yield "default"
        return
    import torch
    from torch.nn import functional as functional
    original = functional.scaled_dot_product_attention
    sage = None
    if importlib.util.find_spec("sageattention") is not None:
        from sageattention import sageattn
        sage = sageattn

    def attention(query, key, value, attn_mask=None, dropout_p=0.0, is_causal=False,
                  *, scale=None, enable_gqa=False):
        if attn_mask is not None:
            unmasked = attn_mask.all() if attn_mask.dtype == torch.bool else (attn_mask == 0).all()
            if bool(unmasked):
                attn_mask = None
        if (sage is not None and query.device.type == "cuda" and attn_mask is None
                and dropout_p == 0 and query.dtype in (torch.float16, torch.bfloat16)
                and (query.shape[-3] == key.shape[-3] or enable_gqa)
                and query.shape[-1] <= 128 and (not is_causal or query.shape[-2] == key.shape[-2])):
            return sage(query, key, value, tensor_layout="HND", is_causal=is_causal, sm_scale=scale)
        if enable_gqa and query.shape[-3] != key.shape[-3]:
            # Windows' PyTorch efficient kernel does not accept GQA directly.
            # Explicit expansion avoids its dense math fallback without changing
            # the attention calculation (the same expansion used by Comfy).
            groups = query.shape[-3] // key.shape[-3]
            key = key.repeat_interleave(groups, dim=-3)
            value = value.repeat_interleave(groups, dim=-3)
            enable_gqa = False
        return original(query, key, value, attn_mask=attn_mask, dropout_p=dropout_p,
                        is_causal=is_causal, scale=scale, enable_gqa=enable_gqa)

    functional.scaled_dot_product_attention = attention
    try:
        yield "sageattention-2.2" if sage is not None else "pytorch-sdpa"
    finally:
        functional.scaled_dot_product_attention = original
