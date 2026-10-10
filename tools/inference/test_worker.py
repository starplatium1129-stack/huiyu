"""No-GPU protocol/loader tests using explicit fakes; not inference acceptance."""
import io
from dataclasses import dataclass
from contextlib import contextmanager
import json
import os
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
    @contextmanager
    def resident_fixture(self):
        import resident_anima
        from test_anima_text_cache import Encoder, State, modules, np
        f = types.SimpleNamespace(loaded=[], used=[], specs={}, failure=None, encoder=Encoder,
                                  initialized=False, allocator="native", resets=0, reads=0, metrics_error=None)
        class Pipeline:
            def __init__(self, blocks=None):
                self.blocks = blocks
                self.scheduler = types.SimpleNamespace(config={"shift": 1}, step=lambda: None)
                self.components = {name: object() for name in worker.COMPONENTS if name != "scheduler"}
                for name in ("transformer", "text_conditioner"):
                    self.components[name] = types.SimpleNamespace(adapters={}, peft_config={})
                self.text_encoder = self.components["text_encoder"] = types.SimpleNamespace(dtype=np.float32)
                self._execution_device = "cpu"
                self.guider = types.SimpleNamespace(num_conditions=2)
            def update_components(self, **components):
                self.components = components
                self.scheduler = components["scheduler"]
                self.text_encoder = components["text_encoder"]
                self.guider = types.SimpleNamespace(num_conditions=2 if components["guider"]["guidance_scale"] > 1 else 1)
            def set_adapters(self, names, adapter_weights):
                for component in (self.components[name] for name in ("transformer", "text_conditioner")):
                    for name, strength in zip(names, adapter_weights):
                        if name in component.adapters:
                            component.adapters[name] = (component.adapters[name][0], strength)
                    if f.failure == "scale":
                        raise RuntimeError("partial scale failure")
            def unload_lora_weights(self):
                for name in ("transformer", "text_conditioner"):
                    self.components[name].adapters.clear()
                    self.components[name].peft_config.clear()
                    if f.failure == "unload":
                        raise RuntimeError("partial unload failure")
            def set_progress_bar_config(self, **kwargs):
                pass
            def __call__(self, **kwargs):
                f.used.append((self, kwargs))
                state = State(prompt=kwargs["prompt"], negative_prompt=kwargs["negative_prompt"], max_sequence_length=512)
                self.blocks.sub_blocks["text_encoder"](self, state)
                self.scheduler.step()
                return [types.SimpleNamespace(save=lambda path, format, compress_level: Path(path).write_bytes(b"FAKE PNG"))]
        def load(root, cfg, blocks=None):
            f.initialized = True
            result = Pipeline(blocks)
            f.loaded.append(result)
            return result
        def load_adapters(pipeline, adapters):
            for i, adapter in enumerate(adapters):
                data = Path(adapter["path"]).read_bytes()
                targets, init = f.specs.get(data, (("transformer", "text_conditioner"), True))
                for name in targets:
                    component = pipeline.components[name]
                    component.adapters[f"huiyu_{i}"] = (data, adapter["strength"])
                    component.peft_config[f"huiyu_{i}"] = types.SimpleNamespace(init_lora_weights=init)
                    if f.failure == "load":
                        raise RuntimeError("partial load failure")
            if f.failure == "changed_bytes":
                Path(adapters[0]["path"]).write_bytes(b"CHANGED DURING LOAD")
        diffusers = types.SimpleNamespace(AnimaModularPipeline=Pipeline,
            FlowMatchEulerDiscreteScheduler=types.SimpleNamespace(from_config=lambda c: types.SimpleNamespace(config=dict(c), step=lambda: None)),
            ClassifierFreeGuidance=lambda **kw: kw)
        def reset_metrics(device):
            f.resets += 1
            if f.metrics_error == "reset":
                raise RuntimeError("synthetic allocator reset failure")
        def read_metrics(device):
            f.reads += 1
            if f.metrics_error == "read":
                raise RuntimeError("synthetic allocator stats failure")
            return {"allocated_bytes.all.peak": float("nan") if f.metrics_error == "invalid" else 1234,
                    "reserved_bytes.all.peak": 2048}
        torch = types.SimpleNamespace(no_grad=lambda: lambda fn: fn,
            cuda=types.SimpleNamespace(is_available=lambda: False, synchronize=lambda: None,
                is_initialized=lambda: f.initialized, get_allocator_backend=lambda: f.allocator,
                reset_peak_memory_stats=reset_metrics, memory_stats=read_metrics),
            Generator=lambda device: types.SimpleNamespace(manual_seed=lambda seed: seed))
        f.cuda = torch.cuda
        Encoder.calls = 0
        with tempfile.TemporaryDirectory() as directory, patch.dict("sys.modules", {**modules(), "torch": torch, "diffusers": diffusers}), \
                patch.object(worker, "dependencies") as f.checks, patch.object(worker, "load_pipeline", side_effect=load), \
                patch.object(worker, "load_loras", side_effect=load_adapters) as f.adapters:
            f.root = model(Path(directory))
            f.resident = resident_anima.PipelineCache()
            f.request = job(f.root)
            f.path = f.root / "lora.safetensors"
            f.path.write_bytes(b"FAKE LORA")
            f.request["loras"] = [{"path": str(f.path), "strength": .5}]
            yield f

    def test_native_observations_distinguish_cold_warm_and_actual_steps_without_new_sync(self):
        with self.resident_fixture() as f, patch.object(f.cuda, "synchronize", side_effect=AssertionError("new sync forbidden")) as sync:
            results = []
            for _ in range(2):
                stream = io.StringIO()
                self.assertIsNone(worker.generate(f.request, stream, resident=f.resident))
                results.append(json.loads(stream.getvalue().splitlines()[-1])["nativeRuntime"])
            cold, warm = results
            self.assertEqual(cold["memory"]["reason"], "cuda-uninitialized-at-window-start")
            self.assertIsNone(cold["memory"]["peakAllocatedBytes"])
            self.assertFalse(cold["baseReused"])
            self.assertTrue(warm["baseReused"])
            self.assertEqual((f.resets, f.reads), (1, 1))
            self.assertEqual(warm["memory"]["status"], "per-job-allocator")
            self.assertEqual(warm["memory"]["peakAllocatedBytes"], 1234)
            self.assertEqual(warm["textCache"]["hits"], 1)
            self.assertEqual(cold["textCache"]["misses"], 1)
            self.assertEqual(warm["completedSteps"], 1)
            self.assertNotEqual(warm["completedSteps"], f.request["input"]["steps"])
            self.assertFalse(warm["timingsAreAdditive"])
            self.assertFalse(warm["existingReportSynchronization"])
            self.assertGreaterEqual(warm["timings"]["workerWallSeconds"], warm["timings"]["pipelineWallSeconds"])
            self.assertNotIn("outputPath", warm)
            self.assertNotIn("schedule", warm)
            json.dumps(results, allow_nan=False)
            sync.assert_not_called()

    def test_native_observation_failures_do_not_break_output_or_reuse_stale_mask_stats(self):
        with self.resident_fixture() as f:
            worker.generate(f.request, io.StringIO(), resident=f.resident)
            f.resident.mask_cache = types.SimpleNamespace(stats=lambda: self.fail("unused mask stats must not leak"))
            for backend, failure in (("cudaMallocAsync", None), ("native", "reset"), ("native", "read"), ("native", "invalid")):
                with self.subTest(backend=backend, failure=failure):
                    f.allocator, f.metrics_error = backend, failure
                    stream = io.StringIO()
                    worker.generate(f.request, stream, resident=f.resident)
                    result = json.loads(stream.getvalue().splitlines()[-1])
                    self.assertEqual(result["event"], "result")
                    self.assertTrue(Path(f.request["outputPath"]).is_file())
                    evidence = result["nativeRuntime"]
                    self.assertEqual(evidence["memory"]["status"], "unverified")
                    self.assertIsNone(evidence["memory"]["peakAllocatedBytes"])
                    self.assertEqual(evidence["memory"]["reason"], "unsupported-allocator" if failure is None else "allocator-observation-error")
                    self.assertEqual(evidence["maskCache"], {"enabled": True, "used": False})
                    json.dumps(evidence, allow_nan=False)

    def test_explicit_measure_report_retains_one_cold_reset_and_existing_timing_keys(self):
        with self.resident_fixture() as f, patch.object(f.cuda, "synchronize") as sync:
            self.assertFalse(f.initialized)
            stream = io.StringIO()
            report = worker.generate(f.request, stream, resident=f.resident, measure_teacache=True)
            evidence = json.loads(stream.getvalue().splitlines()[-1])["nativeRuntime"]
            self.assertEqual((f.resets, f.reads), (1, 1))
            self.assertEqual(sync.call_count, 2, "retain existing report fences without new ones")
            self.assertEqual(report["peakAllocatedBytes"], 1234)
            self.assertEqual(report["pipelineSeconds"], report["generationSeconds"])
            self.assertIn("modelLoadSeconds", report)
            self.assertEqual(report["fingerprintSeconds"], 0)
            self.assertEqual(evidence["memory"]["peakAllocatedBytes"], report["peakAllocatedBytes"])
            self.assertTrue(evidence["existingReportSynchronization"])

    def test_resident_reuses_base_across_adapters_with_fresh_job_state(self):
        with self.resident_fixture() as f:
            worker.generate(f.request, io.StringIO(), resident=f.resident)
            f.request["input"].update(cfg=7, seed=2, steps=3)
            second = io.StringIO()
            worker.generate(f.request, second, resident=f.resident)
            self.assertEqual(f.adapters.call_count, 1)
            self.assertIs(f.used[0][0].components["transformer"], f.used[1][0].components["transformer"])
            self.assertIsNot(f.used[0][0].scheduler, f.used[1][0].scheduler)
            self.assertEqual(f.used[1][0].components["guider"], {"guidance_scale": 7})
            self.assertEqual(f.used[1][1]["generator"], 2)
            self.assertTrue(json.loads(second.getvalue().splitlines()[-1])["modelReused"])
            self.assertEqual(json.loads(second.getvalue().splitlines()[-1])["textCache"]["hits"], 1)
            for strength in (.9, 0, -.2, .5):
                f.request["loras"][0]["strength"] = strength
                worker.generate(f.request, io.StringIO(), resident=f.resident)
                for name in ("transformer", "text_conditioner"):
                    self.assertEqual(f.resident.components[name].adapters, {"huiyu_0": (b"FAKE LORA", strength)})
            self.assertEqual(f.adapters.call_count, 1)
            # Equal length and timestamps must not hide different adapter bytes.
            stamp = f.path.stat()
            f.path.write_bytes(b"NEXT LORA")
            os.utime(f.path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
            f.specs[b"NEXT LORA"] = (("transformer",), True)
            worker.generate(f.request, second, resident=f.resident)
            self.assertEqual(f.resident.components["transformer"].adapters, {"huiyu_0": (b"NEXT LORA", .5)})
            self.assertEqual(f.resident.components["text_conditioner"].adapters, {})
            self.assertTrue(json.loads(second.getvalue().splitlines()[-1])["modelReused"])
            self.assertTrue(f.resident.weights_loaded)
            for data in (b"FAKE LORA", None, b"NEXT LORA"):
                f.request["loras"] = [] if data is None else [{"path": str(f.path), "strength": .5}]
                if data is not None:
                    f.path.write_bytes(data)
                worker.generate(f.request, io.StringIO(), resident=f.resident)
                for name in ("transformer", "text_conditioner"):
                    expected = {} if data is None or (data == b"NEXT LORA" and name == "text_conditioner") else {"huiyu_0": (data, .5)}
                    self.assertEqual(f.resident.components[name].adapters, expected)
            self.assertEqual(len(f.loaded), 1)
            self.assertEqual(f.encoder.calls, 1)  # Only unconditioned text outputs are retained.
            mask_cleared = []
            f.resident.mask_cache = types.SimpleNamespace(components=None, clear=lambda: mask_cleared.append(True))
            (f.root / "transformer/model.safetensors").write_bytes(b"MODIFIED TEST WEIGHTS")
            worker.generate(f.request, io.StringIO(), resident=f.resident)
            self.assertEqual(len(f.loaded), 2)
            self.assertEqual(f.encoder.calls, 2)
            self.assertEqual(f.checks.call_count, 1)
            self.assertEqual(mask_cleared, [])
            f.resident.clear()
            self.assertIsNone(f.resident.components)
            self.assertEqual(mask_cleared, [True])

    def test_resident_reloads_base_mutating_adapters_on_group_change(self):
        with self.resident_fixture() as f:
            f.specs[b"FAKE LORA"] = (("text_conditioner",), "pissa")
            worker.generate(f.request, io.StringIO(), resident=f.resident)
            f.request["loras"][0]["strength"] = 0
            worker.generate(f.request, io.StringIO(), resident=f.resident)
            self.assertEqual(len(f.loaded), 1)
            f.request["loras"] = []
            worker.generate(f.request, io.StringIO(), resident=f.resident)
            self.assertEqual(len(f.loaded), 2)
            self.assertEqual(f.resident.components["text_conditioner"].adapters, {})

    def test_resident_discards_partial_adapter_changes_and_changed_load_bytes(self):
        for failure in ("unload", "load", "scale", "changed_bytes"):
            with self.subTest(failure=failure), self.resident_fixture() as f:
                worker.generate(f.request, io.StringIO(), resident=f.resident)
                if failure == "scale":
                    f.request["loras"][0]["strength"] = .9
                else:
                    f.path.write_bytes(b"NEXT LORA")
                f.failure = failure
                with self.assertRaises((RuntimeError, worker.WorkerError)) as error:
                    worker.generate(f.request, io.StringIO(), resident=f.resident)
                if failure == "changed_bytes":
                    self.assertEqual(error.exception.code, "MODEL_CHANGED")
                self.assertIsNone(f.resident.identity)
                self.assertIsNone(f.resident.components)
                self.assertEqual(f.resident.text_cache.stats()["entries"], 0)
                f.failure = None
                worker.generate(f.request, io.StringIO(), resident=f.resident)
                self.assertEqual(len(f.loaded), 2)

    def test_resident_timing_separates_all_byte_checks_from_adapter_loading(self):
        with self.resident_fixture() as f:
            profile = worker.load_mask_tools("teacache_profile")
            identity, load = profile.model_identity, f.adapters.side_effect
            clock = [0]
            def fingerprint(*args):
                clock[0] += 5
                return identity(*args)
            def adapters(*args):
                clock[0] += 3
                return load(*args)
            f.adapters.side_effect = adapters
            with patch.object(profile, "model_identity", side_effect=fingerprint), \
                    patch.object(worker.time, "perf_counter", side_effect=lambda: clock[0]):
                for contents, fingerprints, loading in ((b"FAKE LORA", 10, 3), (b"FAKE LORA", 5, 0), (b"NEXT LORA", 10, 3)):
                    f.path.write_bytes(contents)
                    report = worker.generate(f.request, io.StringIO(), resident=f.resident, measure_teacache=True)
                    self.assertEqual(report["residentFingerprintSeconds"], fingerprints)
                    self.assertEqual(report["modelLoadSeconds"], loading)
                    self.assertEqual(report["outputSaveSeconds"], 0)
                    self.assertEqual(report["outputBytes"], len(b"FAKE PNG"))

    def test_helper_modules_are_loaded_once_until_explicit_initialization(self):
        worker.load_mask_tools.cache_clear()
        with patch("importlib.util.spec_from_file_location", wraps=__import__("importlib.util", fromlist=["spec_from_file_location"]).spec_from_file_location) as load:
            first = worker.load_mask_tools("anima_text_cache")
            second = worker.load_mask_tools("anima_text_cache")
        self.assertIs(first, second)
        self.assertEqual(load.call_count, 1)

    def test_serve_has_job_ready_boundaries_and_exits_on_failure(self):
        cache = types.SimpleNamespace(clear=lambda: None)
        stdout = io.StringIO()
        jobs = [dict(id="first"), dict(id="second"), dict(id="third")]
        calls = []
        def generate(request, stream, resident=None):
            self.assertIs(resident, cache)
            calls.append(request["id"])
            if request["id"] == "second":
                raise worker.WorkerError("LOAD_FAILED", "fixture failure")
            worker.emit(stream, request["id"], "result", outputPath="fixture.png")
        with patch("sys.stdin", io.StringIO("".join(json.dumps(j) + "\n" for j in jobs))), \
                patch("sys.stdout", stdout), patch.object(worker, "generate", side_effect=generate), \
                patch.object(worker, "load_mask_tools", return_value=types.SimpleNamespace(PipelineCache=lambda: cache)):
            self.assertEqual(worker.main(["--serve"]), 1)
        self.assertEqual(calls, ["first", "second"])
        events = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual([(e["id"], e["event"]) for e in events], [("first", "result"), ("first", "ready"), ("second", "error")])

    def test_serve_cleanup_preserves_missing_torch_error(self):
        stdout = io.StringIO()
        with patch("sys.stdin", io.StringIO('{"id":"missing-runtime"}\n')), patch("sys.stdout", stdout), \
                patch.dict("sys.modules", {"torch": None}), patch("gc.collect") as collect, \
                patch.object(worker, "generate", side_effect=worker.WorkerError("DEPENDENCY_MISSING", "torch")):
            self.assertEqual(worker.main(["--serve"]), 1)
        self.assertEqual(json.loads(stdout.getvalue()),
                         {"id": "missing-runtime", "event": "error", "code": "DEPENDENCY_MISSING", "message": "torch"})
        collect.assert_not_called()

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
            def save(self, path, format, compress_level):
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
                return [types.SimpleNamespace(save=lambda path, format, compress_level: Path(path).write_bytes(b"FAKE PNG"))]

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
            lora_dropout: float = 0.0

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
                self.training, self.adapters = False, {}
            def get_submodule(self, target):
                if target != "layer":
                    raise AttributeError(target)
                return object()
            def eval(self):
                calls.append(("eval", self.name))
                self.training = False
                for adapter in self.adapters.values():
                    adapter.training = adapter.dropout.training = False
                return self

        def load(path, **kwargs):
            calls.append((path, kwargs))
            # Explicit state fake: newly injected children do not inherit parent eval.
            for name in ("transformer", "text_conditioner"):
                if any(key.startswith(name + ".") for key in (keys if loaded_keys is None else loaded_keys)):
                    getattr(pipeline, name).adapters[kwargs["adapter_name"]] = types.SimpleNamespace(
                        training=True, dropout=types.SimpleNamespace(training=True))

        calls = []
        pipeline = types.SimpleNamespace(
            transformer=Component("transformer"), text_conditioner=Component("text_conditioner"),
            load_lora_weights=load,
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
        metadata = {"lora_adapter_metadata": '{"transformer.r":4,"text_conditioner.r":4,"transformer.lora_dropout":0.25,"text_conditioner.lora_dropout":0.25}'}
        pipeline, calls, modules = self.lora_fakes(keys, metadata)
        with modules:
            worker.load_loras(pipeline, [{"path": "/models/style.safetensors", "strength": 0.6},
                                         {"path": "/models/second.safetensors", "strength": -0.2}])
        self.assertEqual(calls[0], (str(Path("/models")), {"weight_name": "style.safetensors", "adapter_name": "huiyu_0", "local_files_only": True, "use_safetensors": True}))
        self.assertEqual(calls[1][1]["adapter_name"], "huiyu_1")
        self.assertEqual(calls[2], (["huiyu_0", "huiyu_1"], {"adapter_weights": [0.6, -0.2]}))
        for component in (pipeline.transformer, pipeline.text_conditioner):
            self.assertFalse(component.training)
            self.assertEqual(set(component.adapters), {"huiyu_0", "huiyu_1"})
            for adapter in component.adapters.values():
                self.assertFalse(adapter.training)
                self.assertFalse(adapter.dropout.training)
        self.assertEqual(calls[3:], [("eval", "transformer"), ("eval", "text_conditioner")])

    def test_lora_official_raw_anima_mapping_and_collision_rejection(self):
        raw = {f"diffusion_model.llm_adapter.layer.lora_{side}.weight" for side in "AB"}
        converted = {f"text_conditioner.layer.lora_{side}.weight" for side in "AB"}
        pipeline, calls, modules = self.lora_fakes(raw, loaded_keys=converted, converted_keys=converted)
        with modules:
            worker.load_loras(pipeline, [{"path": "/models/raw.safetensors", "strength": 0.5}])
        self.assertEqual(calls[0][1]["weight_name"], "raw.safetensors")
        self.assertEqual(calls[1], (["huiyu_0"], {"adapter_weights": [0.5]}))
        self.assertEqual(calls[2:], [("eval", "transformer"), ("eval", "text_conditioner")])
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
