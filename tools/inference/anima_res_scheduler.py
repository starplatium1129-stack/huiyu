"""Deterministic two-step RES for Anima flow velocity, independently derived.

Let D=x-sigma*v and lambda=-log(sigma). Then dx/dlambda=-x+D.
Integrating a linear extrapolation D(lambda+u)=D+(u/h_prev)*(D-D_prev)
gives x_next=exp(-h)*x+(1-exp(-h))*D
             +(h-1+exp(-h))/h_prev*(D-D_prev).
This is the second-order exponential multistep method discussed in Zhang,
Song & Chen (2023), sections 3.5/D.1: https://arxiv.org/abs/2308.02157.
Only the mathematical method is used; no author or Comfy source is copied.
The Apache-2.0 Diffusers base supplies configuration, noise scaling and grids.
"""
import math
from functools import lru_cache

import torch
from diffusers import FlowMatchEulerDiscreteScheduler
from diffusers.schedulers.scheduling_utils import SchedulerOutput


@lru_cache(maxsize=1)
def _sampling_tools():
    # The worker loads modules by filename without sys.modules registration.
    import importlib.util
    from pathlib import Path

    spec = importlib.util.spec_from_file_location(
        "huiyu_anima_sampling", Path(__file__).with_name("anima_sampling.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class AnimaRESMultistepScheduler(FlowMatchEulerDiscreteScheduler):
    """Standard res_multistep only: eta=0, no CFG++, one model call per step.

    Use from_config(base.config) for each job. set_timesteps/set_begin_index
    discard history, including after cancellation. State and returned latents
    stay FP32; the Anima denoiser block casts its model input independently.
    The inherited API order=1 denotes one evaluation per step; the numerical
    method is second order. No ancestral, CFG++ or per-token variants exist.
    """

    def set_timesteps(self, num_inference_steps=None, device=None, sigmas=None, mu=None, timesteps=None):
        self._previous_denoised = None
        self._res_ready = False
        _sampling_tools().validate_flow_config(self, "res_multistep")
        if mu is not None or timesteps is not None:
            raise ValueError("Anima RES accepts static sigmas, not mu or custom timesteps")
        super().set_timesteps(num_inference_steps, device=device, sigmas=sigmas)
        # Coefficients depend only on the grid. Build once on CPU, avoiding
        # GPU scalar synchronizations in the denoising loop.
        self.sigmas = self.sigmas.cpu()
        values = self.sigmas.tolist()
        if (len(values) < 2 or values[-1] != 0 or values[0] > 1
                or not all(math.isfinite(s) and s > t >= 0 for s, t in zip(values, values[1:]))):
            raise ValueError("Anima RES requires strictly decreasing positive sigmas followed by zero")
        self._res_coefficients = [None] * (len(values) - 1)
        for index in range(1, len(values) - 2):
            previous, current, following = values[index - 1:index + 2]
            h = math.log(current) - math.log(following)
            h_previous = math.log(previous) - math.log(current)
            mass = -math.expm1(-h)
            self._res_coefficients[index] = (math.exp(-h), mass, (h - mass) / h_previous)
        self._res_ready = True

    def set_begin_index(self, begin_index=0):
        if (not getattr(self, "_res_ready", False) or not isinstance(begin_index, int)
                or isinstance(begin_index, bool) or not 0 <= begin_index < len(self.timesteps)):
            raise ValueError("Anima RES begin_index must select an initialized denoising step")
        super().set_begin_index(begin_index)
        self._step_index = None
        self._previous_denoised = None

    @torch.no_grad()
    def step(self, model_output, timestep, sample, return_dict=True, *, eta=0.0, cfg_pp=False):
        if eta != 0.0 or cfg_pp is not False:
            raise ValueError("Anima RES supports only eta=0 and cfg_pp=False")
        if not getattr(self, "_res_ready", False):
            raise ValueError("Call Anima RES set_timesteps before step")
        if isinstance(timestep, int) or (isinstance(timestep, torch.Tensor) and not timestep.is_floating_point()):
            raise ValueError("Pass a scheduler timestep, not an integer step index")
        if self.step_index is None:
            self._init_step_index(timestep)
        index = self.step_index
        if index >= len(self.timesteps):
            raise ValueError("Anima RES schedule is already complete")
        current, following = self.sigmas[index:index + 2]
        state = sample.float()
        denoised = state - current * model_output.float()
        terminal = index == len(self.timesteps) - 1
        if self._previous_denoised is None or terminal:
            # The first available evaluation cannot use a multistep history;
            # sigma=0 has no finite log-time and uses the final Euler step.
            result = state + ((state - denoised) / current) * (following - current)
        else:
            decay, mass, extrapolation = self._res_coefficients[index]
            result = decay * state + mass * denoised + extrapolation * (denoised - self._previous_denoised)
        self._previous_denoised = None if terminal else denoised
        self._step_index += 1
        return SchedulerOutput(prev_sample=result) if return_dict else (result,)
