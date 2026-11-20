"""Task-local ER-SDE sampler for the MOSS flow-matching preview.

The third-order VP update and noise function are from Cui et al.,
https://arxiv.org/abs/2309.06169 and the authors' MIT-licensed reference
https://github.com/QinpengCui/ER-SDE-Solver (VP solver, noise function SDE-5).
The MOSS scheduling and velocity conversion below use rectified-flow time.
"""

# ER-SDE-Solver reference license
# Copyright (c) 2023 Qinpeng Cui
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in all
# copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
# SOFTWARE.

import math

import torch
from diffusers import FlowMatchEulerDiscreteScheduler
from diffusers.schedulers.scheduling_utils import SchedulerOutput


def _noise_function(noise_ratio):
    return noise_ratio * (math.exp(noise_ratio ** 0.3) + 10.0)


def _taylor_weights(current, following, following_noise):
    # Zeroth and first moments of phi(following) / phi(u) in the VP update.
    # Evaluate scalar quadrature on the CPU without reading device tensors.
    subdivisions = 200
    spacing = (current - following) / subdivisions
    mass = moment = 0.0
    for index in range(subdivisions):
        position = following + index * spacing
        relative_noise = following_noise / _noise_function(position)
        mass += relative_noise
        moment += (position - current) * relative_noise
    delta = following - current
    return delta + spacing * mass, 0.5 * delta * delta + spacing * moment


class MossPreviewScheduler(FlowMatchEulerDiscreteScheduler):
    """One model prediction per step. Create from the task scheduler and seed."""

    def __init__(self, scheduler, seed):
        super().__init__(num_train_timesteps=scheduler.config.num_train_timesteps,
                         shift=scheduler.config.shift)
        self._seed = seed
        self._noise_ratios = ()
        self._flow_sigmas = ()
        self.clear()

    def clear(self):
        self._generator = None
        self._previous_clean = None
        self._previous_slope = None

    def set_timesteps(self, num_inference_steps=25, device=None):
        self.clear()
        count = num_inference_steps
        total = self.config.num_train_timesteps
        shift = self.config.shift
        if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= total:
            raise ValueError(f"MOSS ER-SDE requires between 1 and {total} steps.")
        if not math.isfinite(shift) or shift <= 0:
            raise ValueError("MOSS ER-SDE requires a positive finite flow shift.")

        # Simple selects evenly spaced indices in the shifted training grid.
        # Offset the pure-noise endpoint before the shift to keep sigma/alpha finite.
        indices = total - torch.arange(count, device="cpu", dtype=torch.int64) * total // count
        fractions = indices.to(torch.float32) / total
        sigmas = shift * fractions / (1.0 + (shift - 1.0) * fractions)
        start = 1.0 - 1e-4
        sigmas[0] = shift * start / (1.0 + (shift - 1.0) * start)
        self.sigmas = torch.cat((sigmas, sigmas.new_zeros(1)))
        self._flow_sigmas = self.sigmas.tolist()
        if self._flow_sigmas[0] >= 1 or any(
            left <= right for left, right in zip(self._flow_sigmas, self._flow_sigmas[1:])
        ):
            raise ValueError("MOSS ER-SDE needs strictly decreasing sigmas below one.")
        self._noise_ratios = [sigma / (1.0 - sigma) for sigma in self._flow_sigmas]
        self.num_inference_steps = count
        # The vendored MOSS DiT expects time on its 0..1000 training scale.
        self.timesteps = (sigmas * total).to(device=device)
        self._step_index = 0
        self._begin_index = None

        # The pipeline draws its initial latents on CPU from the task seed.
        # Use a separate device stream for ER noise, including a distinct CPU seed.
        generator_device = self.timesteps.device
        noise_seed = (self._seed + int(generator_device.type == "cpu")) % (1 << 64)
        self._generator = torch.Generator(device=generator_device).manual_seed(noise_seed)

    def step(self, model_output, timestep, sample, return_dict=True):
        index = self._step_index
        if self._generator is None or index is None or index >= self.num_inference_steps:
            raise ValueError("MOSS ER-SDE requires a prepared, unfinished schedule.")
        if isinstance(timestep, int) or (torch.is_tensor(timestep) and not timestep.is_floating_point()):
            raise ValueError("MOSS ER-SDE expects a model timestep, not a step index.")

        sigma, next_sigma = self._flow_sigmas[index:index + 2]
        # x_sigma = (1 - sigma) * x_clean + sigma * noise, v = noise - x_clean.
        latent = sample.float()
        clean = torch.add(latent, model_output.float(), alpha=-sigma)
        if next_sigma == 0.0:
            result = clean
            self.clear()
        else:
            current, following = self._noise_ratios[index:index + 2]
            following_noise = _noise_function(following)
            ratio = following_noise / _noise_function(current)
            next_alpha = 1.0 - next_sigma
            result = latent * (next_alpha * ratio / (1.0 - sigma))
            result.add_(clean, alpha=next_alpha * (1.0 - ratio))

            if self._previous_clean is not None:
                slope = (clean - self._previous_clean) / (current - self._noise_ratios[index - 1])
                first, second = _taylor_weights(current, following, following_noise)
                result.add_(slope, alpha=next_alpha * first)
                if self._previous_slope is not None:
                    scale = 2.0 * next_alpha * second / (current - self._noise_ratios[index - 2])
                    result.add_(slope - self._previous_slope, alpha=scale)
                self._previous_slope = slope.detach()
            self._previous_clean = clean.detach()

            variance = max(0.0, following ** 2 - (current * ratio) ** 2)
            noise = torch.randn(latent.shape, generator=self._generator,
                                device=latent.device, dtype=latent.dtype)
            result.add_(noise, alpha=next_alpha * math.sqrt(variance))

        self._step_index = index + 1
        result = result.to(dtype=sample.dtype)
        return SchedulerOutput(prev_sample=result) if return_dict else (result,)
