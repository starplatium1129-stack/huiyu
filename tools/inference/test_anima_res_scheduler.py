"""Small CPU numerical contracts; no checkpoints, GPU or Comfy dependency."""
import math
from pathlib import Path
import subprocess
import sys
import unittest

import torch
from diffusers import FlowMatchEulerDiscreteScheduler

from anima_res_scheduler import AnimaRESMultistepScheduler
from anima_sampling import new_scheduler, res_call_options


# Installed Comfy b0b743566f65daafc423b4fea8a2fbda94b3384a observations.
# Velocity: .17*x + [.2, -.3, .5, -.7] + .11*sigma. Initial x below.
# Complete per-step oracle traces and comparison live in ignored runtime.
REFERENCE = (
    ("simple", 24, 0, False, [-1.076156735420227, .016127515584230423, -.08613692224025726, 1.8603127002716064]),
    ("normal", 24, 0, False, [-1.0678836107254028, .020485127344727516, -.07203046977519989, 1.8635927438735962]),
    ("sgm_uniform", 30, 0, False, [-1.0763416290283203, .016030261293053627, -.08645206689834595, 1.8602397441864014]),
    ("sgm_uniform", 30, 7, False, [-1.0658191442489624, -.0025151483714580536, -.03262101858854294, 1.8336961269378662]),
    ("simple", 30, 29, False, [-1.0038684606552124, -.21829266846179962, .4431258738040924, 1.5414966344833374]),
    ("normal", 24, 0, True, [-1.0678765773773193, .020324628800153732, -.07318525016307831, 1.8641133308410645]),
)


def initial_state():
    return torch.tensor([[-1., -.25, .5, 1.5]], dtype=torch.float32)


def velocity(state, sigma, low_precision=False):
    result = .17 * state + torch.tensor([[.2, -.3, .5, -.7]]) + .11 * sigma
    return result.to(torch.bfloat16) if low_precision else result


def run(scheduler, begin=0, low_precision=False):
    state = initial_state()
    for index in range(begin, len(scheduler.timesteps)):
        state = scheduler.step(velocity(state, scheduler.sigmas[index], low_precision),
                               scheduler.timesteps[index], state, return_dict=False)[0]
    return state


class AnimaRESTests(unittest.TestCase):
    def test_captured_standard_res_outputs_and_img2img_begin_index(self):
        for name, steps, begin, low_precision, expected in REFERENCE:
            with self.subTest(name=name, begin=begin, low_precision=low_precision):
                base = FlowMatchEulerDiscreteScheduler(shift=3.)
                scheduler = new_scheduler("res_multistep", base.config)
                scheduler.set_timesteps(steps, device="cpu", **res_call_options(name, steps, scheduler))
                scheduler.set_begin_index(begin)
                result = run(scheduler, begin, low_precision)
                torch.testing.assert_close(result, torch.tensor([expected]), atol=1.5e-6, rtol=0)
                self.assertEqual(result.dtype, torch.float32)
                self.assertEqual(scheduler.step_index, steps)
                self.assertIsNone(scheduler._previous_denoised)
        self.assertFalse(torch.cuda.is_initialized())

    def test_new_schedule_or_begin_discards_interrupted_history(self):
        scheduler = AnimaRESMultistepScheduler(shift=3.)
        options = res_call_options("sgm_uniform", 30, scheduler)
        scheduler.set_timesteps(30, **options)
        sample = initial_state()
        for index in range(2):
            sample = scheduler.step(velocity(sample, scheduler.sigmas[index]),
                                    scheduler.timesteps[index], sample).prev_sample
        self.assertIsNotNone(scheduler._previous_denoised)
        scheduler.set_begin_index(7)
        self.assertIsNone(scheduler._previous_denoised)
        torch.testing.assert_close(run(scheduler, 7), torch.tensor([REFERENCE[3][-1]]), atol=1.5e-6, rtol=0)
        scheduler.set_timesteps(30, **options)
        self.assertIsNone(scheduler._previous_denoised)
        self.assertIsNone(scheduler.step_index)
        self.assertIsNone(scheduler.begin_index)
        torch.testing.assert_close(run(scheduler), torch.tensor([REFERENCE[2][-1]]), atol=1.5e-6, rtol=0)

    def test_linear_ode_accuracy_is_distinct_from_euler(self):
        # dx/dsigma=.5*x has the closed-form solution x(0)=exp(-.5)*x(1).
        errors = []
        for cls in (AnimaRESMultistepScheduler, FlowMatchEulerDiscreteScheduler):
            scheduler = cls(shift=3.)
            scheduler.set_timesteps(24, **res_call_options("simple", 24, scheduler))
            scheduler.set_begin_index(0)
            sample = torch.tensor([[1., 2.]])
            for timestep in scheduler.timesteps:
                sample = scheduler.step(.5 * sample, timestep, sample, return_dict=False)[0]
            errors.append((sample - torch.tensor([[1., 2.]]) * math.exp(-.5)).abs().max().item())
        self.assertLess(errors[0], .002)
        self.assertLess(errors[0], errors[1] / 4)

    def test_nonstandard_variants_and_failed_setup_cannot_sample(self):
        scheduler = AnimaRESMultistepScheduler(shift=3.)
        scheduler.set_timesteps(24, **res_call_options("simple", 24, scheduler))
        for kwargs in ({"eta": 1.}, {"cfg_pp": True}):
            with self.assertRaisesRegex(ValueError, "eta=0 and cfg_pp=False"):
                scheduler.step(initial_state(), scheduler.timesteps[0], initial_state(), **kwargs)
        scheduler.register_to_config(stochastic_sampling=True)
        with self.assertRaisesRegex(ValueError, "stochastic_sampling"):
            scheduler.set_timesteps(24)
        with self.assertRaisesRegex(ValueError, "set_timesteps"):
            scheduler.step(initial_state(), torch.tensor(1000.), initial_state())
        self.assertIsNone(scheduler._previous_denoised)

    def test_factory_keeps_base_config_and_separates_job_state(self):
        base = FlowMatchEulerDiscreteScheduler(shift=3.)
        config = dict(base.config)
        euler = new_scheduler("euler", base.config)
        first = new_scheduler("res_multistep", base.config)
        second = new_scheduler("res_multistep", base.config)
        self.assertIs(type(euler), FlowMatchEulerDiscreteScheduler)
        self.assertIs(type(first), type(second))
        self.assertIsNot(first, second)
        first.set_timesteps(24, **res_call_options("normal", 24, first))
        first.step(initial_state(), first.timesteps[0], initial_state())
        self.assertIsNone(second.step_index)
        self.assertEqual(dict(base.config), config)
        with self.assertRaisesRegex(ValueError, "Unsupported Anima sampler"):
            new_scheduler("res_multistep_cfg_pp", base.config)

    def test_worker_style_file_loading_in_isolated_python(self):
        source = """
import importlib.util
import os
import sys
os.environ['CUDA_VISIBLE_DEVICES'] = '-1'
import torch
from diffusers import FlowMatchEulerDiscreteScheduler

def forbid_cuda(*args, **kwargs):
    raise RuntimeError('CUDA initialization forbidden in CPU contract')

torch.cuda._lazy_init = forbid_cuda
original_path = list(sys.path)
spec = importlib.util.spec_from_file_location('isolated_anima_sampling', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
config = FlowMatchEulerDiscreteScheduler(shift=3.).config
scheduler = module.new_scheduler('res_multistep', config)
second = module.new_scheduler('res_multistep', config)
assert scheduler is not second and type(scheduler) is type(second)
scheduler.set_timesteps(24, device='cpu', **module.sampling_options('res_multistep', 'simple', 24, scheduler))
scheduler.set_begin_index(0)
sample = torch.ones((1, 4), dtype=torch.float32)
result = scheduler.step(sample, scheduler.timesteps[0], sample).prev_sample
assert result.device.type == 'cpu' and scheduler.step_index == 1
assert len(scheduler.sigmas) == 25 and scheduler.sigmas[-1] == 0
assert sys.path == original_path
assert 'anima_sampling' not in sys.modules and 'anima_res_scheduler' not in sys.modules
assert not torch.cuda.is_initialized()
print('isolated RES: 24 steps initialized, CPU first step passed, path unchanged')
"""
        result = subprocess.run([sys.executable, "-I", "-c", source,
                                 str(Path(__file__).with_name("anima_sampling.py"))],
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
