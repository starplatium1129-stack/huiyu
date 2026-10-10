"""Explicit CPU NumPy tensors test cache semantics, not real Anima inference."""
import types
import unittest
from unittest.mock import patch
import numpy as np

import anima_text_cache as text


class Tensor(np.ndarray):
    def __new__(cls, value, dtype=np.float32):
        return np.asarray(value, dtype=dtype).view(cls)
    def detach(self): return self
    def clone(self): return self.copy()
    def to(self, device=None): return self
    def numel(self): return self.size
    def element_size(self): return self.itemsize


FIELDS = ("qwen_prompt_embeds", "qwen_attention_mask", "t5_input_ids", "t5_attention_mask",
          "negative_qwen_prompt_embeds", "negative_qwen_attention_mask", "negative_t5_input_ids", "negative_t5_attention_mask")


class State:
    def __init__(self, **values): self.values = values
    def get(self, name): return self.values.get(name)
    def __getattr__(self, name): return self.values[name]


class Encoder:
    calls = 0
    intermediate_outputs = [types.SimpleNamespace(name=name) for name in FIELDS]
    def get_block_state(self, state):
        return types.SimpleNamespace(**{name: state.get(name) for name in ("prompt", "negative_prompt", "max_sequence_length")})
    def set_block_state(self, state, block):
        for name in FIELDS: state.values[name] = getattr(block, name)
    def check_inputs(self, block):
        if not isinstance(block.prompt, str): raise ValueError("fixture prompt must be a string")
    def __call__(self, components, state):
        Encoder.calls += 1
        block = self.get_block_state(state)
        for name in FIELDS:
            value = Tensor([len(block.prompt), 2], components.text_encoder.dtype)
            if name.startswith("negative_") and components.guider.num_conditions == 1: value = None
            setattr(block, name, value)
        self.set_block_state(state, block)
        return components, state


class Blocks:
    def __init__(self): self.sub_blocks = {"text_encoder": Encoder()}


def modules():
    return {"torch": types.SimpleNamespace(no_grad=lambda: lambda fn: fn),
            "diffusers.modular_pipelines.anima.encoders": types.SimpleNamespace(AnimaTextEncoderStep=Encoder),
            "diffusers.modular_pipelines.anima.modular_blocks_anima": types.SimpleNamespace(AnimaAutoBlocks=Blocks)}


class TextTests(unittest.TestCase):
    def test_seed_reuse_returns_independent_tensors_and_separates_cfg_dtype_and_text(self):
        cache, blocks = text.TextCache(), Blocks()
        Encoder.calls = 0
        components = types.SimpleNamespace(_execution_device="cpu", text_encoder=types.SimpleNamespace(dtype=np.float32),
                                           guider=types.SimpleNamespace(num_conditions=2))
        def run(prompt="sample", negative="", seed=1):
            cache.begin_job()
            state = State(prompt=prompt, negative_prompt=negative, max_sequence_length=512, seed=seed)
            blocks.sub_blocks["text_encoder"](components, state)
            return state
        with patch.dict("sys.modules", modules()):
            text.apply_text_cache(blocks, cache)
            first = run()
            first.qwen_prompt_embeds[0] = -123
            second = run(seed=2)
            self.assertEqual(Encoder.calls, 1)
            np.testing.assert_array_equal(second.qwen_prompt_embeds, [6, 2])
            second.qwen_prompt_embeds[0] = -456
            np.testing.assert_array_equal(run(seed=3).qwen_prompt_embeds, [6, 2])
            self.assertEqual(cache.stats()["hits"], 1)
            run(negative="changed")
            components.guider.num_conditions = 1
            self.assertIsNone(run().negative_qwen_prompt_embeds)
            components.text_encoder.dtype = np.float16
            run()
            self.assertEqual(Encoder.calls, 4)

    def test_capacity_byte_limit_lru_and_release(self):
        cache = text.TextCache(max_entries=2, max_bytes=16)
        values = {"embedding": Tensor([1, 2]), "negative": None}
        for key in ("first", "second"): cache.put(key, values)
        self.assertIsNotNone(cache.get("first", "cpu"))
        cache.put("third", values)
        self.assertIsNone(cache.get("second", "cpu"))
        cache.put("oversized", {"embedding": Tensor(np.ones(128))})
        self.assertEqual(cache.stats()["entries"], 2)
        self.assertEqual(cache.stats()["cpuBytes"], 16)
        cache.clear()
        self.assertEqual(cache.stats()["cpuBytes"], 0)
        self.assertIsNone(cache.get("first", "cpu"))


if __name__ == "__main__": unittest.main()
