"""Real Pillow/NumPy postprocessing and explicit fake CLIPSeg; no model/GPU run."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

import clipseg_mask
import masked_anima
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
        return self
    def detach(self):
        return self
    def numpy(self):
        return np.asarray(self)
    def repeat(self, *repeats):
        return Tensor(np.tile(np.asarray(self), repeats))


def segmentation_fakes(calls, token_length=4, info=None):
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
        def __call__(self, pixel_values, input_ids, attention_mask, return_dict):
            calls.append(("inference", pixel_values.shape, input_ids.shape, return_dict))
            output = np.full((len(input_ids), 352, 352), -8, dtype=np.float32)
            for index, phrase in enumerate(input_ids[:, 0]):
                left = int(phrase) * 60
                output[index, :, left:left + 20] = 8
            return types.SimpleNamespace(logits=Tensor(output))
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
            outside = Path(directory) / "external.safetensors"
            outside.write_bytes(b"FAKE")
            weights.symlink_to(outside)
            with self.assertRaisesRegex(ValueError, "unsafe"):
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
        with patch.dict("sys.modules", segmentation_fakes(calls)):
            mask = clipseg_mask.generate_mask(Path("/approved/clipseg"), Image.new("RGB", (352, 352)),
                "coat|shirt|skirt|jacket|sleeves", 0.5)
        self.assertEqual([call[1][0] for call in calls if call[0] == "inference"], [4, 1])
        for x in (0, 60, 120, 180, 240):
            self.assertEqual(mask.getpixel((x, 0)), 255)
            self.assertEqual(mask.getpixel((x + 30, 0)), 0)
        for call in calls:
            if call[0] in {"tokenizer", "processor", "model"}:
                self.assertEqual(call[1], "/approved/clipseg")
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
            auto_module = types.SimpleNamespace(phrases=clipseg_mask.phrases, validate_model=clipseg_mask.validate_model)
            def segment(model, image, prompt, threshold):
                self.assertEqual(image.size, (64, 64))
                logits = np.full((352, 352), -8, dtype=np.float32)
                logits[:, 176:] = 8
                return clipseg_mask.logits_mask(logits, image.size, threshold)
            auto_module.generate_mask = segment
            modules = fake_modules([])
            modules["torch"].Generator = lambda device: types.SimpleNamespace(manual_seed=lambda seed: "seeded")
            with patch.dict("sys.modules", modules), patch.object(worker, "dependencies"), \
                    patch.object(worker, "validate_model", return_value=root), \
                    patch.object(worker, "load_mask_tools", side_effect=lambda name="masked_anima": auto_module if name == "clipseg_mask" else masked_anima), \
                    patch.object(worker, "load_pipeline", return_value=Pipeline()) as load:
                worker.generate(request, io.StringIO())
            self.assertIsInstance(load.call_args.kwargs["blocks"], Blocks)
            self.assertEqual(arguments["mask_image"].getbbox(), (32, 0, 64, 64))
            with Image.open(root / "out.png") as output:
                self.assertEqual(output.getpixel((0, 0)), (0, 0, 255))
                self.assertEqual(output.getpixel((63, 0)), (255, 0, 0))


if __name__ == "__main__":
    unittest.main()
