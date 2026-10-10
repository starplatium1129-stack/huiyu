"""Explicit loading-info fakes; no real model, Torch or GPU acceptance."""
from pathlib import Path
import types
from unittest.mock import patch

import worker


def assert_local_loader_contract(test):
    calls, updates, transfers = [], [], []
    reports = {}

    class Component:
        @classmethod
        def from_pretrained(cls, path, **kwargs):
            name = Path(path).name
            calls.append((name, kwargs))
            info = reports.get(name, {})
            # Mirrors upstream's optional report contract, including its old
            # warning-only return of a model with missing required parameters.
            return (cls(), info) if kwargs.get("output_loading_info") else cls()

    class Pipeline:
        def update_components(self, **kwargs):
            updates.append(kwargs)
            self.components = kwargs
        def to(self, device):
            transfers.append(device)
            self.device = device
        def set_progress_bar_config(self, **kwargs):
            pass

    diffusers = types.SimpleNamespace(AnimaModularPipeline=Pipeline, AnimaTextConditioner=Component,
        AutoencoderKLQwenImage=Component, CosmosTransformer3DModel=Component,
        FlowMatchEulerDiscreteScheduler=Component, ClassifierFreeGuidance=lambda **kw: kw)
    transformers = types.SimpleNamespace(Qwen3Model=Component, Qwen2Tokenizer=Component,
        T5Tokenizer=Component, T5TokenizerFast=Component)
    torch = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: True,
        is_bf16_supported=lambda: True), bfloat16="bf16")
    with patch.dict("sys.modules", {"torch": torch, "diffusers": diffusers, "transformers": transformers}):
        for name, field, values in (
                ("text_encoder", "missing_keys", {"layers.0.self_attn.q_proj.weight"}),
                ("text_conditioner", "missing_keys", ["proj.weight"]),
                ("transformer", "mismatched_keys", [("proj.weight", (1,), (2,))]),
                ("vae", "error_msgs", ["synthetic loader error"])):
            reports.clear()
            reports[name] = {field: values}
            calls.clear()
            with test.assertRaisesRegex(ValueError, f"{name}.*{field}"):
                worker.load_pipeline(Path("/local-model"), 5.0)
            test.assertEqual(calls[-1][0], name)
            test.assertEqual(updates, [], "incomplete weights must not reach pipeline components")
            test.assertEqual(transfers, [], "incomplete weights must fail before CUDA transfer")
        reports.clear()
        reports["text_encoder"] = {"missing_keys": set(), "mismatched_keys": set(),
                                   "error_msgs": [], "unexpected_keys": {"lm_head.weight"}}
        calls.clear()
        pipeline = worker.load_pipeline(Path("/local-model"), 5.0)
    test.assertEqual(pipeline.components["guider"], {"guidance_scale": 5.0})
    test.assertEqual(pipeline.device, "cuda")
    test.assertEqual(len(calls), 7)
    for name, kwargs in calls:
        test.assertTrue(kwargs["local_files_only"])
        test.assertIsInstance(pipeline.components[name], Component)
        if name in worker.WEIGHTS:
            test.assertTrue(kwargs["use_safetensors"])
            test.assertEqual(kwargs["torch_dtype"], "bf16")
            test.assertTrue(kwargs["output_loading_info"])
        else:
            test.assertNotIn("output_loading_info", kwargs)
            test.assertNotIn("use_safetensors", kwargs)
        if name in ("text_encoder", "tokenizer", "t5_tokenizer"):
            test.assertFalse(kwargs["trust_remote_code"])
