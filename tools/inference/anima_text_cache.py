"""Bounded CPU snapshots of pinned Anima Qwen/T5 outputs, never conditioned states.

Integration: Apache-2.0 Diffusers 0.41.0 AnimaTextEncoderStep.
https://github.com/huggingface/diffusers/blob/v0.41.0/src/diffusers/modular_pipelines/anima/encoders.py
"""
from collections import OrderedDict


class TextCache:
    def __init__(self, max_entries=4, max_bytes=16 * 1024 * 1024):
        self.max_entries, self.max_bytes = max_entries, max_bytes
        self.entries = OrderedDict()
        self.bytes = 0
        self.begin_job()

    def begin_job(self):
        self.hits = self.misses = 0

    def clear(self):
        self.entries.clear()
        self.bytes = 0
        self.begin_job()

    def get(self, key, device):
        item = self.entries.get(key)
        if item is None:
            self.misses += 1
            return None
        self.hits += 1
        self.entries.move_to_end(key)
        return {name: value.to(device=device).clone() if value is not None else None
                for name, value in item[0].items()}

    def put(self, key, values):
        size = sum(value.numel() * value.element_size() for value in values.values() if value is not None)
        if size > self.max_bytes:
            return
        snapshots = {name: value.detach().to(device="cpu").clone() if value is not None else None
                     for name, value in values.items()}
        previous = self.entries.pop(key, None)
        self.bytes -= previous[1] if previous else 0
        while self.entries and (len(self.entries) >= self.max_entries or self.bytes + size > self.max_bytes):
            _, (_, removed) = self.entries.popitem(last=False)
            self.bytes -= removed
        self.entries[key] = (snapshots, size)
        self.bytes += size

    def stats(self):
        return dict(hits=self.hits, misses=self.misses, entries=len(self.entries), cpuBytes=self.bytes)


def apply_text_cache(blocks, cache):
    import torch
    from diffusers.modular_pipelines.anima.encoders import AnimaTextEncoderStep

    class CachedEncoder(AnimaTextEncoderStep):
        @torch.no_grad()
        def __call__(self, components, state):
            block = self.get_block_state(state)
            self.check_inputs(block)
            # Product requests are single strings; retain stock handling of lists.
            if not isinstance(block.prompt, str) or not isinstance(block.negative_prompt, (str, type(None))):
                return super().__call__(components, state)
            device = components._execution_device
            key = (block.prompt, block.negative_prompt, block.max_sequence_length,
                   components.guider.num_conditions > 1, str(components.text_encoder.dtype), str(device))
            values = cache.get(key, device)
            if values is None:
                components, state = super().__call__(components, state)
                values = {output.name: state.get(output.name) for output in self.intermediate_outputs}
                cache.put(key, values)
            else:
                for name, value in values.items():
                    setattr(block, name, value)
                self.set_block_state(state, block)
            return components, state

    blocks.sub_blocks["text_encoder"] = CachedEncoder()
    return blocks
