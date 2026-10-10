"""Explicit CPU NumPy tensors test cache semantics, not real Anima inference."""
import types
import unittest
from unittest.mock import patch
import numpy as np

import anima_text_cache as text


class Tensor(np.ndarray):
    def __new__(cls, value, dtype=np.float32, device="cpu"):
        result = np.asarray(value, dtype=dtype).view(cls)
        result._device = device
        return result
    def __array_finalize__(self, source):
        self._device = getattr(source, "_device", "cpu")
    @property
    def device(self): return self._device
    def detach(self): return self
    def clone(self): return self.copy()
    def copy(self, order="K"): return super().copy(order=order)
    def to(self, device=None, copy=False):
        # Explicit fake device transfer: CPU storage only, including the CUDA label.
        device = self.device if device is None else str(device)
        if copy or device != self.device:
            result = self.copy()
            result._device = device
            return result
        return self
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
    qwen_calls, t5_calls = [], []
    intermediate_outputs = [types.SimpleNamespace(name=name) for name in FIELDS]
    def get_block_state(self, state):
        return types.SimpleNamespace(**{name: state.get(name) for name in ("prompt", "negative_prompt", "max_sequence_length")})
    def set_block_state(self, state, block):
        for name in FIELDS: state.values[name] = getattr(block, name)
    def check_inputs(self, block):
        if not isinstance(block.prompt, (str, list)): raise ValueError("prompt must be a string or list")
        if block.max_sequence_length is not None and block.max_sequence_length > 4096:
            raise ValueError("max_sequence_length exceeds 4096")
    @staticmethod
    def _get_qwen_prompt_embeds(components, prompt, max_sequence_length, device, dtype):
        Encoder.qwen_calls.append(list(prompt))
        return (Tensor([[len(value), sum(map(ord, value))] for value in prompt], dtype, device),
                Tensor([[1, 1] for _ in prompt], np.int64, device))
    @staticmethod
    def _get_t5_prompt_ids(components, prompt, max_sequence_length, device):
        Encoder.t5_calls.append(list(prompt))
        return (Tensor([[sum(map(ord, value)), max_sequence_length] for value in prompt], np.int64, device),
                Tensor([[1, 1] for _ in prompt], np.int64, device))
    @classmethod
    def encode_prompt(cls, components, prompt, negative_prompt=None, prepare_unconditional_embeds=True,
                      max_sequence_length=512, device=None, dtype=None):
        # Pinned 0.41.0 contract: positive and negative invoke Qwen/T5 separately.
        Encoder.calls += 1
        device, dtype = device or components._execution_device, dtype or components.text_encoder.dtype
        prompt = [prompt] if isinstance(prompt, str) else prompt
        values = dict.fromkeys(FIELDS)
        def encode(text, fields):
            outputs = (*cls._get_qwen_prompt_embeds(components, text, max_sequence_length, device, dtype),
                       *cls._get_t5_prompt_ids(components, text, max_sequence_length, device))
            values.update(zip(fields, outputs))
        encode(prompt, FIELDS[:4])
        if prepare_unconditional_embeds:
            negative_prompt = negative_prompt if negative_prompt is not None else ""
            negative_prompt = len(prompt) * [negative_prompt] if isinstance(negative_prompt, str) else negative_prompt
            if type(prompt) is not type(negative_prompt): raise TypeError("prompt types differ")
            if len(prompt) != len(negative_prompt): raise ValueError("prompt batch sizes differ")
            encode(negative_prompt, FIELDS[4:])
        return values
    def __call__(self, components, state):
        block = self.get_block_state(state)
        self.check_inputs(block)
        values = self.encode_prompt(components, block.prompt, block.negative_prompt,
            components.guider.num_conditions > 1, block.max_sequence_length,
            components._execution_device, components.text_encoder.dtype)
        for name, value in values.items(): setattr(block, name, value)
        self.set_block_state(state, block)
        return components, state


class Blocks:
    def __init__(self): self.sub_blocks = {"text_encoder": Encoder()}


def modules():
    return {"torch": types.SimpleNamespace(no_grad=lambda: lambda fn: fn),
            "diffusers.modular_pipelines.anima.encoders": types.SimpleNamespace(AnimaTextEncoderStep=Encoder),
            "diffusers.modular_pipelines.anima.modular_blocks_anima": types.SimpleNamespace(AnimaAutoBlocks=Blocks)}


class TextTests(unittest.TestCase):
    def test_put_and_get_each_make_one_independent_copy(self):
        for device, dtype in (("cpu", np.float16), ("cuda", np.float16), ("cpu", np.int64), ("cuda", np.int64)):
            with self.subTest(fake_device=device, dtype=dtype):
                cache = text.TextCache()
                original = Tensor([[1, 2, 3], [4, 5, 6]], dtype, device).T
                with patch.object(Tensor, "copy", autospec=True, side_effect=Tensor.copy) as copies, \
                        patch.object(Tensor, "detach", autospec=True, side_effect=Tensor.detach) as detach:
                    cache.put("sample", {"embedding": original, "negative": None})
                    self.assertEqual(copies.call_count, 1)
                    detach.assert_called_once()
                snapshot = cache.entries["sample"][0]["embedding"]
                self.assertEqual(snapshot.device, "cpu")
                original[0, 0] = -1
                with patch.object(Tensor, "copy", autospec=True, side_effect=Tensor.copy) as copies:
                    result = cache.get("sample", device)
                    self.assertEqual(copies.call_count, 1)
                returned = result["embedding"]
                self.assertEqual((returned.device, returned.dtype, returned.strides), (device, original.dtype, original.strides))
                self.assertEqual(returned[0, 0], 1)
                self.assertFalse(np.shares_memory(original, snapshot))
                self.assertFalse(np.shares_memory(returned, snapshot))
                returned[0, 0] = -2
                self.assertEqual(cache.get("sample", device)["embedding"][0, 0], 1)
                self.assertIsNone(result["negative"])

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
            np.testing.assert_array_equal(second.qwen_prompt_embeds, [[6, 642]])
            second.qwen_prompt_embeds[0] = -456
            np.testing.assert_array_equal(run(seed=3).qwen_prompt_embeds, [[6, 642]])
            self.assertEqual(cache.stats()["hits"], 1)
            run(negative="changed")
            components.guider.num_conditions = 1
            self.assertIsNone(run().negative_qwen_prompt_embeds)
            components.text_encoder.dtype = np.float16
            run()
            self.assertEqual(Encoder.calls, 4)

    def test_negative_partial_reuse_preserves_outputs_independence_pair_counts_and_lru(self):
        cache, blocks = text.TextCache(), Blocks()
        components = types.SimpleNamespace(_execution_device="cuda", text_encoder=types.SimpleNamespace(dtype=np.float16),
                                           guider=types.SimpleNamespace(num_conditions=2))
        def run(prompt, negative="N", encoder=None):
            cache.begin_job()
            state = State(prompt=prompt, negative_prompt=negative, max_sequence_length=512)
            (encoder or blocks.sub_blocks["text_encoder"])(components, state)
            return state
        with patch.dict("sys.modules", modules()):
            text.apply_text_cache(blocks, cache)
            expected = run("P2", encoder=Encoder())
            Encoder.qwen_calls, Encoder.t5_calls = [], []
            first = run("P1")
            with patch.object(Tensor, "to", autospec=True, side_effect=Tensor.to) as transfers:
                second = run("P2")
            routes = [(call.args[0].device, call.kwargs["device"]) for call in transfers.call_args_list]
            self.assertEqual(routes.count(("cpu", "cuda")), 4)
            self.assertEqual(routes.count(("cuda", "cpu")), 4)  # Fresh positive snapshots only.
            self.assertEqual(len(routes), 8)
            self.assertEqual(Encoder.qwen_calls, [["P1"], ["N"], ["P2"]])
            self.assertEqual(Encoder.t5_calls, Encoder.qwen_calls)
            self.assertEqual((cache.hits, cache.misses, len(cache.entries)), (0, 1, 2))
            snapshots = [item[0] for item in cache.entries.values()]
            for name in FIELDS[4:]: self.assertIs(snapshots[0][name], snapshots[1][name])
            pair_bytes = sum(second.get(name).numel() * second.get(name).element_size() for name in FIELDS)
            self.assertEqual(cache.bytes, 2 * pair_bytes)  # Shared storage still counts once per pair.
            for name in FIELDS:
                actual = second.get(name)
                np.testing.assert_array_equal(actual, expected.get(name))
                self.assertEqual((actual.device, actual.dtype), ("cuda", expected.get(name).dtype))
                for snapshots, _ in cache.entries.values():
                    self.assertFalse(np.shares_memory(actual, snapshots[name]))
                self.assertFalse(np.shares_memory(actual, first.get(name)))
                actual[:] = -123
            # A full pair hit neither re-encodes nor returns the mutated prior outputs.
            repeated = run("P2")
            for name in FIELDS: np.testing.assert_array_equal(repeated.get(name), expected.get(name))
            self.assertEqual((cache.hits, cache.misses, len(Encoder.qwen_calls)), (1, 0, 3))
            run("P3", "other")
            run("P4", "different")
            before = list(cache.entries)
            self.assertEqual(len(before), 4)
            oldest = cache.entries[before[0]][0]
            run("P5")  # Reusing the oldest pair's negative must not refresh that pair.
            self.assertEqual(list(cache.entries)[:-1], before[1:])
            newest = next(reversed(cache.entries.values()))[0]
            for name in FIELDS[4:]: self.assertIs(newest[name], oldest[name])
            self.assertEqual((cache.hits, cache.misses, len(cache.entries)), (0, 1, 4))
            self.assertEqual(cache.bytes, sum(size for _, size in cache.entries.values()))
            self.assertLessEqual(cache.bytes, 16 * 1024 * 1024)
            after_eviction = run("P5")
            for name in FIELDS[4:]: np.testing.assert_array_equal(after_eviction.get(name), expected.get(name))

    def test_partial_reuse_respects_all_key_fields_and_stock_list_fallback(self):
        changes = ({"negative": "different"}, {"conditions": 1}, {"length": 128},
                   {"dtype": np.float16}, {"device": "cuda"}, {"negative": None})
        for change in changes:
            with self.subTest(change=change), patch.dict("sys.modules", modules()):
                cache, blocks = text.TextCache(), Blocks()
                components = types.SimpleNamespace(_execution_device="cpu", text_encoder=types.SimpleNamespace(dtype=np.float32),
                                                   guider=types.SimpleNamespace(num_conditions=2))
                text.apply_text_cache(blocks, cache)
                encoder = blocks.sub_blocks["text_encoder"]
                encoder(components, State(prompt="P1", negative_prompt="", max_sequence_length=512))
                components._execution_device = change.get("device", "cpu")
                components.text_encoder.dtype = change.get("dtype", np.float32)
                components.guider.num_conditions = change.get("conditions", 2)
                Encoder.qwen_calls, Encoder.t5_calls = [], []
                state = State(prompt="P2", negative_prompt=change.get("negative", ""),
                              max_sequence_length=change.get("length", 512))
                encoder(components, state)
                expected = [["P2"]] + ([] if components.guider.num_conditions == 1 else [[change.get("negative") or ""]])
                self.assertEqual(Encoder.qwen_calls, expected)
                self.assertEqual(Encoder.t5_calls, expected)
                if components.guider.num_conditions == 1:
                    self.assertTrue(all(state.get(name) is None for name in FIELDS[4:]))
        with patch.dict("sys.modules", modules()):
            cache, blocks = text.TextCache(), Blocks()
            components.guider.num_conditions = 2
            text.apply_text_cache(blocks, cache)
            for prompt, negative in ((["P"], "N"), ("P", ["N"])):
                Encoder.qwen_calls = []
                blocks.sub_blocks["text_encoder"](components, State(prompt=prompt, negative_prompt=negative, max_sequence_length=512))
                self.assertEqual(Encoder.qwen_calls, [["P"], ["N"]])
                self.assertEqual((cache.hits, cache.misses, len(cache.entries)), (0, 0, 0))

    def test_partial_encode_failure_does_not_publish_outputs_or_insert_pair(self):
        cache, blocks = text.TextCache(), Blocks()
        components = types.SimpleNamespace(_execution_device="cuda", text_encoder=types.SimpleNamespace(dtype=np.float32),
                                           guider=types.SimpleNamespace(num_conditions=2))
        with patch.dict("sys.modules", modules()):
            text.apply_text_cache(blocks, cache)
            encoder = blocks.sub_blocks["text_encoder"]
            encoder(components, State(prompt="P1", negative_prompt="N", max_sequence_length=512))
            before, size = list(cache.entries), cache.bytes
            state = State(prompt="P2", negative_prompt="N", max_sequence_length=512)
            with patch.object(Encoder, "_get_qwen_prompt_embeds", side_effect=RuntimeError("encoder failed")):
                with self.assertRaisesRegex(RuntimeError, "encoder failed"): encoder(components, state)
            self.assertEqual((list(cache.entries), cache.bytes), (before, size))
            self.assertTrue(all(state.get(name) is None for name in FIELDS))
            saved = {name: value.copy() for name, value in cache.entries[before[0]][0].items()}
            original_to = Tensor.to
            def fail_snapshot(tensor, device=None, copy=False):
                if tensor.device == "cuda" and device == "cpu":
                    raise RuntimeError("snapshot failed")
                return original_to(tensor, device=device, copy=copy)
            with patch.object(Tensor, "to", autospec=True, side_effect=fail_snapshot):
                with self.assertRaisesRegex(RuntimeError, "snapshot failed"):
                    encoder(components, State(prompt="P2", negative_prompt="N", max_sequence_length=512))
            self.assertEqual((list(cache.entries), cache.bytes), (before, size))
            for name, value in cache.entries[before[0]][0].items(): np.testing.assert_array_equal(value, saved[name])

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
        first, second = ((prompt, "N", 512, True, "float32", "cuda") for prompt in ("P1", "P2"))
        cache.put(first, {"qwen_prompt_embeds": Tensor([1, 2], device="cuda"),
                          "negative_qwen_prompt_embeds": Tensor([3, 4], device="cuda")})
        source = cache.entries[first][0]["negative_qwen_prompt_embeds"]
        values = {"qwen_prompt_embeds": Tensor([5, 6], device="cuda"), **cache.get_negative(second, "cuda")}
        cache.put(second, values, reuse_negative=True)
        self.assertEqual(list(cache.entries), [second])  # Logical bytes evict even when storage is shared.
        self.assertEqual(cache.bytes, 16)
        self.assertIs(cache.entries[second][0]["negative_qwen_prompt_embeds"], source)
        escaped = cache.get(second, "cpu")["negative_qwen_prompt_embeds"]
        escaped[:] = -1
        np.testing.assert_array_equal(source, [3, 4])


if __name__ == "__main__": unittest.main()
