"""No-GPU protocol/loader tests using explicit fakes; not inference acceptance."""
import io
from dataclasses import dataclass
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

import worker


def model(root):
    (root / "modular_model_index.json").write_text(json.dumps({"_class_name": "AnimaModularPipeline"}))
    for name in worker.COMPONENTS:
        folder = root / name
        folder.mkdir()
        if name in worker.WEIGHTS:
            (folder / "config.json").write_text("{}")
            (folder / "model.safetensors").write_bytes(b"FAKE TEST FIXTURE, NOT WEIGHTS")
        elif name == "scheduler":
            (folder / "scheduler_config.json").write_text('{"_class_name":"FlowMatchEulerDiscreteScheduler"}')
        else:
            (folder / "tokenizer_config.json").write_text("{}")
            for asset in (("vocab.json", "merges.txt") if name == "tokenizer" else ("tokenizer.json",)):
                (folder / asset).write_text("{}")
    return root


def job(root):
    return {"id": "test-job", "op": "generate", "modelDir": str(root),
            "outputPath": str(root / "result.png"), "input": {"prompt": "test", "steps": 2}}


class WorkerTests(unittest.TestCase):
    def test_rejects_active_unsupported_options_before_loading(self):
        for key, value in (("mask", "x.png"), ("loras", [{"path": "x"}]),
                           ("rcas", 0.5), ("inputImagePath", "x.png"), ("upscaler", "x")):
            request = job(Path("unused"))
            request["input"][key] = value
            with self.subTest(key=key), self.assertRaises(worker.WorkerError) as error:
                worker.validate_job(request)
            self.assertEqual(error.exception.code, "UNSUPPORTED_OPTION")

    def test_rejects_sampler_and_invalid_numbers(self):
        for key, value in (("sampler", "res_multistep"), ("steps", True), ("cfg", float("nan")),
                           ("width", 65), ("seed", -1)):
            request = job(Path("unused"))
            request["input"][key] = value
            with self.subTest(key=key), self.assertRaises(worker.WorkerError):
                worker.validate_job(request)

    def test_layout_checks_missing_shards(self):
        with tempfile.TemporaryDirectory() as directory:
            root = model(Path(directory))
            self.assertEqual(worker.validate_model(str(root)), root)
            (root / "t5_tokenizer" / "tokenizer.json").unlink()
            (root / "t5_tokenizer" / "spiece.model").write_bytes(b"FAKE SENTENCEPIECE")
            self.assertEqual(worker.validate_model(str(root)), root)
            (root / "transformer" / "model.safetensors.index.json").write_text('{"weight_map":{"x":"missing.safetensors"}}')
            with self.assertRaises(worker.WorkerError) as error:
                worker.validate_model(str(root))
            self.assertEqual(error.exception.code, "MODEL_INCOMPLETE")

    def test_loader_uses_fixed_local_classes_and_cfg_component(self):
        calls = []

        class Component:
            @classmethod
            def from_pretrained(cls, path, **kwargs):
                calls.append((Path(path).name, kwargs))
                return cls()

        class Pipeline:
            def update_components(self, **kwargs):
                self.components = kwargs
            def to(self, device):
                self.device = device
            def set_progress_bar_config(self, **kwargs):
                pass

        diffusers = types.SimpleNamespace(AnimaModularPipeline=Pipeline, AnimaTextConditioner=Component,
            AutoencoderKLQwenImage=Component, CosmosTransformer3DModel=Component,
            FlowMatchEulerDiscreteScheduler=Component, ClassifierFreeGuidance=lambda **kw: kw)
        transformers = types.SimpleNamespace(Qwen3Model=Component, Qwen2Tokenizer=Component, T5Tokenizer=Component, T5TokenizerFast=Component)
        torch = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: True, is_bf16_supported=lambda: True), bfloat16="bf16")
        with patch.dict("sys.modules", {"torch": torch, "diffusers": diffusers, "transformers": transformers}):
            pipeline = worker.load_pipeline(Path("/local-model"), 5.0)
        self.assertEqual(pipeline.components["guider"], {"guidance_scale": 5.0})
        self.assertEqual(pipeline.device, "cuda")
        self.assertEqual(len(calls), 7)
        for name, kwargs in calls:
            self.assertTrue(kwargs["local_files_only"])
            if name in worker.WEIGHTS:
                self.assertTrue(kwargs["use_safetensors"])
            if name in ("text_encoder", "tokenizer", "t5_tokenizer"):
                self.assertFalse(kwargs["trust_remote_code"])

    def test_fake_pipeline_protocol_and_atomic_output(self):
        class FakeImage:
            def save(self, path, format):
                Path(path).write_bytes(b"FAKE IMAGE ONLY")

        class FakePipeline:
            scheduler = types.SimpleNamespace(step=lambda: None)
            def __call__(self, **kwargs):
                self.arguments = kwargs
                print("library noise")
                for _ in range(kwargs["num_inference_steps"]):
                    self.scheduler.step()
                return [FakeImage()]

        class FakeGenerator:
            def __init__(self, device):
                self.device = device
            def manual_seed(self, seed):
                self.seed = seed
                return self

        with tempfile.TemporaryDirectory() as directory:
            root = model(Path(directory))
            pipeline = FakePipeline()
            stdout, stderr = io.StringIO(), io.StringIO()
            request = job(root)
            request["outputPath"] = str(root / "unused" / ".." / "result.png")
            with patch("sys.stdin", io.StringIO(json.dumps(request) + "\n")), patch("sys.stdout", stdout), patch("sys.stderr", stderr), patch.object(worker, "dependencies"), patch.object(worker, "load_pipeline", return_value=pipeline), patch.dict("sys.modules", {"torch": types.SimpleNamespace(Generator=FakeGenerator)}):
                self.assertEqual(worker.main([]), 0)
            events = [json.loads(line) for line in stdout.getvalue().splitlines()]
            self.assertEqual([event["event"] for event in events], ["progress", "progress", "result"])
            self.assertEqual(events[1]["step"], 2)
            self.assertEqual(events[-1]["outputPath"], request["outputPath"])
            self.assertEqual(pipeline.arguments["output"], "images")
            self.assertNotIn("guidance_scale", pipeline.arguments)
            self.assertEqual((root / "result.png").read_bytes(), b"FAKE IMAGE ONLY")
            self.assertIn("library noise", stderr.getvalue())

    def test_trusted_image_and_lora_job_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image, adapter = root / "input.png", root / "style.safetensors"
            image.touch()
            adapter.touch()
            request = job(root)
            request.update(inputImagePath=str(image), loras=[{"path": str(adapter), "strength": -0.5}])
            self.assertEqual(worker.validate_job(request)["denoisingStrength"], 0.75)
            for change in ({"denoisingStrength": 0}, {"denoisingStrength": 1.01}, {"mask": "x"}):
                request["input"] = {"prompt": "test", **change}
                with self.subTest(change=change), self.assertRaises(worker.WorkerError):
                    worker.validate_job(request)
            request["input"] = {"prompt": "test"}
            request["loras"][0]["extra"] = True
            with self.assertRaises(worker.WorkerError):
                worker.validate_job(request)
            request["loras"] = []
            request["inputImagePath"] = "https://example.com/input.png"
            with self.assertRaises(worker.WorkerError):
                worker.validate_job(request)

    def test_img2img_passes_image_strength_and_actual_step_total(self):
        marker = object()
        pipeline = types.SimpleNamespace(scheduler=types.SimpleNamespace(step=lambda: None))
        arguments = {}

        class Pipeline:
            scheduler = pipeline.scheduler
            def __call__(self, **kwargs):
                arguments.update(kwargs)
                for _ in range(3):
                    self.scheduler.step()
                return [types.SimpleNamespace(save=lambda path, format: Path(path).write_bytes(b"FAKE PNG"))]

        generator = types.SimpleNamespace(manual_seed=lambda seed: "FAKE GENERATOR")
        with tempfile.TemporaryDirectory() as directory:
            root = model(Path(directory))
            (root / "input.png").touch()
            request = job(root)
            request["inputImagePath"] = str(root / "input.png")
            request["input"].update(steps=5, denoisingStrength=0.5)
            stream = io.StringIO()
            with patch.object(worker, "dependencies"), patch.object(worker, "load_pipeline", return_value=Pipeline()), patch.object(worker, "load_input_image", return_value=marker) as load, patch.dict("sys.modules", {"torch": types.SimpleNamespace(Generator=lambda device: generator)}):
                worker.generate(request, stream)
            load.assert_called_once_with(str(root / "input.png"))
            self.assertIs(arguments["image"], marker)
            self.assertEqual(arguments["strength"], 0.5)
            self.assertEqual(arguments["num_inference_steps"], 5)
            events = [json.loads(line) for line in stream.getvalue().splitlines()]
            self.assertEqual([(e["step"], e["total"]) for e in events[:-1]], [(1, 3), (2, 3), (3, 3)])

    def lora_fakes(self, keys, metadata=None, loaded_keys=None, converted_keys=None):
        @dataclass
        class Config:
            r: int = 4
            use_dora: bool = False

        class File:
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def keys(self):
                return keys
            def metadata(self):
                return metadata

        class Component:
            def __init__(self, name):
                self.name = name
            def get_submodule(self, target):
                if target != "layer":
                    raise AttributeError(target)
                return object()

        calls = []
        pipeline = types.SimpleNamespace(
            transformer=Component("transformer"), text_conditioner=Component("text_conditioner"),
            load_lora_weights=lambda path, **kwargs: calls.append((path, kwargs)),
            set_adapters=lambda names, **kwargs: calls.append((names, kwargs)))
        modules = {"safetensors": types.SimpleNamespace(safe_open=lambda *args, **kwargs: File()),
                   "peft": types.SimpleNamespace(LoraConfig=Config, get_peft_model_state_dict=lambda component, **kwargs: {
                       key.removeprefix(component.name + "."): None for key in (keys if loaded_keys is None else loaded_keys)
                       if key.startswith(component.name + ".")})}
        if converted_keys is not None:
            modules["diffusers.loaders.lora_conversion_utils"] = types.SimpleNamespace(
                _convert_non_diffusers_anima_lora_to_diffusers=lambda state: dict.fromkeys(converted_keys))
        return pipeline, calls, patch.dict("sys.modules", modules)

    def test_lora_local_safe_load_scales_both_components(self):
        keys = {f"{component}.layer.lora_{side}.weight" for component in ("transformer", "text_conditioner") for side in "AB"}
        pipeline, calls, modules = self.lora_fakes(keys, {"lora_adapter_metadata": '{"transformer.r":4,"text_conditioner.r":4}'})
        with modules:
            worker.load_loras(pipeline, [{"path": "/models/style.safetensors", "strength": 0.6},
                                         {"path": "/models/second.safetensors", "strength": -0.2}])
        self.assertEqual(calls[0], (str(Path("/models")), {"weight_name": "style.safetensors", "adapter_name": "huiyu_0", "local_files_only": True, "use_safetensors": True}))
        self.assertEqual(calls[1][1]["adapter_name"], "huiyu_1")
        self.assertEqual(calls[2], (["huiyu_0", "huiyu_1"], {"adapter_weights": [0.6, -0.2]}))

    def test_lora_official_raw_anima_mapping_and_collision_rejection(self):
        raw = {f"diffusion_model.llm_adapter.layer.lora_{side}.weight" for side in "AB"}
        converted = {f"text_conditioner.layer.lora_{side}.weight" for side in "AB"}
        pipeline, calls, modules = self.lora_fakes(raw, loaded_keys=converted, converted_keys=converted)
        with modules:
            worker.load_loras(pipeline, [{"path": "/models/raw.safetensors", "strength": 0.5}])
        self.assertEqual(calls[0][1]["weight_name"], "raw.safetensors")
        self.assertEqual(calls[-1], (["huiyu_0"], {"adapter_weights": [0.5]}))
        pipeline, calls, modules = self.lora_fakes(raw | converted, converted_keys=converted)
        with modules, self.assertRaises(worker.WorkerError) as error:
            worker.load_loras(pipeline, [{"path": "/models/collision.safetensors", "strength": 1}])
        self.assertEqual(error.exception.code, "UNSUPPORTED_LORA")
        self.assertEqual(calls, [])

    def test_lora_rejects_silent_drops_and_unsupported_metadata(self):
        keys = {f"transformer.layer.lora_{side}.weight" for side in "AB"}
        for extra, metadata in (({"text_encoder.layer.lora_A.weight"}, None),
                                ({"transformer.layer.dora_scale"}, None),
                                (set(), {"lora_adapter_metadata": '{"transformer.use_dora":true}'}),
                                (set(), {"lora_adapter_metadata": '{"unknown.r":4}'})):
            pipeline, calls, modules = self.lora_fakes(keys | extra, metadata)
            with self.subTest(extra=extra, metadata=metadata), modules, self.assertRaises(worker.WorkerError) as error:
                worker.load_loras(pipeline, [{"path": "/models/style.safetensors", "strength": 1}])
            self.assertEqual(error.exception.code, "UNSUPPORTED_LORA")
            self.assertEqual(calls, [])
        pipeline, calls, modules = self.lora_fakes(keys, loaded_keys=set())
        with modules, self.assertRaises(worker.WorkerError):
            worker.load_loras(pipeline, [{"path": "/models/style.safetensors", "strength": 1}])
        self.assertEqual(len(calls), 1)  # Never activate a partially loaded adapter.

    def test_diagnose_without_model_or_gpu_allocations(self):
        stream = io.StringIO()
        torch = types.SimpleNamespace(cuda=types.SimpleNamespace(is_available=lambda: False))
        with patch.object(worker, "dependencies", return_value={"torch": "2.8.0"}), patch.dict("sys.modules", {"torch": torch}), patch("sys.stdout", stream):
            self.assertEqual(worker.main(["--diagnose"]), 0)
        result = json.loads(stream.getvalue())
        self.assertEqual(result["event"], "diagnostic")
        self.assertFalse(result["cudaAvailable"])
        self.assertIsNone(result["deviceName"])
        stream = io.StringIO()
        with patch.object(worker, "dependencies", side_effect=worker.WorkerError("DEPENDENCY_MISSING", "torch")), patch("sys.stdout", stream):
            self.assertEqual(worker.main(["--diagnose"]), 1)
        self.assertEqual(json.loads(stream.getvalue())["code"], "DEPENDENCY_MISSING")

    def test_cli_errors_are_json_and_nonzero(self):
        stdout = io.StringIO()
        with patch("sys.stdin", io.StringIO("bad json\n")), patch("sys.stdout", stdout):
            self.assertEqual(worker.main([]), 1)
        self.assertEqual(json.loads(stdout.getvalue())["code"], "INVALID_REQUEST")


if __name__ == "__main__":
    unittest.main()
