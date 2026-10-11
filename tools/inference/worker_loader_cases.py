"""Explicit loading-info fakes; no real model, Torch or GPU acceptance."""
from pathlib import Path
import io
import json
import tempfile
import types
from unittest.mock import patch

import worker


def assert_local_model_layout(test, model):
    with tempfile.TemporaryDirectory() as directory:
        root = model(Path(directory))
        test.assertEqual(worker.validate_model(str(root)), root)
        scheduler = root / "scheduler" / "scheduler_config.json"
        supported = {"_class_name": "FlowMatchEulerDiscreteScheduler", "stochastic_sampling": False}
        scheduler.write_text(json.dumps(supported))
        test.assertEqual(worker.validate_model(str(root)), root)
        for config in ({**supported, "stochastic_sampling": True},
                       {**supported, "_class_name": "EulerDiscreteScheduler"}):
            scheduler.write_text(json.dumps(config))
            with test.assertRaisesRegex(worker.WorkerError, "deterministic FlowMatchEuler") as error:
                worker.validate_model(str(root))
            test.assertEqual(error.exception.code, "UNSUPPORTED_MODEL")
        scheduler.write_text(json.dumps(supported))
        (root / "t5_tokenizer" / "tokenizer.json").unlink()
        (root / "t5_tokenizer" / "spiece.model").write_bytes(b"FAKE SENTENCEPIECE")
        test.assertEqual(worker.validate_model(str(root)), root)
        (root / "transformer" / "model.safetensors.index.json").write_text('{"weight_map":{"x":"missing.safetensors"}}')
        with test.assertRaises(worker.WorkerError) as error:
            worker.validate_model(str(root))
        test.assertEqual(error.exception.code, "MODEL_INCOMPLETE")


def assert_local_loader_contract(test, model):
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
            self.transformer = kwargs["transformer"]
            self.text_encoder = kwargs["text_encoder"]
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
    with tempfile.TemporaryDirectory() as directory, \
            patch.object(worker.load_mask_tools("native_upload"), "try_packed_upload", return_value=False), \
            patch.object(worker.load_mask_tools("native_upload"), "configure_staged_upload"), \
            patch.dict("sys.modules", {
            "torch": torch, "diffusers": diffusers, "transformers": transformers}):
        root = model(Path(directory))
        test.assertEqual(worker.validate_model(str(root)), root)
        scheduler = root / "scheduler" / "scheduler_config.json"
        original = scheduler.read_text()
        scheduler.write_text(json.dumps({"_class_name": "FlowMatchEulerDiscreteScheduler", "stochastic_sampling": True}))
        with test.assertRaisesRegex(worker.WorkerError, "deterministic FlowMatchEuler") as error:
            worker.load_pipeline(root, 5.0)
        test.assertEqual(error.exception.code, "UNSUPPORTED_MODEL")
        test.assertEqual(calls, [], "changed config must fail before any component loads")
        test.assertEqual(updates, [])
        test.assertEqual(transfers, [])
        scheduler.write_text(original)
        for name, field, values in (
                ("text_encoder", "missing_keys", {"layers.0.self_attn.q_proj.weight"}),
                ("text_conditioner", "missing_keys", ["proj.weight"]),
                ("transformer", "mismatched_keys", [("proj.weight", (1,), (2,))]),
                ("vae", "error_msgs", ["synthetic loader error"])):
            reports.clear()
            reports[name] = {field: values}
            calls.clear()
            with test.assertRaisesRegex(ValueError, f"{name}.*{field}"):
                worker.load_pipeline(root, 5.0)
            test.assertEqual(calls[-1][0], name)
            test.assertEqual(updates, [], "incomplete weights must not reach pipeline components")
            test.assertEqual(transfers, [], "incomplete weights must fail before CUDA transfer")
        reports.clear()
        reports["text_encoder"] = {"missing_keys": set(), "mismatched_keys": set(),
                                   "error_msgs": [], "unexpected_keys": {"lm_head.weight"}}
        calls.clear()
        pipeline = worker.load_pipeline(root, 5.0)
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


def assert_lora_metadata_contract(test):
    keys = {f"transformer.layer.lora_{side}.weight" for side in "AB"}
    for extra, metadata in (({"text_encoder.layer.lora_A.weight"}, None),
                            ({"transformer.layer.dora_scale"}, None),
                            (set(), {"lora_adapter_metadata": '{"transformer.use_dora":true}'}),
                            (set(), {"lora_adapter_metadata": '{"unknown.r":4}'}),
                            *((set(), {"lora_adapter_metadata": value}) for value in (
                                '{"transformer.lora_alpha":NaN}',
                                '{"transformer.lora_alpha":Infinity}',
                                '{"transformer.lora_alpha":1e999}',
                                '{"transformer.alpha_pattern":{"layer":-Infinity}}'))):
        pipeline, calls, modules = test.lora_fakes(keys | extra, metadata)
        with test.subTest(extra=extra, metadata=metadata):
            with modules, test.assertRaises(worker.WorkerError) as error:
                worker.load_loras(pipeline, [{"path": "/models/style.safetensors", "strength": 1}])
            test.assertEqual(error.exception.code, "UNSUPPORTED_LORA")
            test.assertEqual(calls, [])
    pipeline, calls, modules = test.lora_fakes(keys, loaded_keys=set())
    with modules, test.assertRaises(worker.WorkerError):
        worker.load_loras(pipeline, [{"path": "/models/style.safetensors", "strength": 1}])
    test.assertEqual(len(calls), 1)  # Never activate a partially loaded adapter.


def assert_kohya_lora_contract(test):
    """CPU array fakes cover conversion math; no ML dependency or GPU is required."""
    import numpy as np
    helper = worker.load_mask_tools("anima_lora")

    class Tensor(np.ndarray):
        device = types.SimpleNamespace(type="cpu")
        def __new__(cls, value):
            return np.array(value, dtype=np.float32).view(cls)
        def float(self):
            return self.astype(np.float32)

    class Linear:
        in_features, out_features = 2, 3

    class Component:
        transformer_blocks = [None]
        def __init__(self, target):
            self.target = target
        def get_submodule(self, name):
            if name != self.target:
                raise AttributeError(name)
            return Linear()
        def named_modules(self):
            return [(self.target, Linear())]

    transformer = "transformer_blocks.0.attn2.to_k"
    conditioner = "blocks.0.cross_attn.k_proj"
    pipeline = types.SimpleNamespace(transformer=Component(transformer), text_conditioner=Component(conditioner))
    raw_targets = {"diffusion_model.blocks.0.cross_attn.k_proj": "transformer." + transformer,
                   "diffusion_model.llm_adapter." + conditioner: "text_conditioner." + conditioner}
    def remap(state):
        return {raw_targets.get(key.removesuffix(".lora_A.weight"), "transformer.unsupported") + ".lora_A.weight": value
                for key, value in state.items()}

    aliases = ["lora_unet_blocks_0_cross_attn_k_proj", "lora_unet_llm_adapter_blocks_0_cross_attn_k_proj"]
    weights = {f"{alias}.{part}": Tensor(value) for alias in aliases for part, value in (
        ("alpha", 1.0), ("lora_down.weight", [[1, 2], [3, 4]]), ("lora_up.weight", [[2, 3], [4, 5], [6, 7]]))}

    class File:
        def keys(self):
            return weights.keys()
        def metadata(self):
            return {}
        def get_tensor(self, key):
            return weights[key]

    fake_torch = types.SimpleNamespace(nn=types.SimpleNamespace(Linear=Linear),
        float16=np.dtype("float16"), bfloat16="bf16", float32=np.dtype("float32"), isfinite=np.isfinite)
    with patch.dict("sys.modules", {"torch": fake_torch,
            "diffusers.loaders.lora_conversion_utils": types.SimpleNamespace(_convert_non_diffusers_anima_lora_to_diffusers=remap)}):
        converted = helper.load_kohya(File(), pipeline)
        for alias, target in zip(aliases, ("transformer." + transformer, "text_conditioner." + conditioner)):
            np.testing.assert_array_equal(converted[target + ".lora_B.weight"] @ converted[target + ".lora_A.weight"],
                (weights[alias + ".lora_up.weight"] @ weights[alias + ".lora_down.weight"]) * 0.5)
            np.testing.assert_array_equal(weights[alias + ".lora_up.weight"], [[2, 3], [4, 5], [6, 7]])
        key = aliases[0] + ".alpha"
        valid = weights[key]
        for value in (Tensor(float("nan")), Tensor(-1), Tensor([1, 2])):
            weights[key] = value
            with test.assertRaises(ValueError):
                helper.load_kohya(File(), pipeline)
        weights[key] = valid
        del weights[key]
        with test.assertRaisesRegex(ValueError, "Incomplete"):
            helper.load_kohya(File(), pipeline)
        weights[key] = valid
        key = aliases[0] + ".lora_down.weight"
        valid = weights[key]
        for value in (Tensor([[1, 2, 3]]), Tensor([[float("inf"), 0], [0, 1]])):
            weights[key] = value
            with test.assertRaises(ValueError):
                helper.load_kohya(File(), pipeline)
        weights[key] = valid
        weights["lora_unet_unknown.alpha"] = Tensor(1)
        with test.assertRaisesRegex(ValueError, "unknown"):
            helper.load_kohya(File(), pipeline)
        del weights["lora_unet_unknown.alpha"]
        with patch.object(File, "metadata", return_value={"lora_adapter_metadata": "{}"}), test.assertRaises(ValueError):
            helper.load_kohya(File(), pipeline)

    raw = {aliases[0] + suffix for suffix in (".alpha", ".lora_down.weight", ".lora_up.weight")}
    native = {f"transformer.layer.lora_{side}.weight": object() for side in "AB"}
    pipeline, calls, modules = test.lora_fakes(raw, loaded_keys=set(native))
    with modules, patch.object(worker.load_mask_tools("anima_lora"), "load_kohya", return_value=native):
        worker.load_loras(pipeline, [{"path": "/models/kohya.safetensors", "strength": 0.6}])
    test.assertIs(calls[0][0], native)
    test.assertNotIn("weight_name", calls[0][1])
    test.assertEqual(calls[1], (["huiyu_0"], {"adapter_weights": [0.6]}))


def assert_diagnosis_requires_cosmos_resize_dependency(test):
    def version(name):
        if name == "torchvision":
            raise worker.importlib.metadata.PackageNotFoundError(name)
        return worker.PINS[name]
    with patch.object(worker.importlib.metadata, "version", side_effect=version):
        with test.assertRaises(worker.WorkerError) as caught:
            worker.dependencies()
        test.assertEqual(caught.exception.code, "DEPENDENCY_MISSING")
        test.assertIn("torchvision", str(caught.exception))
    with patch.object(worker.importlib.metadata, "version", side_effect=lambda name: worker.PINS[name]), \
            patch.dict("sys.modules", {"torch": types.SimpleNamespace(), "torchvision": None}):
        with test.assertRaises(worker.WorkerError) as caught:
            worker.dependencies()
        test.assertEqual(caught.exception.code, "DEPENDENCY_IMPORT")


def assert_protected_resident_reuses_identity_and_releases_on_clear(test):
    lease = worker.load_mask_tools("locked_identity").IdentityLease()
    if lease._windows is None:
        test.skipTest("Windows read protection")
    with test.resident_fixture() as f:
        f.resident.file_identity = lease
        worker.generate(f.request, io.StringIO(), resident=f.resident)
        test.assertTrue(lease.cached)
        test.assertTrue(lease.reused)
        with test.assertRaises(OSError):
            f.path.write_bytes(b"CANNOT CHANGE RESIDENT WEIGHTS")
        worker.generate(f.request, io.StringIO(), resident=f.resident)
        test.assertEqual(len(f.loaded), 1)
        f.resident.clear()
        f.path.write_bytes(b"CAN REPLACE AFTER RELEASE")


def assert_transient_membership_during_protected_load_is_rejected(test):
    lease = worker.load_mask_tools("locked_identity").IdentityLease()
    if lease._windows is None:
        test.skipTest("Windows read protection")
    with test.resident_fixture() as f:
        f.resident.file_identity = lease
        original = f.adapters.side_effect
        def changed(*args):
            original(*args)
            transient = f.root / "transformer" / "transient.json"
            transient.write_text("{}")
            transient.unlink()
        f.adapters.side_effect = changed
        with test.assertRaises(worker.WorkerError) as error:
            worker.generate(f.request, io.StringIO(), resident=f.resident)
        test.assertEqual(error.exception.code, "MODEL_CHANGED")
        test.assertFalse(lease.cached)


def assert_lora_local_safe_load_scales_both_components(test):
    keys = {f"{component}.layer.lora_{side}.weight" for component in ("transformer", "text_conditioner") for side in "AB"}
    metadata = {"lora_adapter_metadata": '{"transformer.r":4,"text_conditioner.r":4,"transformer.lora_dropout":0.25,"text_conditioner.lora_dropout":0.25,"transformer.lora_alpha":8,"transformer.alpha_pattern":{"layer":4}}'}
    pipeline, calls, modules = test.lora_fakes(keys, metadata)
    with modules:
        worker.load_loras(pipeline, [{"path": "/models/style.safetensors", "strength": 0.6},
                                     {"path": "/models/second.safetensors", "strength": -0.2}])
    test.assertEqual(calls[0], (str(Path("/models")), {"weight_name": "style.safetensors", "adapter_name": "huiyu_0", "local_files_only": True, "use_safetensors": True}))
    test.assertEqual(calls[1][1]["adapter_name"], "huiyu_1")
    test.assertEqual(calls[2], (["huiyu_0", "huiyu_1"], {"adapter_weights": [0.6, -0.2]}))
    for component in (pipeline.transformer, pipeline.text_conditioner):
        test.assertFalse(component.training)
        test.assertEqual(set(component.adapters), {"huiyu_0", "huiyu_1"})
        for adapter in component.adapters.values():
            test.assertFalse(adapter.training)
            test.assertFalse(adapter.dropout.training)
    test.assertEqual(calls[3:], [("eval", "transformer"), ("eval", "text_conditioner")])


def assert_lora_official_raw_anima_mapping_and_collision_rejection(test):
    raw = {f"diffusion_model.llm_adapter.layer.lora_{side}.weight" for side in "AB"}
    converted = {f"text_conditioner.layer.lora_{side}.weight" for side in "AB"}
    pipeline, calls, modules = test.lora_fakes(raw, loaded_keys=converted, converted_keys=converted)
    with modules:
        worker.load_loras(pipeline, [{"path": "/models/raw.safetensors", "strength": 0.5}])
    test.assertEqual(calls[0][1]["weight_name"], "raw.safetensors")
    test.assertEqual(calls[1], (["huiyu_0"], {"adapter_weights": [0.5]}))
    test.assertEqual(calls[2:], [("eval", "transformer"), ("eval", "text_conditioner")])
    pipeline, calls, modules = test.lora_fakes(raw | converted, converted_keys=converted)
    with modules, test.assertRaises(worker.WorkerError) as error:
        worker.load_loras(pipeline, [{"path": "/models/collision.safetensors", "strength": 1}])
    test.assertEqual(error.exception.code, "UNSUPPORTED_LORA")
    test.assertEqual(calls, [])
