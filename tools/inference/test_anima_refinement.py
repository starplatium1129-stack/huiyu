"""CPU orchestration with real sigma schedules, tensors, PIL and RCAS; no ML assets."""
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image
import torch
from diffusers import FlowMatchEulerDiscreteScheduler
from diffusers.models.transformers.transformer_cosmos import CosmosRotaryPosEmbed
from diffusers.modular_pipelines.anima.modular_blocks_anima import AnimaAutoBlocks

import anima_sampling as sampling
import anima_postprocess as postprocess
import anima_refinement as refinement


class Vae:
    use_tiling = False
    tile_sample_min_height = tile_sample_min_width = 256
    tile_sample_stride_height = tile_sample_stride_width = 192

    def enable_tiling(self, **kwargs):
        self.use_tiling = True
        self.__dict__.update(kwargs)


class Transformer(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.shapes = []
        self.rope = SimpleNamespace(max_size=[128, 120, 120], patch_size=(1, 2, 2))

    def forward(self, hidden_states, **kwargs):
        self.shapes.append(tuple(hidden_states.shape[-2:]))
        return (torch.zeros_like(hidden_states),)


class Pipeline:
    """Actual Euler scheduler; explicit fake transformer/VAE output only."""
    _execution_device = "cpu"

    def __init__(self, first=None):
        self.scheduler = FlowMatchEulerDiscreteScheduler(shift=3)
        self.vae = first.vae if first else Vae()
        self.transformer = first.transformer if first else Transformer()
        self.components = dict(vae=self.vae, transformer=self.transformer, image_processor=object())
        self.blocks = AnimaAutoBlocks()
        self.calls = []

    def update_components(self, **components):
        self.components = components
        self.scheduler = components["scheduler"]

    def set_progress_bar_config(self, **kwargs):
        pass

    def __call__(self, **kwargs):
        self.calls.append(kwargs)
        self.decode_present = "decode" in self.blocks.sub_blocks
        steps = kwargs["num_inference_steps"]
        sigmas = kwargs.get("sigmas", np.linspace(1, 1 / steps, steps).tolist())
        self.scheduler.set_timesteps(sigmas=sigmas, device="cpu")
        start = int(steps - steps * kwargs.get("strength", 1))
        self.scheduler.set_begin_index(start)
        height, width = kwargs["height"], kwargs["width"]
        shape = (1, 16, 1, height // 8, width // 8)
        noise = torch.randn(shape, generator=kwargs["generator"])
        self.rng_after_draw = kwargs["generator"].get_state().clone()
        latents = kwargs.get("image_latents", noise)
        for timestep in self.scheduler.timesteps[start:]:
            prediction = self.transformer(latents, return_dict=False)[0]
            latents = self.scheduler.step(prediction, timestep, latents, return_dict=False)[0]
        self.active_sigmas = self.scheduler.sigmas[start:].clone()
        images = torch.full((1, 3, height, width), .8)
        values = dict(images=images, latents=latents, prompt_embeds=torch.ones(1, 4, 8),
                      negative_prompt_embeds=torch.zeros(1, 4, 8))
        if isinstance(kwargs["output"], list):
            return {name: values[name] for name in kwargs["output"]}
        if kwargs["output_type"] == "pil":
            return [Image.new("RGB", (width, height), (204, 204, 204))]
        return images


def data(**changes):
    values = dict(prompt="test", negativePrompt="none", width=32, height=48, steps=20, cfg=4,
                seed=100, sampler="euler", scheduler="normal", denoisingStrength=.8,
                hiresFix=True, hiresScale=1.25, hiresDenoise=.35, hiresUpscaler="Latent",
                hiresSampler="euler", hiresScheduler="normal", rcasStrength=.75)
    values.update(changes)
    return values


class RefinementTests(unittest.TestCase):
    def test_nonfinite_decoded_pixels_are_not_cast_to_a_black_image(self):
        image = torch.zeros((1, 3, 8, 8))
        image[0, 1, 4, 4] = float("nan")
        with self.assertRaisesRegex(ValueError, "nonfinite pixels"):
            refinement._pil(image)
    def test_hires_rope_extends_coordinates_and_restores_on_success_or_failure(self):
        class RopeTransformer(Transformer):
            def __init__(self):
                super().__init__()
                self.rope = CosmosRotaryPosEmbed(hidden_size=128)
                self.fail = False

            def forward(self, hidden_states, **kwargs):
                self.positions = self.rope(hidden_states)
                if self.fail:
                    raise RuntimeError("after RoPE")
                return (torch.zeros_like(hidden_states),)

        transformer = RopeTransformer()
        original_max = transformer.rope.max_size
        original_ntk = (transformer.rope.t_ntk_factor, transformer.rope.h_ntk_factor,
                        transformer.rope.w_ntk_factor)
        reference = transformer.rope(torch.zeros(1, 16, 1, 256, 208))

        def execute():
            with refinement._patch_grid(transformer):
                self.assertIs(transformer.rope.max_size, original_max)
                prediction = transformer(torch.zeros(1, 16, 1, 304, 208))[0]
                self.assertEqual(prediction.shape[-2:], (304, 208))
                self.assertEqual(transformer.rope.max_size, [128, 152, 120])

        for fail in (False, True):
            with self.subTest(fail=fail):
                transformer.fail = fail
                if fail:
                    with self.assertRaisesRegex(RuntimeError, "after RoPE"):
                        execute()
                else:
                    execute()
                for old, full in zip(reference, transformer.positions):
                    self.assertEqual(full.shape, (152 * 104, 128))
                    self.assertTrue(torch.equal(old.reshape(128, 104, 128),
                                                full.reshape(152, 104, 128)[:128]))
                self.assertIs(transformer.rope.max_size, original_max)
                self.assertEqual(original_max, [128, 120, 120])
                self.assertEqual((transformer.rope.t_ntk_factor, transformer.rope.h_ntk_factor,
                                  transformer.rope.w_ntk_factor), original_ntk)
                self.assertNotIn("forward", transformer.__dict__)
        self.assertFalse(torch.cuda.is_initialized())

    def test_legacy_pil_path_needs_no_scheduler_config(self):
        image = Image.new("RGB", (32, 48), "red")
        calls = []
        scheduler = SimpleNamespace(step=lambda: None)
        class Legacy:
            _execution_device = "cpu"
            def __call__(self, **kwargs):
                calls.append(kwargs)
                self.scheduler.step()
                return [image]
        pipeline = Legacy()
        pipeline.scheduler = scheduler
        request = data()
        request.update(hiresFix=False, rcasStrength=0)
        actual, steps, report = refinement.run(pipeline, request)
        self.assertIs(actual, image)
        self.assertEqual(steps, 1)
        self.assertEqual((calls[0]["output_type"], calls[0]["output"]), ("pil", "images"))
        self.assertEqual(calls[0]["generator"].device, torch.device("cpu"))
        self.assertEqual(report["secondPassSteps"], 0)

    def test_latent_second_pass_uses_tail_steps_new_rng_and_odd_grid(self):
        public = refinement.plan(data(width=1024, height=1024, hiresScale=1.1))
        self.assertEqual((public["width"], public["height"]), (1128, 1128))
        first, progress = Pipeline(), []
        second = Pipeline(first)
        with patch.object(refinement, "_second_pipeline", return_value=second):
            image, steps, report = refinement.run(first, data(), sampling=sampling, postprocess=postprocess,
                                                   progress=lambda n, total: progress.append((n, total)))
        self.assertEqual(image.size, (40, 64))
        self.assertEqual((steps, report["secondPassSteps"], progress[-1]), (32, 12, (32, 32)))
        self.assertFalse(first.decode_present)
        self.assertIn("decode", first.blocks.sub_blocks)
        self.assertEqual(second.calls[0]["generator"].initial_seed(), 101)
        self.assertTrue(torch.equal(first.calls[0]["generator"].get_state(), first.rng_after_draw))
        self.assertEqual(second.calls[0]["image_latents"].shape[-2:], (8, 5))
        self.assertEqual(first.transformer.shapes[-1], (8, 6))
        self.assertNotIn("forward", first.transformer.__dict__)
        self.assertFalse(first.vae.use_tiling)
        self.assertEqual(first.vae.tile_sample_min_height, 256)
        expected = sampling.refinement_options("normal", 12, .35, second.scheduler)
        self.assertEqual(second.calls[0]["sigmas"], expected["sigmas"])
        self.assertEqual(len(second.active_sigmas), 13)

    def test_remacri_without_mask_is_pixel_only(self):
        first, calls = Pipeline(), []
        request = data()
        request["hiresUpscaler"] = "Remacri"
        def upscale(pixels):
            calls.append(pixels.dtype)
            return torch.nn.functional.interpolate(pixels, scale_factor=4, mode="nearest")
        with patch.object(refinement, "_second_pipeline", side_effect=AssertionError("no second pass")):
            image, steps, report = refinement.run(first, request, sampling=sampling, upscale=upscale)
        self.assertEqual((image.size, steps), ((40, 64), 20))
        self.assertEqual(calls, [torch.float32])
        self.assertIsNone(report["vaeTiling"])

    def test_masked_routes_preserve_resized_black_pixels(self):
        source = Image.fromarray(np.arange(48 * 32 * 3, dtype=np.uint8).reshape(48, 32, 3))
        mask = Image.fromarray(np.pad(np.full((48, 16), 255, dtype=np.uint8), ((0, 0), (16, 0))))
        for kind in ("Latent", "Remacri"):
            with self.subTest(kind=kind):
                first, encoded = Pipeline(), []
                second = Pipeline(first)
                request = data()
                request["hiresUpscaler"] = kind
                def encode(pipeline, pixels):
                    encoded.append(pixels.clone())
                    return torch.zeros(1, 16, 1, pixels.shape[-2] // 8, pixels.shape[-1] // 8)
                with patch.object(refinement, "_second_pipeline", return_value=second), \
                        patch.object(refinement, "_encode", side_effect=encode):
                    image, steps, report = refinement.run(first, request, image=source, mask=mask,
                        mask_tools=object(), sampling=sampling, postprocess=postprocess,
                        upscale=lambda x: torch.nn.functional.interpolate(x, scale_factor=4, mode="nearest"))
                resized_mask = mask.resize(image.size, Image.Resampling.NEAREST)
                black = np.asarray(resized_mask) == 0
                expected = np.asarray(source.resize(image.size, Image.Resampling.LANCZOS))
                np.testing.assert_array_equal(np.asarray(image)[black], expected[black])
                np.testing.assert_array_equal(np.asarray(second.calls[0]["mask_image"]), np.asarray(resized_mask))
                self.assertEqual((steps, report["secondPassSteps"]), (28, 12))
                self.assertEqual(len(encoded), 1)

    def test_second_pass_failure_restores_model_and_vae_configuration(self):
        first = Pipeline()
        second = Pipeline(first)
        class Failed:
            scheduler = second.scheduler
            def __call__(self, **kwargs):
                raise RuntimeError("second-pass failure")
        with patch.object(refinement, "_second_pipeline", return_value=Failed()):
            with self.assertRaisesRegex(RuntimeError, "second-pass failure"):
                refinement.run(first, data(), sampling=sampling, postprocess=postprocess)
        self.assertFalse(first.vae.use_tiling)
        self.assertEqual(first.vae.tile_sample_stride_width, 192)
        self.assertNotIn("forward", first.transformer.__dict__)
        self.assertIn("decode", first.blocks.sub_blocks)
        self.assertFalse(torch.cuda.is_initialized())

    def test_second_blocks_callback_and_pass_local_schedule_observations(self):
        for fail_second in (False, True):
            with self.subTest(fail_second=fail_second):
                first, created, prepared, observed = Pipeline(), [], [], []
                first_leaf = first.blocks.sub_blocks["denoise"].sub_blocks["img2img"].sub_blocks["denoise"].sub_blocks["denoiser"]
                class Second(Pipeline):
                    def __init__(self, blocks):
                        super().__init__(first)
                        self.blocks = blocks
                        created.append(self)
                    def __call__(self, **kwargs):
                        if fail_second:
                            raise RuntimeError("second callback test failure")
                        return super().__call__(**kwargs)
                def prepare(blocks):
                    self.assertNotIn("text_encoder", blocks.sub_blocks)
                    for name in ("text2image", "img2img"):
                        core = blocks.sub_blocks["denoise"].sub_blocks[name]
                        self.assertNotIn("text_conditioning", core.sub_blocks)
                        leaf = core.sub_blocks["denoise"].sub_blocks["denoiser"]
                        class Wrapped(type(leaf)):
                            pass
                        core.sub_blocks["denoise"].sub_blocks["denoiser"] = Wrapped()
                    prepared.append(blocks)
                    return blocks
                def observe(phase, scheduler, actual_steps):
                    observed.append((phase, scheduler, actual_steps))
                    return {"actualSteps": actual_steps, "sigmaCount": len(scheduler.sigmas)}
                with patch("diffusers.AnimaModularPipeline", Second):
                    call = lambda: refinement.run(first, data(teaCache=True), sampling=sampling,
                        postprocess=postprocess, prepare_second_blocks=prepare, observe_schedule=observe)
                    if fail_second:
                        with self.assertRaisesRegex(RuntimeError, "second callback"):
                            call()
                    else:
                        _, steps, report = call()
                        self.assertEqual(steps, 32)
                        self.assertEqual({k: v["actualSteps"] for k, v in report["schedules"].items()},
                                         {"first": 20, "second": 12})
                self.assertEqual(len(prepared), 1)
                self.assertIs(created[0].blocks, prepared[0])
                self.assertEqual([(phase, count) for phase, _, count in observed],
                                 [("first", 20)] if fail_second else [("first", 20), ("second", 12)])
                self.assertIs(observed[0][1], first.scheduler)
                self.assertIs(first.blocks.sub_blocks["denoise"].sub_blocks["img2img"].sub_blocks["denoise"].sub_blocks["denoiser"], first_leaf)
                self.assertNotIn("forward", first.transformer.__dict__)
                self.assertFalse(first.vae.use_tiling)
                self.assertIs(created[0].scheduler.step.__func__, FlowMatchEulerDiscreteScheduler.step)


if __name__ == "__main__":
    unittest.main()
