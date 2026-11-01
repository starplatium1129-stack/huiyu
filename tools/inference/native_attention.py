"""Task-scoped attention dispatch using installed Sage, Kitchen or PyTorch.

Sage/Kitchen use the local Comfy kernels; masked/causal calls retain the existing
dispatch restrictions. Model placement and weight precision stay with the owner.
"""
from contextlib import contextmanager
import importlib.util

_DISPATCHERS = {}


def _dispatcher(original, sage, kitchen, compile_safe):
    key = (original, sage, kitchen, compile_safe)
    if key in _DISPATCHERS:
        return _DISPATCHERS[key]
    import torch
    # Trace the surrounding MOSS block, while the reviewed Sage kernel owns its
    # Triton dispatch. Reuse this callable across jobs to keep Dynamo guards
    # stable instead of replacing a global function on every new request.
    sage_kernel = torch.compiler.disable(sage) if sage is not None and compile_safe else sage
    kitchen_kernel = torch.compiler.disable(kitchen) if kitchen is not None and compile_safe else kitchen

    def attention(query, key, value, attn_mask=None, dropout_p=0.0, is_causal=False,
                  *, scale=None, enable_gqa=False):
        if attn_mask is not None:
            unmasked = attn_mask.all() if attn_mask.dtype == torch.bool else (attn_mask == 0).all()
            if bool(unmasked):
                attn_mask = None
        if (kitchen_kernel is not None and query.device.type == "cuda" and attn_mask is None
                and dropout_p == 0 and not is_causal and query.dtype in (torch.float16, torch.bfloat16)
                and query.shape[-1] == 128):
            return kitchen_kernel(query, key, value, scale=scale)
        if (sage is not None and query.device.type == "cuda" and attn_mask is None
                and dropout_p == 0 and query.dtype in (torch.float16, torch.bfloat16)
                and (query.shape[-3] == key.shape[-3] or enable_gqa)
                and query.shape[-1] <= 128 and (not is_causal or query.shape[-2] == key.shape[-2])):
            return sage_kernel(query, key, value, tensor_layout="HND", is_causal=is_causal, sm_scale=scale)
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

    _DISPATCHERS[key] = attention
    return attention


@contextmanager
def inference_attention(enabled, *, compile_safe=False, moss_int8=False):
    if not enabled:
        yield "default"
        return
    from torch.nn import functional as functional
    original = functional.scaled_dot_product_attention
    sage = None
    if importlib.util.find_spec("sageattention") is not None:
        from sageattention import sageattn
        sage = sageattn
    kitchen = None
    if moss_int8:
        import torch
        import comfy_kitchen
        if comfy_kitchen.int8_attention_is_available(torch.device("cuda:0")):
            kitchen = comfy_kitchen.int8_attention
    attention = _dispatcher(original, sage, kitchen, compile_safe)
    functional.scaled_dot_product_attention = attention
    try:
        yield "comfy-kitchen-int8" if kitchen is not None else "sageattention-2.2" if sage is not None else "pytorch-sdpa"
    finally:
        functional.scaled_dot_product_attention = original
