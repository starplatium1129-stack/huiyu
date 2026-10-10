"""Real Pillow/NumPy postprocessing and explicit fake CLIPSeg; no model/GPU run."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

import numpy as np
from PIL import Image

import clipseg_mask
import masked_anima
import inference_metrics
import resident_benchmark
import teacache_profile as profiles
import worker
from test_masked_anima import Blocks, fake_modules


def local_model(root):
    root.mkdir()
    for name in clipseg_mask.FILES:
        (root / name).write_text("{}" if name.endswith(".json") else "EXPLICIT FAKE FIXTURE")
    (root / "config.json").write_text(json.dumps({"model_type": "clipseg", "reduce_dim": 64,
        "use_complex_transposed_convolution": True}))
    (root / "preprocessor_config.json").write_text(json.dumps({"size": {"height": 352, "width": 352},
        "do_resize": True, "do_rescale": True, "do_normalize": True, "resample": 2,
        "image_mean": [0.485, 0.456, 0.406], "image_std": [0.229, 0.224, 0.225], "rescale_factor": 1 / 255}))
    return root


class Tensor(np.ndarray):
    def __new__(cls, values):
        return np.asarray(values).view(cls)
    def to(self, *args, **kwargs):
        return self.astype(kwargs.get("dtype", self.dtype), copy=kwargs.get("copy", False))
    def detach(self):
        return self
    def numpy(self):
        return np.asarray(self)
    def repeat(self, *repeats):
        return Tensor(np.tile(np.asarray(self), repeats))
    def numel(self):
        return self.size
    def element_size(self):
        return self.itemsize


def segmentation_fakes(calls, token_length=4, info=None, projection_dim=512, expose_conditioning=True):
    class Tokenizer:
        @classmethod
        def from_pretrained(cls, path, **kwargs):
            calls.append(("tokenizer", path, kwargs))
            return cls()
        def __call__(self, texts, **kwargs):
            calls.append(("texts", texts, kwargs))
            return {"input_ids": Tensor(np.tile(np.arange(len(texts))[:, None], (1, token_length))),
                "attention_mask": Tensor(np.ones((len(texts), token_length)))}
    class Processor:
        @classmethod
        def from_pretrained(cls, path, **kwargs):
            calls.append(("processor", path, kwargs))
            return cls()
        def __call__(self, images, **kwargs):
            calls.append(("image", images.size, kwargs))
            return {"pixel_values": Tensor(np.zeros((1, 3, 352, 352), dtype=np.float32))}
    class Model:
        @classmethod
        def from_pretrained(cls, path, **kwargs):
            calls.append(("model", path, kwargs))
            return cls(), info or {}
        def to(self, device):
            calls.append(("device", device))
            return self
        def eval(self):
            calls.append(("eval",))
            return self
        def __call__(self, pixel_values, input_ids, attention_mask, return_dict, **kwargs):
            calls.append(("inference", pixel_values.shape, input_ids.shape, return_dict))
            if set(kwargs) - {"conditional_embeddings"}:
                raise AssertionError("Unexpected model arguments")
            embeddings = kwargs.get("conditional_embeddings")
            if embeddings is None:
                calls.append(("text_inference", input_ids.shape))
                embeddings = Tensor(np.repeat(input_ids[:, :1], projection_dim, axis=1).astype(np.float32))
            elif embeddings.shape != (len(input_ids), projection_dim):
                raise ValueError("Invalid conditional shape")
            calls.append(("conditioning", embeddings, tuple(kwargs)))
            output = np.full((len(input_ids), 352, 352), -8, dtype=np.float32)
            for index, phrase in enumerate(embeddings[:, 0]):
                left = int(phrase) * 60
                output[index, :, left:left + 20] = 8
            class Result:
                logits = Tensor(output)
                @property
                def conditional_embeddings(self):
                    if not expose_conditioning:
                        raise AssertionError("Cache-disabled path must not read conditional embeddings")
                    return embeddings
            return Result()
    return {"torch": types.SimpleNamespace(float32="float32", inference_mode=contextlib.nullcontext),
        "transformers": types.SimpleNamespace(CLIPTokenizer=Tokenizer, ViTImageProcessorPil=Processor,
            CLIPSegForImageSegmentation=Model)}


class ClipsegTests(unittest.TestCase):
    def test_local_layout_rejects_missing_unsafe_and_custom_components(self):
        with tempfile.TemporaryDirectory() as directory:
            root = local_model(Path(directory) / "clipseg")
            self.assertEqual(clipseg_mask.validate_model(str(root)), root)
            processor_path = root / "preprocessor_config.json"
            # Original official exports can omit rescale/normalization fields
            # and inherit ViTImageProcessorPil's .5/.5 defaults.
            processor_path.write_text('{"size":352}')
            self.assertEqual(clipseg_mask.validate_model(str(root)), root)
            processor_path.write_text('{"size":352,"image_std":[0.5,0,0.5]}')
            with self.assertRaisesRegex(ValueError, "image_std"):
                clipseg_mask.validate_model(str(root))
            processor_path.write_text('{"size":352,"image_mean":[0.5,0.5,0.5],"image_std":[0.5,0.5,0.5]}')
            self.assertEqual(clipseg_mask.validate_model(str(root)), root)
            weights = root / "model.safetensors"
            weights.unlink()
            with self.assertRaisesRegex(ValueError, "model.safetensors"):
                clipseg_mask.validate_model(str(root))
            outside = (Path(directory) / "external.safetensors").resolve()
            outside.write_bytes(b"FAKE")
            weights.write_bytes(b"FAKE")
            original_resolve = Path.resolve
            # Simulate the resolved resource alias without Windows symlink privileges.
            # The real containment guard still checks the existing outside file.
            def resolved_alias(candidate, *args, **kwargs):
                return outside if candidate == weights else original_resolve(candidate, *args, **kwargs)
            with patch.object(Path, "resolve", autospec=True, side_effect=resolved_alias), self.assertRaisesRegex(ValueError, "unsafe"):
                clipseg_mask.validate_model(str(root))
            weights.unlink()
            weights.write_bytes(b"FAKE")
            (root / "tokenizer_config.json").write_text('{"auto_map":{"AutoTokenizer":"custom.Tokenizer"}}')
            with self.assertRaisesRegex(ValueError, "Custom-code"):
                clipseg_mask.validate_model(str(root))

    def test_prompt_union_is_bounded_and_empty_parts_do_not_become_queries(self):
        self.assertEqual(clipseg_mask.phrases(" jacket | | shirt | jacket "), ["jacket", "shirt"])
        for invalid in (" | ", None, False, "a" * 4097, "|".join(str(n) for n in range(33))):
            with self.subTest(invalid=str(invalid)[:40]), self.assertRaises(ValueError):
                clipseg_mask.phrases(invalid)

    def test_threshold_resize_growth_and_empty_nonfinite_masks(self):
        logits = np.full((352, 352), -8, dtype=np.float32)
        logits[:, 176:] = 8
        mask = clipseg_mask.logits_mask(logits, (64, 32), 0.5)
        self.assertEqual(mask.getbbox(), (32, 0, 64, 32))
        original, grown = masked_anima.prepare_mask(Image.new("RGB", mask.size, "blue"), mask, mask.size, 2)
        output = masked_anima.composite(Image.new("RGB", mask.size, "red"), original, grown)
        self.assertEqual(grown.getbbox(), (30, 0, 64, 32))
        self.assertEqual(output.getpixel((29, 0)), (0, 0, 255))
        self.assertEqual(output.getpixel((30, 0)), (255, 0, 0))
        with self.assertRaisesRegex(ValueError, "no editable"):
            clipseg_mask.logits_mask(np.full((352, 352), -8), (64, 32), 0.5)
        with self.assertRaisesRegex(ValueError, "nonfinite"):
            clipseg_mask.logits_mask(np.full((352, 352), np.nan), (64, 32), 0.5)

    def test_explicit_cpu_loaders_and_four_phrase_batches_merge_by_max(self):
        calls = []
        with patch.dict("sys.modules", segmentation_fakes(calls, expose_conditioning=False)):
            mask = clipseg_mask.generate_mask(Path("/approved/clipseg"), Image.new("RGB", (352, 352)),
                "coat|shirt|skirt|jacket|sleeves", 0.5)
        self.assertEqual([call[1][0] for call in calls if call[0] == "inference"], [4, 1])
        self.assertTrue(all(not call[2] for call in calls if call[0] == "conditioning"))
        for x in (0, 60, 120, 180, 240):
            self.assertEqual(mask.getpixel((x, 0)), 255)
            self.assertEqual(mask.getpixel((x + 30, 0)), 0)
        for call in calls:
            if call[0] in {"tokenizer", "processor", "model"}:
                self.assertEqual(call[1], str(Path("/approved/clipseg")))
                self.assertTrue(call[2]["local_files_only"])
                self.assertFalse(call[2]["trust_remote_code"])
        model_call = next(call for call in calls if call[0] == "model")
        self.assertTrue(model_call[2]["use_safetensors"])
        self.assertTrue(model_call[2]["output_loading_info"])
        self.assertEqual(model_call[2]["dtype"], "float32")
        self.assertIn(("device", "cpu"), calls)
        self.assertIn(("eval",), calls)

    def test_long_phrases_and_partial_checkpoints_fail_before_inference(self):
        for token_length, info, message in ((78, {}, "77-token"), (4, {"missing_keys": ["decoder.x"]}, "completely")):
            calls = []
            with patch.dict("sys.modules", segmentation_fakes(calls, token_length, info)), self.assertRaisesRegex(ValueError, message):
                clipseg_mask.generate_mask(Path("/approved/clipseg"), Image.new("RGB", (64, 64)), "jacket", 0.45)
            self.assertFalse(any(call[0] == "inference" for call in calls))

    def test_resident_cache_reuses_exact_pixels_and_reloads_changed_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = local_model(Path(directory) / "clipseg")
            cache, calls = clipseg_mask.MaskCache(), []
            image = Image.new("RGB", (352, 352), "blue")
            prompt = "coat|shirt|skirt|jacket|sleeves"
            with patch.dict("sys.modules", segmentation_fakes(calls)):
                original = clipseg_mask.generate_mask(root, image, prompt, 0.5, cache=cache)
                self.assertEqual([value.shape for value in cache.conditioning], [(4, 512), (1, 512)])
                for snapshot, call in zip(cache.conditioning, [row for row in calls if row[0] == "conditioning"]):
                    self.assertFalse(np.shares_memory(snapshot, call[1]))
                    call[1][:] = -123  # Returned model tensors cannot contaminate snapshots.
                # Threshold stays outside the logits key; returned images are independent.
                repeated = clipseg_mask.generate_mask(root, image.copy(), f" {prompt} |coat ", 0.6, cache=cache)
                self.assertEqual(original.tobytes(), repeated.tobytes())
                repeated.paste(0, (0, 0, 64, 64))
                self.assertEqual(clipseg_mask.generate_mask(root, image, prompt, 0.5, cache=cache).tobytes(), original.tobytes())
                self.assertEqual(sum(row[0] == "model" for row in calls), 1)
                self.assertEqual(sum(row[0] == "inference" for row in calls), 2)
                self.assertEqual(cache.logits.nbytes, 352 * 352 * 4)
                changed = image.copy()
                changed.putpixel((0, 0), (1, 2, 3))
                reused = clipseg_mask.generate_mask(root, changed, prompt, 0.5, cache=cache)
                self.assertEqual([row[1][0] for row in calls if row[0] == "inference"], [4, 1, 4, 1])
                self.assertEqual(sum(row[0] == "text_inference" for row in calls), 2)
                for snapshot, call in zip(cache.conditioning, [row for row in calls if row[0] == "conditioning"][-2:]):
                    self.assertEqual(call[2], ("conditional_embeddings",))
                    self.assertFalse(np.shares_memory(snapshot, call[1]))
                    np.testing.assert_array_equal(snapshot, call[1])
                    call[1][:] = -456
                    self.assertTrue(np.all(snapshot >= 0))
                with patch.dict("sys.modules", segmentation_fakes([], expose_conditioning=False)):
                    expected = clipseg_mask.generate_mask(root, changed, prompt, 0.5)
                self.assertEqual(reused.tobytes(), expected.tobytes())
                clipseg_mask.generate_mask(root, changed, "|".join(reversed(prompt.split("|"))), 0.5, cache=cache)
                self.assertEqual(sum(row[0] == "text_inference" for row in calls), 4)
                clipseg_mask.generate_mask(root, changed, "coat", 0.5, cache=cache)
                self.assertEqual(sum(row[0] == "model" for row in calls), 1)
                self.assertEqual(sum(row[0] == "inference" for row in calls), 7)
                # Same-length content and restored mtime still invalidate the model.
                weights = root / "model.safetensors"
                stat = weights.stat()
                weights.write_bytes(b"x" * stat.st_size)
                import os
                os.utime(weights, ns=(stat.st_atime_ns, stat.st_mtime_ns))
                clipseg_mask.generate_mask(root, changed, "coat", 0.5, cache=cache)
                self.assertEqual(sum(row[0] == "model" for row in calls), 2)
                self.assertEqual(sum(row[0] == "inference" for row in calls), 8)
                self.assertEqual(sum(row[0] == "text_inference" for row in calls), 6)
                optional = root / "tokenizer.json"
                for value in ('{"optional":1}', '{"optional":2}', None):
                    if value is None:
                        optional.unlink()
                    else:
                        optional.write_text(value)
                    clipseg_mask.generate_mask(root, changed, "coat", 0.5, cache=cache)
                self.assertEqual(sum(row[0] == "model" for row in calls), 5)
                self.assertEqual(sum(row[0] == "inference" for row in calls), 11)
                self.assertEqual(sum(row[0] == "text_inference" for row in calls), 9)
            cache.clear()
            self.assertIsNone(cache.components)
            self.assertIsNone(cache.logits)
            self.assertIsNone(cache.conditioning_key)
            self.assertIsNone(cache.conditioning)

    def test_conditioning_payload_limit_skips_retention_without_rejecting_mask(self):
        with tempfile.TemporaryDirectory() as directory:
            root = local_model(Path(directory) / "clipseg")
            cache, calls = clipseg_mask.MaskCache(), []
            image = Image.new("RGB", (64, 64))
            with patch.dict("sys.modules", segmentation_fakes(calls, projection_dim=4096)):
                clipseg_mask.generate_mask(root, image, "a|b|c|d", 0.5, cache=cache)
                self.assertEqual(sum(value.numel() * value.element_size() for value in cache.conditioning), 64 * 1024)
                mask = clipseg_mask.generate_mask(root, image, "a|b|c|d|e", 0.5, cache=cache)
                self.assertIsNotNone(mask.getbbox())
                self.assertIsNotNone(cache.logits)
                self.assertIsNone(cache.conditioning_key)
                self.assertIsNone(cache.conditioning)

    def test_resident_mask_failure_and_loading_mutation_clear_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = local_model(Path(directory) / "clipseg")
            image = Image.new("RGB", (64, 64))
            cache = clipseg_mask.MaskCache()
            with patch.dict("sys.modules", segmentation_fakes([])):
                clipseg_mask.generate_mask(root, image, "coat", 0.5, cache=cache)
                with self.assertRaisesRegex(ValueError, "maskPrompt"):
                    clipseg_mask.generate_mask(root, image, "|", 0.5, cache=cache)
                self.assertIsNone(cache.components)
                self.assertIsNone(cache.logits)
                self.assertIsNone(cache.conditioning_key)
                self.assertIsNone(cache.conditioning)
                clipseg_mask.generate_mask(root, image, "coat", 0.5, cache=cache)
                def failed_mask(*args):
                    self.assertEqual(cache.conditioning_key, ("coat",), "publish only after a valid final mask")
                    raise ValueError("no editable pixels")
                with patch.object(clipseg_mask, "logits_mask", side_effect=failed_mask), self.assertRaisesRegex(ValueError, "no editable"):
                    clipseg_mask.generate_mask(root, image, "coat|shirt|skirt|jacket|sleeves", 0.5, cache=cache)
                self.assertIsNone(cache.components)
                self.assertIsNone(cache.logits)
                self.assertIsNone(cache.conditioning_key)
                self.assertIsNone(cache.conditioning)
                with patch.object(clipseg_mask, "model_identity", side_effect=[("before",), ("after",)]), \
                        self.assertRaisesRegex(ValueError, "changed while loading"):
                    clipseg_mask.generate_mask(root, image, "coat", 0.5, cache=cache)
                self.assertIsNone(cache.identity)
                self.assertIsNone(cache.components)
                self.assertIsNone(cache.logits)
                self.assertIsNone(cache.conditioning_key)
                self.assertIsNone(cache.conditioning)

    def test_expected_profile_scope_binds_cached_and_uncached_masks(self):
        for cache in (None, clipseg_mask.MaskCache()):
            with self.subTest(cached=cache is not None), tempfile.TemporaryDirectory() as directory:
                root = local_model(Path(directory) / "clipseg")
                image, calls = Image.new("RGB", (64, 64)), []
                # Acceptance uses the profile's canonical algorithm, not a test copy.
                expected = profiles.canonical_sha256(clipseg_mask.model_identity(root)[1])
                modules = segmentation_fakes(calls)
                with patch.dict("sys.modules", modules):
                    with patch.object(clipseg_mask, "model_identity", wraps=clipseg_mask.model_identity) as identities:
                        clipseg_mask.generate_mask(root, image, "coat", 0.5, cache=cache, expected_mask_sha256=expected)
                        self.assertEqual(identities.call_count, 2)
                        if cache is not None:
                            clipseg_mask.generate_mask(root, image, "coat", 0.5, cache=cache, expected_mask_sha256=expected)
                            self.assertTrue(cache.result_reused)
                            self.assertEqual(identities.call_count, 3, "bound cache hit needs only its existing byte scan")
                    weights = root / "model.safetensors"
                    weights.write_bytes(b"CHANGED BEFORE GENERATION")
                    before = len(calls)
                    with self.assertRaisesRegex(ValueError, "profile scope"):
                        clipseg_mask.generate_mask(root, image, "coat", 0.5, cache=cache, expected_mask_sha256=expected)
                    self.assertEqual(len(calls), before, "scope mismatch must fail before loaders or inference")
                    if cache is not None:
                        self.assertIsNone(cache.components)
                        self.assertIsNone(cache.logits)
                    expected = profiles.canonical_sha256(clipseg_mask.model_identity(root)[1])
                    model = modules["transformers"].CLIPSegForImageSegmentation
                    load = model.from_pretrained
                    def replaced_while_loading(*args, **kwargs):
                        weights.write_bytes(b"CHANGED DURING LOADING")
                        return load(*args, **kwargs)
                    before = sum(row[0] == "inference" for row in calls)
                    with patch.object(model, "from_pretrained", side_effect=replaced_while_loading), \
                            self.assertRaisesRegex(ValueError, "changed while loading"):
                        clipseg_mask.generate_mask(root, image, "coat", 0.5, cache=cache, expected_mask_sha256=expected)
                    self.assertEqual(sum(row[0] == "inference" for row in calls), before)
                    if cache is not None:
                        self.assertIsNone(cache.identity)
                        self.assertIsNone(cache.components)
                        self.assertIsNone(cache.logits)

    def test_worker_auto_mask_contract_and_same_masked_denoise_path(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            mask_model = local_model(root / "clipseg")
            source = root / "source.png"
            Image.new("RGB", (16, 32), "blue").save(source)
            request = {"id": "auto", "op": "generate", "modelDir": str(root), "maskModelDir": str(mask_model),
                "inputImagePath": str(source), "outputPath": str(root / "out.png"),
                "input": {"prompt": "test", "maskPrompt": "jacket", "maskThreshold": 0.5,
                    "growMaskBy": 0, "width": 64, "height": 64, "steps": 2}}
            self.assertEqual(worker.validate_job(request)["maskThreshold"], 0.5)
            for key, invalid in (("maskThreshold", float("nan")), ("maskThreshold", 0.96), ("growMaskBy", True), ("maskPrompt", "|")):
                with self.subTest(key=key), self.assertRaises(worker.WorkerError):
                    worker.validate_job({**request, "input": {**request["input"], key: invalid}})
            with self.assertRaisesRegex(worker.WorkerError, "cannot be combined"):
                worker.validate_job({**request, "maskImagePath": str(source)})
            no_source = {**request, "inputImagePath": None}
            with self.assertRaisesRegex(worker.WorkerError, "requires inputImagePath"):
                worker.validate_job(no_source)
            arguments = {}
            class Pipeline:
                scheduler = types.SimpleNamespace(step=lambda: None)
                def __call__(self, **kwargs):
                    arguments.update(kwargs)
                    return [Image.new("RGB", (64, 64), "red")]
            cache = types.SimpleNamespace(stats=lambda: {"resultReused": True})
            auto_module = types.SimpleNamespace(phrases=clipseg_mask.phrases, validate_model=clipseg_mask.validate_model,
                                               MaskCache=Mock(return_value=cache))
            cache_options = []
            def segment(model, image, prompt, threshold, **options):
                cache_options.append(options)
                self.assertEqual(image.size, (64, 64))
                logits = np.full((352, 352), -8, dtype=np.float32)
                logits[:, 176:] = 8
                return clipseg_mask.logits_mask(logits, image.size, threshold)
            auto_module.generate_mask = segment
            modules = fake_modules([])
            modules["torch"].Generator = lambda device: types.SimpleNamespace(manual_seed=lambda seed: "seeded")
            modules["torch"].bfloat16 = "fixture bf16"
            modules["torch"].cuda = types.SimpleNamespace(reset_peak_memory_stats=lambda _: None,
                synchronize=lambda: None, max_memory_allocated=lambda _: 0,
                is_available=lambda: True, is_bf16_supported=lambda: True, get_device_name=lambda _: "fixture GPU")
            profile_module = types.SimpleNamespace(RUNTIME=profiles.RUNTIME, model_identity=lambda *args: {"loras": []},
                compatibility=lambda *args, **kwargs: {"maskModelSha256": "a" * 64}, TeaCacheError=profiles.TeaCacheError)
            tea_module = types.SimpleNamespace(TeaCacheController=lambda *args: object())
            resident = types.SimpleNamespace(mask_cache=None, text_cache=None, weights_loaded=False,
                prepare=lambda check: check(), acquire=lambda *args: (Pipeline(), True))
            with patch.dict("sys.modules", modules), patch.object(worker, "dependencies"), \
                    patch.object(worker, "validate_model", return_value=root), \
                    patch.object(worker, "load_mask_tools", side_effect=lambda name="masked_anima":
                        {"clipseg_mask": auto_module, "teacache_profile": profile_module,
                         "resident_benchmark": resident_benchmark, "inference_metrics": inference_metrics,
                         "teacache_anima": tea_module}.get(name, masked_anima)), \
                    patch.object(worker, "load_pipeline", return_value=Pipeline()) as load:
                cold = worker.generate(request, io.StringIO(), measure_teacache=True)
                self.assertIs(cold["maskCacheEnabled"], False)
                enabled = worker.generate(request, io.StringIO(), resident=resident, cache_text=False, measure_teacache=True)
                self.assertIs(enabled["maskCacheEnabled"], True)
                self.assertEqual(enabled["maskCache"], cache.stats())
                self.assertEqual(cache_options[-1], {"cache": cache})
                disabled = worker.generate(request, io.StringIO(), resident=resident, cache_text=False,
                    cache_mask=False, measure_teacache=True)
                self.assertIs(disabled["maskCacheEnabled"], False)
                self.assertNotIn("maskCache", disabled)
                self.assertEqual(cache_options[-1], {})
                self.assertIs(resident.mask_cache, cache)
                resident.mask_cache = None
                worker.generate(request, io.StringIO(), resident=resident, cache_text=False, cache_mask=False)
                self.assertIsNone(resident.mask_cache)
                auto_module.MaskCache.assert_called_once_with()
                with patch.object(auto_module, "generate_mask", side_effect=ValueError("scope binding fixture")) as scoped:
                    with self.assertRaisesRegex(worker.WorkerError, "scope binding fixture"):
                        worker.generate(request, io.StringIO(), resident=resident, cache_text=False,
                            cache_mask=False, collect_teacache=True)
                    self.assertEqual(scoped.call_args.kwargs, {"expected_mask_sha256": "a" * 64})
            self.assertIsInstance(load.call_args.kwargs["blocks"], Blocks)
            self.assertEqual(arguments["mask_image"].getbbox(), (32, 0, 64, 64))
            with Image.open(root / "out.png") as output:
                self.assertEqual(output.getpixel((0, 0)), (0, 0, 255))
                self.assertEqual(output.getpixel((63, 0)), (255, 0, 0))


if __name__ == "__main__":
    unittest.main()
