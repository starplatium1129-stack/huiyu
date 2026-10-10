"""Explicit NumPy tensor/module fakes prove skipping and wiring, not GPU quality."""
import copy
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

import numpy as np

import teacache_anima as tea
import teacache_profile as profiles
import worker
from test_worker import model as model_fixture, job as job_fixture


class Tensor(np.ndarray):
    def __new__(cls, value, dtype=np.float32, device="cuda"):
        result = np.asarray(value, dtype=dtype).view(cls)
        result._device = device
        return result
    def __array_finalize__(self, source):
        self._device = getattr(source, "_device", "cuda")
    @property
    def device(self):
        return self._device
    def detach(self):
        return self
    def clone(self):
        return self.copy()
    def float(self):
        return self.astype(np.float32)
    def abs(self):
        return np.abs(self)
    def to(self, dtype):
        return self
    def has_names(self):
        return False
    def item(self):
        return super().item()


def fake_torch():
    return types.SimpleNamespace(is_grad_enabled=lambda: False, isfinite=np.isfinite, equal=np.array_equal,
        clamp=lambda value, min: np.maximum(value, min),
        no_grad=lambda: lambda fn: fn, bfloat16="torch.bfloat16", float16="torch.float16",
        cuda=types.SimpleNamespace(is_available=lambda: True, is_bf16_supported=lambda: True,
            get_device_name=lambda _: "fake CUDA", synchronize=lambda: None, max_memory_allocated=lambda _: 1234,
            reset_peak_memory_stats=lambda _: None),
        Generator=lambda device: types.SimpleNamespace(manual_seed=lambda seed: seed))


def profile(scope=None):
    return dict(schemaVersion=1, algorithm=profiles.ALGORITHM, runtime=profiles.RUNTIME,
        compatibility=scope or {}, coefficients=[0.01], proxyRange=[0, 1], defaultThreshold=0.15,
        maxThreshold=0.2, maxConsecutiveSkips=2,
        calibration=dict(source="local-full-compute", sampleCount=8, traceSha256="a" * 64),
        acceptance=dict(status="accepted", reportSha256="b" * 64))


class Block:
    def __init__(self):
        self.calls = 0
    def norm1(self, hidden, embedded, temb):
        return hidden + embedded, Tensor(1)
    def forward(self, hidden, encoder, embedded, temb, rotary, extra, mask, control):
        self.calls += 1
        return hidden + extra + encoder.mean()
    def __call__(self, *args):
        return self.forward(*args)


class Model:
    gradient_checkpointing = False
    def __init__(self):
        self.transformer_blocks = [Block() for _ in range(3)]
        self.head_calls = 0
    def __call__(self, **kwargs):
        hidden = kwargs["hidden_states"]
        for block in self.transformer_blocks:
            hidden = block(hidden, kwargs["encoder_hidden_states"], kwargs["timestep"], None,
                           None, Tensor(0.2), None, None)
        self.head_calls += 1
        return (hidden * 2 + kwargs["timestep"],)


def arguments(step, total=7, branch="cond", **overrides):
    values = dict(branch=branch, step=step, total=total, timestep_value=1 - step * 0.1,
        hidden_states=Tensor(np.ones((1, 2, 1, 2, 2)) + step * 0.001),
        encoder_hidden_states=Tensor([1] if branch == "cond" else [4]),
        padding_mask=Tensor(np.zeros((1, 1, 16, 16))), timestep=Tensor(1 - step * 0.1), return_dict=False)
    values.update(overrides)
    return values


class Param:
    def __init__(self, name, required=False):
        self.name = name


class Denoiser:
    inputs = []
    _guider_input_fields = {"encoder_hidden_states": ("prompt_embeds", "negative_prompt_embeds")}


class AutoBlocks:
    def __init__(self):
        self.sub_blocks = {"denoise": types.SimpleNamespace(sub_blocks={name:
            types.SimpleNamespace(sub_blocks={"denoise": types.SimpleNamespace(
                sub_blocks={"denoiser": Denoiser(), "after_denoiser": object()})})
            for name in ("text2image", "img2img")})}


def modules():
    return {"torch": fake_torch(),
        "diffusers.modular_pipelines.anima.denoise": types.SimpleNamespace(AnimaLoopDenoiser=Denoiser),
        "diffusers.modular_pipelines.modular_pipeline_utils": types.SimpleNamespace(InputParam=Param),
        "diffusers.modular_pipelines.anima.modular_blocks_anima": types.SimpleNamespace(AnimaAutoBlocks=AutoBlocks)}


class Guider:
    def __init__(self):
        self.cleanups = 0
    def set_state(self, **kwargs):
        pass
    def prepare_inputs_from_block_state(self, state, fields):
        return [types.SimpleNamespace(encoder_hidden_states=value) for value in
                (state.prompt_embeds, state.negative_prompt_embeds)]
    def prepare_models(self, model):
        pass
    def cleanup_models(self, model):
        self.cleanups += 1
    def __call__(self, batches):
        return (batches[0].noise_pred - batches[1].noise_pred,)


class TeaTests(unittest.TestCase):
    def test_exact_input_comparisons_share_one_scalar_read(self):
        with patch.dict("sys.modules", modules()):
            for values, expected in (([1, 2], True), ([], True), ([np.nan], False)):
                with self.subTest(values=values):
                    conditioning, padding = Tensor(values), Tensor([0])
                    lane = dict(conditioning=conditioning.clone(), padding=padding.clone())
                    with patch.object(Tensor, "item", autospec=True, side_effect=Tensor.item) as scalar:
                        self.assertEqual(tea.same_inputs(conditioning, padding, lane), expected)
                    self.assertEqual(scalar.call_count, 1)
            padding = Tensor([0], device="other-device")
            lane = dict(conditioning=Tensor([1]), padding=padding.clone())
            self.assertTrue(tea.same_inputs(Tensor([1]), padding, lane))

    def test_relative_l1_converts_each_input_to_float32_only_once(self):
        with patch.dict("sys.modules", modules()):
            for values in (([3, 6], [1, 2]), ([60000], [-60000])):
                with self.subTest(values=values):
                    current, previous = (Tensor(value, dtype=np.float16) for value in values)
                    with patch.object(Tensor, "float", autospec=True, side_effect=Tensor.float) as cast:
                        self.assertEqual(tea.relative_l1(current, previous), 2)
                    self.assertEqual(cast.call_count, 2)
                    self.assertIs(cast.call_args_list[0].args[0], current)
                    self.assertIs(cast.call_args_list[1].args[0], previous)

    def test_phase_envelope_preserves_spikes_refreshes_phase_boundaries_and_rejects_unseen_range(self):
        value = profile()
        value.update(schemaVersion=2, algorithm=profiles.PHASE_ALGORITHM,
                     phaseEnvelopes=[[[0, 0.01], [0.1, 0.03]], [[0, 0.2], [0.1, 0.3]], [[0, 0.01], [0.1, 0.02]]])
        self.assertEqual(profiles.validate_profile(value, {}), 0.15)
        self.assertEqual(tea.estimate_change(value, .05, 3, 10), .3)
        self.assertIsNone(tea.estimate_change(value, .2, 1, 10))
        model, cache = Model(), tea.TeaCacheController(value, .15)
        with patch.dict("sys.modules", modules()):
            for step in range(10):
                before = cache.stats["fullComputes"]
                cache.call(model, **arguments(step, total=10))
                if step in (0, 3, 4, 5, 6, 9):
                    self.assertEqual(cache.stats["fullComputes"], before + 1)
        self.assertGreater(cache.stats["skippedComputes"], 0)
        self.assertFalse(any("forward" in block.__dict__ for block in model.transformer_blocks))
        value["phaseEnvelopes"][0][1][0] = 0
        with self.assertRaisesRegex(profiles.TeaCacheError, "strictly ordered"):
            profiles.validate_profile(value, {})

    def test_real_block_skip_cfg_isolation_endpoints_bounds_and_current_head(self):
        model, cache = Model(), tea.TeaCacheController(profile(), 0.15)
        with patch.dict("sys.modules", modules()), patch.object(tea, "relative_l1", wraps=tea.relative_l1) as metric:
            for step in range(7):
                for branch in ("cond", "uncond"):
                    kwargs = arguments(step, branch=branch)
                    result = cache.call(model, **kwargs)[0]
                    expected = (kwargs["hidden_states"] + 3 * (0.2 + kwargs["encoder_hidden_states"].mean())) * 2 + kwargs["timestep"]
                    np.testing.assert_allclose(result, expected, rtol=1e-6)
        # Runtime needs only consecutive proxy comparisons, never residual calibration metrics.
        self.assertEqual(metric.call_count, 12)
        self.assertEqual(cache.samples, [])
        self.assertEqual(cache.stats["fullComputes"], 6)
        self.assertEqual(cache.stats["skippedComputes"], 8)
        self.assertEqual(cache.stats["skippedBlocks"], 24)
        self.assertEqual([b.calls for b in model.transformer_blocks], [6, 6, 6])
        self.assertEqual(model.head_calls, 14)
        self.assertTrue(all("forward" not in block.__dict__ for block in model.transformer_blocks))
        cache.clear()
        self.assertFalse(cache.lanes)

    def test_resets_on_scope_or_schedule_changes_and_never_crosses_model(self):
        changes = [dict(step=0), dict(step=2), dict(timestep_value=1), dict(total=8),
            dict(encoder_hidden_states=Tensor([2])), dict(padding_mask=Tensor(np.ones((1, 1, 16, 16)))),
            dict(hidden_states=Tensor(np.ones((1, 2, 1, 4, 4)))),
            dict(hidden_states=Tensor(np.ones((1, 2, 1, 2, 2)), dtype=np.float64)),
            dict(hidden_states=Tensor(np.ones((1, 2, 1, 2, 2)), device="other-device"))]
        with patch.dict("sys.modules", modules()):
            for change in changes:
                with self.subTest(change=list(change)):
                    model, cache = Model(), tea.TeaCacheController(profile(), 0.15)
                    cache.call(model, **arguments(0))
                    kwargs = arguments(1)
                    kwargs.update(change)
                    cache.call(model, **kwargs)
                    self.assertEqual(cache.stats["skippedComputes"], 0)
                    self.assertEqual(cache.stats["resets"], 1)
            new_model = Model()
            cache.call(new_model, **arguments(1))
            self.assertEqual(new_model.transformer_blocks[0].calls, 1)
            for key in ("encoder_hidden_states", "padding_mask"):
                with self.subTest(mutated_in_place=key):
                    model, cache = Model(), tea.TeaCacheController(profile(), 0.15)
                    initial = arguments(0)
                    cache.call(model, **initial)
                    initial[key].flat[0] += 1
                    cache.call(model, **arguments(1, **{key: initial[key]}))
                    self.assertEqual(cache.stats["resets"], 1)
                    self.assertEqual(cache.stats["skippedComputes"], 0)

    def test_nonfinite_and_out_of_calibration_domain_force_full_and_failure_restores(self):
        model, cache = Model(), tea.TeaCacheController(profile(), 0.15)
        with patch.dict("sys.modules", modules()):
            cache.call(model, **arguments(0))
            cache.call(model, **arguments(1, hidden_states=Tensor(np.full((1, 2, 1, 2, 2), np.nan))))
            cache.call(model, **arguments(2))
            cache.profile["proxyRange"] = [0, 0]
            cache.call(model, **arguments(3))
            self.assertEqual(cache.stats["skippedComputes"], 0)
            self.assertGreater(cache.stats["nonfinite"], 0)
            def fail(*args):
                raise RuntimeError("block failed")
            model.transformer_blocks[1].forward = fail
            with self.assertRaisesRegex(RuntimeError, "block failed"):
                cache.call(model, **arguments(4))
            self.assertIs(model.transformer_blocks[1].forward, fail)
            self.assertNotIn("forward", model.transformer_blocks[0].__dict__)
            self.assertFalse(cache.lanes)

    def test_collection_is_full_compute_and_produces_finite_paired_samples(self):
        model, cache = Model(), tea.TeaCacheController(collect=True)
        with patch.dict("sys.modules", modules()), patch.object(tea, "relative_l1", wraps=tea.relative_l1) as metric:
            for step in range(4):
                cache.call(model, **arguments(step, total=4))
        self.assertEqual(metric.call_count, 6)
        self.assertEqual(cache.stats["fullComputes"], 4)
        self.assertEqual(cache.stats["skippedComputes"], 0)
        self.assertEqual(len(cache.samples), 4)
        self.assertIsNone(cache.samples[0]["proxyRelativeL1"])
        self.assertIsNone(cache.samples[0]["residualRelativeL1"])
        self.assertGreater(cache.samples[1]["proxyRelativeL1"], 0)
        self.assertGreaterEqual(cache.samples[1]["residualRelativeL1"], 0)

    def test_nonfinite_residual_is_not_retained_with_or_without_collection(self):
        with patch.dict("sys.modules", modules()):
            for collect in (False, True):
                with self.subTest(collect=collect):
                    model, cache = Model(), tea.TeaCacheController(profile(), 0.01, collect=collect)
                    cache.call(model, **arguments(0, total=3))
                    last = model.transformer_blocks[-1]
                    with patch.object(last, "forward", return_value=Tensor([np.inf])):
                        cache.call(model, **arguments(1, total=3))
                    self.assertIsNone(cache.lanes["cond"]["residual"])
                    self.assertEqual(cache.stats["nonfinite"], 1)
                    cache.call(model, **arguments(2, total=3))
                    self.assertEqual(cache.stats["fullComputes"], 3)
                    self.assertEqual(cache.stats["skippedComputes"], 0)
                    self.assertTrue(np.isfinite(cache.lanes["cond"]["residual"]).all())
                    if collect:
                        self.assertIsNone(cache.samples[1]["residualRelativeL1"])
                        self.assertIsNone(cache.samples[2]["residualRelativeL1"])

    def test_both_modular_modes_preserve_after_and_use_actual_sliced_final_step(self):
        cache, blocks = tea.TeaCacheController(profile(), 0.15), AutoBlocks()
        after = blocks.sub_blocks["denoise"].sub_blocks["img2img"].sub_blocks["denoise"].sub_blocks["after_denoiser"]
        with patch.dict("sys.modules", modules()):
            tea.apply_blocks(blocks, cache)
            for mode in ("text2image", "img2img"):
                cache.clear()
                model = Model()
                components = types.SimpleNamespace(transformer=model, guider=Guider())
                denoiser = blocks.sub_blocks["denoise"].sub_blocks[mode].sub_blocks["denoise"].sub_blocks["denoiser"]
                state = types.SimpleNamespace(num_inference_steps=28, timesteps=Tensor([0.5, 0.1]),
                    latent_model_input=arguments(0)["hidden_states"], timestep=Tensor(0.5), dtype=np.float32,
                    padding_mask=arguments(0)["padding_mask"], prompt_embeds=Tensor([1]), negative_prompt_embeds=Tensor([4]))
                for step, t in enumerate(state.timesteps):
                    t = types.SimpleNamespace(item=Mock(return_value=float(t)))
                    denoiser(components, state, step, t)
                    t.item.assert_called_once_with()
                self.assertEqual(model.transformer_blocks[0].calls, 4)
                self.assertEqual(components.guider.cleanups, 4)
        self.assertEqual(cache.stats["skippedComputes"], 0)
        self.assertIs(blocks.sub_blocks["denoise"].sub_blocks["img2img"].sub_blocks["denoise"].sub_blocks["after_denoiser"], after)

    def test_profile_scope_hashes_exact_bytes_and_requires_local_acceptance(self):
        with tempfile.TemporaryDirectory() as directory:
            root = model_fixture(Path(directory))
            request = job_fixture(root)
            data = worker.validate_job(request)
            scope = profiles.compatibility(root, [], data, "txt2img", "torch.bfloat16", "fake CUDA")
            value = profile(scope)
            self.assertEqual(profiles.validate_profile(value, scope), 0.15)
            candidate = copy.deepcopy(value)
            candidate.pop("acceptance")
            with self.assertRaisesRegex(profiles.TeaCacheError, "acceptance"):
                profiles.validate_profile(candidate, scope)
            self.assertEqual(profiles.validate_profile(candidate, scope, require_accepted=False), 0.15)
            with self.assertRaises(profiles.TeaCacheError):
                profiles.validate_profile(value, scope, 0.21)
            (root / "transformer" / "model.safetensors").write_bytes(b"CHANGED WEIGHTS")
            changed = profiles.compatibility(root, [], data, "txt2img", "torch.bfloat16", "fake CUDA")
            with self.assertRaisesRegex(profiles.TeaCacheError, "does not match"):
                profiles.validate_profile(value, changed)
            lora = root / "style.safetensors"
            lora.write_bytes(b"LORA")
            with_lora = profiles.compatibility(root, [{"path": str(lora), "strength": 0.5}], data, "txt2img", "torch.bfloat16", "fake CUDA")
            self.assertNotEqual(changed, with_lora)

    def test_worker_measure_only_is_uninstrumented_and_enabled_reuses_actual_blocks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = model_fixture(Path(directory))
            request = job_fixture(root)
            request["input"]["steps"] = 3
            loaded = []
            class Pipeline:
                def __init__(self, blocks):
                    self.blocks = blocks
                    self.scheduler = types.SimpleNamespace(step=lambda: None)
                    self.transformer, self.guider = Model(), Guider()
                    self.original_step = self.scheduler.step
                def __call__(self, **kwargs):
                    for step in range(3):
                        args = arguments(step, total=3)
                        if self.blocks is not None:
                            denoiser = self.blocks.sub_blocks["denoise"].sub_blocks["text2image"].sub_blocks["denoise"].sub_blocks["denoiser"]
                            state = types.SimpleNamespace(num_inference_steps=3, timesteps=Tensor([1, .9, .8]),
                                latent_model_input=args["hidden_states"], timestep=args["timestep"], dtype=np.float32,
                                padding_mask=args["padding_mask"], prompt_embeds=Tensor([1]), negative_prompt_embeds=Tensor([4]))
                            denoiser(self, state, step, Tensor(args["timestep_value"]))
                        else:
                            self.transformer(**args)
                        self.scheduler.step()
                    return [types.SimpleNamespace(save=lambda path, format, compress_level: Path(path).write_bytes(b"FAKE PNG"))]
            def load(root, cfg, blocks=None):
                loaded.append(Pipeline(blocks))
                return loaded[-1]
            with patch.dict("sys.modules", modules()), patch.object(worker, "dependencies"), patch.object(worker, "load_pipeline", side_effect=load):
                baseline = worker.generate(request, io.StringIO(), measure_teacache=True)
                self.assertIsNone(loaded[-1].blocks)
                self.assertIsNone(baseline["compatibility"])
                self.assertEqual(baseline["fingerprintSeconds"], 0)
                self.assertIsNone(baseline["stats"])
                self.assertEqual(baseline["schedule"]["status"], "unverified")
                self.assertEqual(baseline["schedule"]["source"], "scheduler-post-run")
                data = worker.validate_job(request)
                scope = profiles.compatibility(root, [], data, "txt2img", "torch.bfloat16", "fake CUDA")
                value = profile(scope)
                target = root / "teacache-profile.json"
                target.write_text(json.dumps(value))
                request["teaCacheProfilePath"] = str(target)
                request["input"]["teaCache"] = True
                stream = io.StringIO()
                report = worker.generate(request, stream)
                self.assertEqual(report["stats"]["skippedComputes"], 2)
                self.assertEqual(loaded[-1].transformer.transformer_blocks[0].calls, 4)
                self.assertIs(loaded[-1].scheduler.step, loaded[-1].original_step)
                self.assertEqual(report["peakAllocatedBytes"], 1234)
                self.assertEqual(report["pipelineSeconds"], report["generationSeconds"])
                self.assertNotIn("schedule", report, "product generation must not read back benchmark schedule tensors")
                events = [json.loads(line) for line in stream.getvalue().splitlines()]
                self.assertEqual([event["step"] for event in events if event["event"] == "progress"], [1, 2, 3])
                self.assertEqual(events[-1]["event"], "result")
                self.assertTrue(Path(request["outputPath"]).is_file())

    def test_enabled_worker_validates_profile_before_loading_and_default_stays_off(self):
        with tempfile.TemporaryDirectory() as directory:
            root = model_fixture(Path(directory))
            request = job_fixture(root)
            self.assertFalse(worker.validate_job(request)["teaCache"])
            request["input"]["teaCache"] = True
            with patch.dict("sys.modules", modules()), patch.object(worker, "dependencies"), patch.object(worker, "load_pipeline") as load:
                with self.assertRaisesRegex(worker.WorkerError, "no locally calibrated profile"):
                    worker.generate(request, io.StringIO())
                load.assert_not_called()
            for key, val in (("teaCache", 1), ("teaCacheThresh", float("nan")), ("teaCacheThresh", 0)):
                bad = copy.deepcopy(request)
                bad["input"][key] = val
                with self.subTest(key=key, value=val), self.assertRaises(worker.WorkerError):
                    worker.validate_job(bad)
            request["input"] = {"prompt": "test", "teaCache": False, "teaCacheThresh": 0.1}
            with self.assertRaisesRegex(worker.WorkerError, "requires teaCache"):
                worker.validate_job(request)


if __name__ == "__main__":
    unittest.main()
