"""CPU image tests and explicit NumPy-backed tensor/module fakes; no model acceptance."""
import io
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

import masked_anima
import worker


class Tensor(np.ndarray):
    def __new__(cls, values):
        return np.asarray(values, dtype=np.float32).view(cls)
    @property
    def device(self):
        return "fake-device"
    def to(self, device=None, dtype=None):
        return self
    def unsqueeze(self, axis):
        return np.expand_dims(self, axis)
    def repeat(self, count):
        return Tensor(np.tile(np.asarray(self), count))
    def new_zeros(self, *shape, dtype=None):
        return Tensor(np.zeros(shape))


class Param:
    def __init__(self, name, required=False):
        self.name, self.required = name, required


class Prepare:
    inputs = [Param(name) for name in ("image_latents", "timesteps", "generator", "latents", "dtype", "height", "width")]
    intermediate_outputs = [Param("latents"), Param("padding_mask")]
    def get_block_state(self, state):
        return types.SimpleNamespace(**{p.name: state[p.name] for p in self.inputs})
    def set_block_state(self, state, block):
        for p in self.inputs + self.intermediate_outputs:
            state[p.name] = getattr(block, p.name)


class After:
    inputs = []
    def __call__(self, components, block, i, t):
        block.latents = components.scheduler.step(None, t, block.latents, return_dict=False)[0]
        return components, block


class Blocks:
    def __init__(self):
        self.core = types.SimpleNamespace(sub_blocks={"prepare_latents": Prepare(), "denoise": types.SimpleNamespace(
            sub_blocks={"after_denoiser": After()})})
        self.sub_blocks = {"denoise": types.SimpleNamespace(sub_blocks={"img2img": self.core})}


def fake_modules(draws):
    def noise(shape, **kwargs):
        result = Tensor(np.full(shape, 0.8))
        draws.append((result, kwargs))
        return result
    def interpolate(mask, size, mode):
        assert mode == "nearest"
        y = np.arange(size[0]) * mask.shape[-2] // size[0]
        x = np.arange(size[1]) * mask.shape[-1] // size[1]
        return Tensor(mask[:, :, y][:, :, :, x])
    return {"torch": types.SimpleNamespace(float32=np.float32, no_grad=lambda: lambda fn: fn,
                from_numpy=Tensor, nn=types.SimpleNamespace(functional=types.SimpleNamespace(interpolate=interpolate))),
        "diffusers.utils.torch_utils": types.SimpleNamespace(randn_tensor=noise),
        "diffusers.modular_pipelines.modular_pipeline_utils": types.SimpleNamespace(InputParam=Param, OutputParam=Param),
        "diffusers.modular_pipelines.anima.before_denoise": types.SimpleNamespace(AnimaImg2ImgPrepareLatentsStep=Prepare),
        "diffusers.modular_pipelines.anima.denoise": types.SimpleNamespace(AnimaLoopAfterDenoiser=After),
        "diffusers.modular_pipelines.anima.modular_blocks_anima": types.SimpleNamespace(AnimaAutoBlocks=Blocks)}


class MaskTests(unittest.TestCase):
    def test_png_output_preserves_exact_pixels_and_reports_saved_size(self):
        pixels = np.arange(19 * 13 * 3, dtype=np.uint8).reshape(13, 19, 3)
        image = Image.fromarray(pixels)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "nested" / "result.png"
            report = masked_anima.save_png(image, output)
            with Image.open(output) as saved:
                self.assertEqual(saved.format, "PNG")
                self.assertEqual(saved.mode, image.mode)
                self.assertEqual(saved.size, image.size)
                self.assertEqual(saved.tobytes(), image.tobytes())
            self.assertEqual(report["outputBytes"], output.stat().st_size)
            self.assertGreaterEqual(report["outputSaveSeconds"], 0)
            self.assertEqual(list(output.parent.iterdir()), [output])

    def test_png_size_fallback_stays_atomic_and_cleans_up_failures(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "result.png"
            for fail in (False, True):
                with self.subTest(fallback_fails=fail):
                    output.write_bytes(b"previous output")
                    levels = []
                    def save(path, format, compress_level):
                        self.assertEqual(format, "PNG")
                        self.assertEqual(output.read_bytes(), b"previous output")
                        levels.append(compress_level)
                        if compress_level == 4:
                            with Path(path).open("wb") as stream:
                                stream.truncate(32 * 1024 * 1024 + 1)  # sparse, no giant image fixture
                        elif fail:
                            raise OSError("fixture fallback failure")
                        else:
                            Path(path).write_bytes(b"fake default-compressed PNG")
                    image = types.SimpleNamespace(save=save)
                    if fail:
                        with self.assertRaisesRegex(OSError, "fallback failure"):
                            masked_anima.save_png(image, output)
                        self.assertEqual(output.read_bytes(), b"previous output")
                    else:
                        report = masked_anima.save_png(image, output)
                        self.assertEqual(output.read_bytes(), b"fake default-compressed PNG")
                        self.assertEqual(report["outputBytes"], output.stat().st_size)
                    self.assertEqual(levels, [4, 6])
                    self.assertEqual(list(output.parent.iterdir()), [output])

    def test_bundled_helper_is_checked_before_dependency_diagnostics(self):
        module = worker.load_mask_tools()
        self.assertEqual(Path(module.__file__).resolve(), Path(worker.__file__).with_name("masked_anima.py").resolve())
        with patch("importlib.util.spec_from_file_location", side_effect=FileNotFoundError("missing helper")):
            with self.assertRaises(worker.WorkerError) as error:
                worker.dependencies()
        self.assertEqual(error.exception.code, "RUNTIME_INCOMPLETE")

    def test_alpha_growth_and_pixel_preservation_use_same_effective_mask(self):
        original = Image.new("RGB", (5, 5), "blue")
        paint = Image.new("RGBA", (5, 5), (255, 255, 255, 0))
        paint.putpixel((2, 2), (255, 255, 255, 255))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "mask.png"
            paint.save(path)
            resized, mask = masked_anima.prepare_images(original, path, (5, 5), 1)
            self.assertEqual(mask.getbbox(), (1, 1, 4, 4))
            generated = Image.new("RGB", (5, 5), "red")
            before = [image.tobytes() for image in (generated, resized, mask)]
            result = masked_anima.composite(generated, resized, mask)
            expected = Image.composite(generated.convert("RGB"), resized.convert("RGB"), mask)
            self.assertEqual(result.tobytes(), expected.tobytes())
            self.assertEqual(result.getpixel((0, 0)), original.getpixel((0, 0)))
            self.assertEqual(result.getpixel((1, 1)), (255, 0, 0))
            result.putpixel((0, 0), (1, 2, 3))
            self.assertEqual([image.tobytes() for image in (generated, resized, mask)], before)
            self.assertEqual(masked_anima.composite(generated.convert("RGBA"), resized, mask).tobytes(), expected.tobytes())
            paint.putpixel((2, 2), (255, 255, 255, 128))
            paint.save(path)
            _, soft_mask = masked_anima.prepare_images(original, path, (5, 5), 0)
            self.assertEqual(soft_mask.getpixel((2, 2)), 128)
            with self.assertRaisesRegex(ValueError, "dimensions"):
                masked_anima.prepare_images(Image.new("RGB", (4, 5)), path, (5, 5), 0)
            Image.new("RGBA", (5, 5), (255, 255, 255, 0)).save(path)
            with self.assertRaisesRegex(ValueError, "no editable"):
                masked_anima.prepare_images(original, path, (5, 5), 0)

    def test_custom_blocks_reuse_noise_and_restore_next_then_clean_latents(self):
        draws, scales = [], []
        # Sliced schedule starts at sigma .6, not at the full-schedule index zero.
        timesteps = Tensor([0.6, 0.2])
        class Scheduler:
            index = 0
            def scale_noise(self, image, timestep, noise):
                scales.append((timestep.copy(), noise))
                sigma = float(timestep[0])
                return sigma * noise + (1 - sigma) * image
            def step(self, prediction, t, latents, return_dict):
                self.index += 1
                return (latents + 1,)
        components = types.SimpleNamespace(_execution_device="fake-device", scheduler=Scheduler())
        image = Tensor(np.full((1, 2, 1, 2, 2), 0.1))
        mask = Image.new("L", (16, 16), 0)
        for x in range(8, 16):
            for y in range(16):
                mask.putpixel((x, y), 255)
        state = dict(image_latents=image, timesteps=timesteps, generator="seeded-generator", latents=None,
                     dtype=np.float32, height=16, width=16, mask_image=mask)
        with patch.dict("sys.modules", fake_modules(draws)):
            blocks = masked_anima.masked_blocks()
            core = blocks.sub_blocks["denoise"].sub_blocks["img2img"]
            prepare = core.sub_blocks["prepare_latents"]
            after = core.sub_blocks["denoise"].sub_blocks["after_denoiser"]
            prepare(components, state)
            self.assertEqual(state["latent_mask"].shape, (1, 1, 1, 2, 2))
            self.assertEqual(len(draws), 1)
            self.assertEqual(draws[0][1]["generator"], "seeded-generator")
            self.assertIs(scales[0][1], state["mask_noise"])
            self.assertEqual({p.name for p in after.inputs}, {"image_latents", "mask_noise", "latent_mask", "timesteps"})
            block = types.SimpleNamespace(**state)
            initial = block.latents.copy()
            _, block = after(components, block, 0, timesteps[0])
            np.testing.assert_allclose(block.latents[..., 0], 0.2 * 0.8 + 0.8 * 0.1)
            np.testing.assert_allclose(block.latents[..., 1], initial[..., 1] + 1)
            self.assertIs(scales[1][1], draws[0][0])
            self.assertAlmostEqual(float(scales[1][0][0]), 0.2)
            _, block = after(components, block, 1, timesteps[1])
            np.testing.assert_allclose(block.latents[..., 0], image[..., 0])
            np.testing.assert_allclose(block.latents[..., 1], initial[..., 1] + 2)
            self.assertEqual(len(scales), 2)  # final step never re-noises original
            # Precomputed noise remains exact; no hidden second random draw.
            state["latents"] = draws[0][0]
            prepare(components, state)
            self.assertEqual(len(draws), 1)
            self.assertIs(state["mask_noise"], draws[0][0])

    def test_generate_loads_bundled_helper_and_composites_after_masked_pipeline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = Image.new("RGB", (64, 64), "blue")
            original.save(root / "input.png")
            mask = Image.new("L", (64, 64), 0)
            mask.paste(255, (32, 0, 64, 64))
            mask.save(root / "mask.png")
            request = {"id": "mask", "op": "generate", "modelDir": str(root),
                "inputImagePath": str(root / "input.png"), "maskImagePath": str(root / "mask.png"),
                "outputPath": str(root / "out.png"),
                "input": {"prompt": "test", "width": 64, "height": 64, "steps": 1}}
            arguments = {}
            class Pipeline:
                scheduler = types.SimpleNamespace(step=lambda: None)
                def __call__(self, **kwargs):
                    arguments.update(kwargs)
                    self.scheduler.step()
                    return [Image.new("RGB", (64, 64), "red")]
            modules = fake_modules([])
            modules["torch"].Generator = lambda device: types.SimpleNamespace(manual_seed=lambda seed: "seeded")
            with patch.dict("sys.modules", modules), patch.object(worker, "validate_model", return_value=root), \
                    patch.object(worker, "dependencies"), patch.object(worker, "load_pipeline", return_value=Pipeline()) as load:
                worker.generate(request, io.StringIO())
            self.assertIsInstance(load.call_args.kwargs["blocks"], Blocks)
            self.assertEqual(arguments["mask_image"].getbbox(), (32, 0, 64, 64))
            with Image.open(root / "out.png") as result:
                self.assertEqual(result.getpixel((0, 0)), (0, 0, 255))
                self.assertEqual(result.getpixel((63, 0)), (255, 0, 0))

    def test_mask_contract_requires_source_and_bounded_integer_growth(self):
        with tempfile.TemporaryDirectory() as directory:
            image = Path(directory) / "image.png"
            image.touch()
            request = {"id": "test", "op": "generate", "maskImagePath": str(image),
                       "outputPath": str(Path(directory) / "out.png"), "input": {"prompt": "test"}}
            with self.assertRaises(worker.WorkerError):
                worker.validate_job(request)
            request["inputImagePath"] = str(image)
            self.assertEqual(worker.validate_job(request)["growMaskBy"], 0)
            for grow in (-1, 33, 0.5, True):
                request["input"]["growMaskBy"] = grow
                with self.subTest(grow=grow), self.assertRaises(worker.WorkerError):
                    worker.validate_job(request)
            request["input"] = {"prompt": "test", "maskPrompt": "clothes"}
            with self.assertRaisesRegex(worker.WorkerError, "maskPrompt"):
                worker.validate_job(request)


if __name__ == "__main__":
    unittest.main()
