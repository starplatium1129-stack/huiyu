"""CPU layout/tile contracts. Actual Remacri weights are not an automatic test input."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import torch
from torch import nn
from torch.nn import functional as functional

import anima_upscale as helper


class NearestModel(nn.Module):
    def __init__(self):
        super().__init__()
        self.marker = nn.Parameter(torch.ones(1), requires_grad=False)
        self.shapes = []

    def forward(self, image):
        self.shapes.append(image.shape)
        return functional.interpolate(image * self.marker, scale_factor=4, mode="nearest")


class UpscaleTests(unittest.TestCase):
    def test_tiles_cover_batches_cropped_halos_and_partial_edges_without_mixing(self):
        model = NearestModel()
        image = torch.linspace(0, 1, 2 * 3 * 9 * 11).reshape(2, 3, 9, 11).to(torch.bfloat16)
        original = image.clone()
        result = helper.upscale_4x(model, image, tile_size=4, overlap=1)
        self.assertEqual(result.dtype, torch.float32)
        self.assertEqual(result.device, image.device)
        torch.testing.assert_close(result, functional.interpolate(image.float(), scale_factor=4, mode="nearest"), rtol=0, atol=0)
        self.assertTrue(torch.equal(image, original))
        self.assertEqual(len(model.shapes), 18)
        self.assertTrue(all(shape[0] == 1 and shape[2] <= 6 and shape[3] <= 6 for shape in model.shapes))

    def test_fixed_header_schema_rejects_unknown_missing_wrong_shape_and_precision_before_payload(self):
        with torch.device("meta"):
            model = helper._network()
        mapping, expected = helper._key_mapping(), model.state_dict()
        self.assertEqual(len(mapping), 702)
        self.assertEqual(set(mapping.values()), set(expected))

        class Header:
            def __enter__(self):
                return self
            def __exit__(self, *args):
                pass
            def keys(self):
                return keys
            def get_slice(self, key):
                shape = list(expected[mapping[key]].shape)
                return type("Slice", (), {"get_shape": lambda _: shape if mode != "shape" else [1],
                                          "get_dtype": lambda _: "F16" if mode == "dtype" else "F32"})()
            def get_tensor(self, key):
                raise AssertionError("invalid header must fail before tensor loading")

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory).resolve() / helper.WEIGHT_NAME
            path.write_bytes(b"FAKE HEADER PROVIDED BY EXPLICIT TEST DOUBLE")
            for mode in ("extra", "missing", "shape", "dtype"):
                keys = set(mapping)
                if mode == "extra":
                    keys.add("unknown.weight")
                if mode == "missing":
                    keys.remove("model.10.bias")
                with self.subTest(mode=mode), patch("safetensors.safe_open", return_value=Header()):
                    with self.assertRaises(ValueError):
                        helper.load_remacri(path)

    def test_tile_bounds_and_fp32_model_requirement(self):
        image, model = torch.zeros(1, 3, 1, 1), NearestModel()
        for tile_size, overlap in ((0, 0), (257, 0), (16, 16), (64, 65), (True, 0)):
            with self.assertRaises(ValueError):
                helper.upscale_4x(model, image, tile_size=tile_size, overlap=overlap)
        with self.assertRaisesRegex(ValueError, "FP32"):
            helper.upscale_4x(model.to(torch.bfloat16), image)
        self.assertFalse(torch.cuda.is_initialized())


if __name__ == "__main__":
    unittest.main()
