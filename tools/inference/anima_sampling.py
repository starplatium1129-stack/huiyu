"""Anima grids for the official FlowMatchEulerDiscreteScheduler.

S(t) = 3t / (1 + 2t), m = S(float32(1/1000)). Normal uses an
FP32 grid from 1 to m. sgm_uniform divides the same interval into N
equal parts and excludes m. Diffusers applies S once and appends zero.
Only mathematical parameters and the Apache-2.0 Diffusers API are used:
https://github.com/huggingface/diffusers/blob/v0.41.0/src/diffusers/schedulers/scheduling_flow_match_euler_discrete.py
No Comfy scheduler implementation is imported or copied into this module.
"""
from functools import lru_cache


@lru_cache(maxsize=1)
def _res_scheduler_class():
    # The worker uses python -I: resolve only our bundled sibling, never sys.path.
    import importlib.util
    from pathlib import Path

    spec = importlib.util.spec_from_file_location(
        "huiyu_anima_res_scheduler", Path(__file__).with_name("anima_res_scheduler.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.AnimaRESMultistepScheduler


def call_options(scheduler_name, steps, scheduler):
    """Return pipeline options for a caller-validated positive step count.

    simple deliberately leaves the existing Anima pipeline defaults unchanged.
    normal supplies N pre-shift values, never the N+1 final sigma sequence.
    """
    if scheduler_name == "simple":
        return {}
    if scheduler_name not in ("normal", "sgm_uniform"):
        raise ValueError(f"Unsupported Anima scheduler: {scheduler_name}")
    validate_flow_config(scheduler, scheduler_name)
    import torch

    minimum = torch.tensor(1 / 1000, dtype=torch.float32, device="cpu")
    minimum = 3 * minimum / (1 + 2 * minimum)
    count = steps + 1 if scheduler_name == "sgm_uniform" else steps
    grid = torch.linspace(1.0, minimum.item(), count, dtype=torch.float32, device="cpu")
    return {"sigmas": grid[:steps].tolist()}


def validate_flow_config(scheduler, name):
    """These schedules and the RES adapter share the static Anima flow contract."""
    required = {"num_train_timesteps": 1000, "shift": 3.0,
                "use_dynamic_shifting": False, "invert_sigmas": False, "shift_terminal": None,
                "use_karras_sigmas": False, "use_exponential_sigmas": False,
                "use_beta_sigmas": False, "stochastic_sampling": False}
    for key, expected in required.items():
        if scheduler.config.get(key) != expected:
            raise ValueError(f"Anima {name} requires scheduler {key}={expected!r}")
    # set_shift() changes the effective shift without changing scheduler.config.
    if scheduler.shift != 3.0:
        raise ValueError(f"Anima {name} requires effective scheduler shift=3.0")


def res_call_options(scheduler_name, steps, scheduler):
    """RES simple uses the 1000-entry training grid, preserving Euler simple."""
    if scheduler_name != "simple":
        return call_options(scheduler_name, steps, scheduler)
    validate_flow_config(scheduler, "res_multistep/simple")
    import torch

    # Uniform subsampling of descending training indices, before static shift.
    ticks = [1000 - int(i * (1000 / steps)) for i in range(steps)]
    return {"sigmas": (torch.tensor(ticks, dtype=torch.float32, device="cpu") / 1000).tolist()}


def new_scheduler(sampler_name, scheduler_config):
    """Create per-job state from the base checkpoint's unchanged config."""
    if sampler_name == "euler":
        from diffusers import FlowMatchEulerDiscreteScheduler

        return FlowMatchEulerDiscreteScheduler.from_config(scheduler_config)
    if sampler_name == "res_multistep":
        scheduler = _res_scheduler_class().from_config(scheduler_config)
        validate_flow_config(scheduler, sampler_name)
        return scheduler
    raise ValueError(f"Unsupported Anima sampler: {sampler_name}")


def sampling_options(sampler_name, scheduler_name, steps, scheduler):
    """Shared dispatch for the initial pass and the refinement pass."""
    if sampler_name == "res_multistep":
        return res_call_options(scheduler_name, steps, scheduler)
    if sampler_name == "euler":
        return call_options(scheduler_name, steps, scheduler)
    raise ValueError(f"Unsupported Anima sampler: {sampler_name}")


def refinement_options(name, steps, strength, scheduler, *, sampler="euler"):
    """Take the last requested steps of the complete img2img schedule once."""
    if not isinstance(steps, int) or isinstance(steps, bool) or steps < 1 or not 0 < strength <= 1:
        raise ValueError("Anima refinement needs positive integer steps and 0 < strength <= 1")
    full = max(steps, int(steps / strength))
    options = sampling_options(sampler, name, full, scheduler)
    if not options:
        # Preserve the official Anima pipeline's Euler/simple default exactly.
        import numpy as np

        options = {"sigmas": np.linspace(1.0, 1 / full, full).tolist()}
    return {"sigmas": options["sigmas"][-steps:], "num_inference_steps": steps, "strength": 1.0}
