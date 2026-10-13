"""Explicit, pinned Cosmos execution modes; LoRA fusion is separately opt-in."""
import importlib.metadata
import importlib.util
import os
from collections import namedtuple
from contextlib import contextmanager
from pathlib import Path

MODE = os.environ.get("HUIYU_INFERENCE_ACCELERATION", "native")
PINS = {"sageattention": "2.2.0+cu128torch2.8.0.post3", "triton-windows": "3.4.0.post21"}
TEXT_KV_REVISION = "cosmos-text-kv128-v1"
TEXT_KV_LIMIT = 128 * 1024 * 1024
_ProjectedKV = namedtuple("_ProjectedKV", "key value")


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
    import torch
    from diffusers.models.attention_dispatch import attention_backend
    if mode != "native" and torch.cuda.get_device_capability(0) != (8, 9):
        raise ValueError("This Sage candidate requires the validated Ada SM89 device family")
    original = transformer.forward

    def forward(*args, **kwargs):
        # Only Cosmos: the conditioner has masks unsupported by this backend.
        with attention_backend("sage"):
            return original(*args, **kwargs)

    if mode != "native":
        transformer.forward = forward
    if mode == "compiled-fused-sage":
        # -I workers load only a bundled sibling. The resident applies fusion
        # after LoRA loading and restores it before changing adapters/scales.
        spec = importlib.util.spec_from_file_location("huiyu_anima_lora_fusion", Path(__file__).with_name("anima_lora_fusion.py"))
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        transformer._huiyu_lora_fusion = helper.LoraFusionState()
    for block in transformer.transformer_blocks:
        original_block = block.forward
        if mode in ("compiled-sage", "compiled-fused-sage"):
            # TeaCache later wraps this callable, not a compiled Tea decision.
            # The PEFT modules remain in place; Dynamo guards the fused branch
            # or the original active adapters/scales before reusing its graph.
            original_block = torch.compile(original_block, fullgraph=False, mode="default")
        block.forward = _block_with_text_kv(transformer, block.attn2, original_block)


def _project_kv(attn, encoder):
    key = attn.to_k(encoder).unflatten(2, (attn.heads, -1)).transpose(1, 2)
    value = attn.to_v(encoder).unflatten(2, (attn.heads, -1)).transpose(1, 2)
    return _ProjectedKV(attn.norm_k(key), value)


def _block_with_text_kv(model, attn, original):
    import torch
    def forward(hidden, encoder, *args, **kwargs):
        cache = getattr(model, "_huiyu_text_kv_cache", None)
        source = encoder
        if cache is not None:
            encoder = cache.project(attn, encoder)
        # Only Tensor/tuple inputs reach the compiled callable. Mutable cache
        # state, encoder identity/version and counters stay outside its graph.
        try:
            return original(hidden, encoder, *args, **kwargs)
        except torch.cuda.OutOfMemoryError:
            if cache is None or not cache.bytes:
                raise
            # Pinned ordinary Cosmos blocks do not mutate their input, weights
            # or RNG in inference. Drop optional K/V and retry this block once;
            # leave the handler before retrying so its tensor traceback retires.
            cache.disable("allocation-failed")
        encoder = source
        return original(hidden, encoder, *args, **kwargs)
    return forward


class _TextKVCache:
    """One job, at most two owned text inputs, with a fixed two-lane reservation.

    Pinned Anima conditioning is immutable during denoising; parameters/LoRA
    change only between jobs. Identity plus version rejects in-place edits and
    never mistakes recycled addresses or different CFG inputs for a cache hit.
    """
    def __init__(self, pipeline, data):
        self.model = pipeline.transformer
        self.reason = ("hires" if data.get("hiresFix") else
                       "large-image" if data["width"] * data["height"] > 1024 * 1024 else
                       "offload" if pipeline._huiyu_memory.policy != "resident" else "eligible")
        if self.reason == "eligible" and (self.model.config.use_crossattn_projection or
                any(type(block.attn2.processor) is not _CosmosProcessor or block.img_context
                    or block.before_proj is not None or block.after_proj is not None
                    for block in self.model.transformer_blocks)):
            self.reason = "unsupported-transformer"
        self.lanes, self.entries, self.slot_bytes = [], {}, {}
        self.selected = False
        self.hits = self.projections = self.bytes = self.peak_bytes = self.selected_blocks = 0

    def clear(self):
        self.lanes.clear()
        self.entries.clear()
        self.slot_bytes.clear()
        self.bytes = 0

    def disable(self, reason):
        self.clear()
        self.reason = reason

    def project(self, attn, encoder):
        import torch
        if self.reason != "eligible":
            return encoder
        if (torch.is_grad_enabled() or not isinstance(encoder, torch.Tensor)
                or encoder.ndim != 3 or encoder.device.type != "cuda"):
            self.disable("unsupported-input")
            return encoder
        try:
            version = encoder._version
        except RuntimeError:  # Inference tensors have no mutation counter.
            self.disable("untracked-input")
            return encoder
        for lane, (source, previous) in enumerate(self.lanes):
            if source is encoder:
                if previous != version:
                    self.disable("conditioning-changed")
                    return encoder
                break
        else:
            if len(self.lanes) == 2:
                self.disable("conditioning-changed")
                return encoder
            lane = len(self.lanes)
            self.lanes.append((encoder, version))
        if not self.selected:
            # Select whole blocks before filling either CFG branch. A large
            # model gets a stable subset, never a first-branch-only cache.
            reserved = 0
            for block in self.model.transformer_blocks:
                cross = block.attn2
                size = encoder.shape[0] * encoder.shape[1] * encoder.element_size() * (
                    cross.to_k.out_features + cross.to_v.out_features)
                if reserved + 2 * size <= TEXT_KV_LIMIT:
                    self.entries[cross] = [None, None]
                    self.slot_bytes[cross] = size
                    reserved += 2 * size
            self.selected_blocks = len(self.entries)
            self.selected = True
        if attn not in self.entries:
            return encoder
        cached = self.entries[attn][lane]
        if cached is not None:
            self.hits += 1
            return cached
        expected_size = encoder.shape[0] * encoder.shape[1] * encoder.element_size() * (
            attn.to_k.out_features + attn.to_v.out_features)
        if expected_size > self.slot_bytes[attn]:
            self.disable("unsupported-input")
            return encoder
        try:
            result = _project_kv(attn, encoder)
        except torch.cuda.OutOfMemoryError:
            # Only this optional cache may fall back. Releasing its live tensors
            # makes room for the original block; other CUDA failures propagate.
            self.disable("allocation-failed")
            return encoder
        size = sum(tensor.numel() * tensor.element_size() for tensor in result)
        if size > self.slot_bytes[attn]:
            self.disable("unsupported-input")
            return encoder
        self.entries[attn][lane] = result
        self.projections += 1
        self.bytes += size
        self.peak_bytes = max(self.peak_bytes, self.bytes)
        return result

    def report(self):
        return dict(executionRevision=TEXT_KV_REVISION, reason=self.reason,
                    maxBytes=TEXT_KV_LIMIT, peakBytes=self.peak_bytes, retainedBytes=self.bytes,
                    selectedBlocks=self.selected_blocks, projectionPairs=self.projections, hits=self.hits)


@contextmanager
def text_kv_session(pipeline, data):
    model = pipeline.transformer
    if getattr(model, "_huiyu_text_kv_cache", None) is not None:
        raise RuntimeError("Text K/V cache sessions cannot overlap")
    cache = _TextKVCache(pipeline, data)
    model._huiyu_text_kv_cache = cache
    try:
        yield cache
    finally:
        model._huiyu_text_kv_cache = None
        cache.clear()
        pipeline._huiyu_text_kv_report = cache.report()


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
        query = attn.to_q(hidden_states).unflatten(2, (attn.heads, -1)).transpose(1, 2)
        if isinstance(encoder_hidden_states, _ProjectedKV):
            key, value = encoder_hidden_states
            query = attn.norm_q(query)
        else:
            encoder = hidden_states if encoder_hidden_states is None else encoder_hidden_states
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
