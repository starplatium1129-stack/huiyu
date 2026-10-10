"""Calibrated TeaCache for pinned Anima/Cosmos, using per-call instance wrappers.

TeaCache algorithm: https://github.com/ali-vilab/TeaCache (Apache-2.0).
No upstream model-specific polynomial or ComfyUI implementation is copied.
Modular denoiser integration adapted from Diffusers 0.41.0 (Apache-2.0):
Copyright 2026 The HuggingFace Team. All rights reserved.
https://github.com/huggingface/diffusers/blob/v0.41.0/src/diffusers/modular_pipelines/anima/denoise.py
Licensed under Apache License 2.0, https://www.apache.org/licenses/LICENSE-2.0
Distributed AS IS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.
"""
from __future__ import annotations

import math
from bisect import bisect_left


def snapshot(tensor):
    return tensor.detach().clone()


def finite_tensor(tensor):
    import torch
    return bool(torch.isfinite(tensor).all().item())


def relative_l1(current, previous):
    # Accumulation in float32 avoids low-precision overflow in calibration/statistics.
    import torch
    current, previous = current.float(), previous.float()
    numerator = (current - previous).abs().mean()
    denominator = torch.clamp(previous.abs().mean(), min=1e-8)
    value = (numerator / denominator).item()
    return value if math.isfinite(value) else None


def phase_index(step, total):
    return min(2, 3 * step // max(1, total - 1))


def estimate_change(profile, change, step, total):
    if profile["schemaVersion"] == 2:
        points = profile["phaseEnvelopes"][phase_index(step, total)]
        if not points[0][0] <= change <= points[-1][0]:
            return None
        right = bisect_left([point[0] for point in points], change)
        # Use the larger adjoining observed error, rather than an average fit.
        return max(points[max(0, right - 1)][1], points[right][1])
    low, high = profile["proxyRange"]
    if not low <= change <= high:
        return None
    estimate = 0.0
    for coefficient in reversed(profile["coefficients"]):
        estimate = estimate * change + coefficient
    return max(0.0, estimate) if math.isfinite(estimate) else None


def same_inputs(conditioning, padding, lane):
    import torch
    pairs = ((conditioning, lane["conditioning"]), (padding, lane["padding"]))
    if any(current.shape != previous.shape or current.dtype != previous.dtype
           or current.device != previous.device for current, previous in pairs):
        return False
    if conditioning.device != padding.device or any(tensor.has_names() for pair in pairs for tensor in pair):
        return all(bool(torch.equal(current, previous)) for current, previous in pairs)
    # Pinned CUDA equal uses eq(...).all().item(); keep both exact comparisons but
    # combine their device scalars before synchronizing with the host once.
    # https://github.com/pytorch/pytorch/blob/v2.8.0/aten/src/ATen/native/cuda/Equal.cpp
    equal = (conditioning == lane["conditioning"]).all() & (padding == lane["padding"]).all()
    return bool(equal.item())


class TeaCacheController:
    """One job only; distinct CFG lanes and no class/global model patching."""
    def __init__(self, profile=None, threshold=None, collect=False):
        if not collect and (profile is None or threshold is None):
            raise ValueError("TeaCache needs a validated local profile and threshold")
        self.profile, self.threshold, self.collect = profile, threshold, collect
        self.lanes, self.samples, self.model = {}, [], None
        self.stats = dict(fullComputes=0, skippedComputes=0, skippedBlocks=0, resets=0, nonfinite=0)

    def clear(self):
        self.lanes.clear()
        self.model = None

    def _lane(self, model, branch, step, total, timestep, hidden, conditioning, padding):
        if self.model is not model:
            self.clear()
            self.model = model
        lane = self.lanes.get(branch)
        shape = (tuple(hidden.shape), str(hidden.dtype), str(hidden.device), total)
        valid = (lane is not None and lane["shape"] == shape and step == lane["step"] + 1
                 and math.isfinite(timestep) and timestep < lane["timestep"]
                 and same_inputs(conditioning, padding, lane))
        if not valid:
            if lane is not None:
                self.stats["resets"] += 1
            lane = dict(shape=shape, conditioning=snapshot(conditioning), padding=snapshot(padding),
                        proxy=None, residual=None, accumulated=0.0, skips=0)
            self.lanes[branch] = lane
        lane.update(step=step, timestep=timestep)
        return lane

    def call(self, model, *, branch, step, total, timestep_value, **kwargs):
        """Run stock model prep/head; skip the real attention/MLP stack when safe."""
        import torch
        if torch.is_grad_enabled() or getattr(model, "gradient_checkpointing", False):
            raise ValueError("TeaCache requires inference/no-grad with gradient checkpointing disabled")
        blocks = list(model.transformer_blocks)
        if not blocks or any(getattr(block, name, None) is not None for block in blocks for name in ("before_proj", "after_proj")):
            raise ValueError("TeaCache requires the pinned ordinary Cosmos transformer block stack")
        if kwargs.get("block_controlnet_hidden_states") is not None or kwargs.get("condition_mask") is not None:
            raise ValueError("TeaCache calibration does not support ControlNet/condition-mask transformer inputs")
        lane = self._lane(model, branch, step, total, float(timestep_value), kwargs["hidden_states"],
                          kwargs["encoder_hidden_states"], kwargs["padding_mask"])
        originals = [(block, block.forward, "forward" in block.__dict__) for block in blocks]
        execution = dict(skip=False, input=None, proxy=None, change=None, visited=0)

        def wrap(index, original):
            def forward(hidden, encoder, embedded, temb, rotary, extra, mask, control):
                execution["visited"] += 1
                if index == 0:
                    norm_input = hidden + extra if extra is not None else hidden
                    proxy = blocks[0].norm1(norm_input, embedded, temb)[0]
                    safe = bool((torch.isfinite(proxy).all() & torch.isfinite(hidden).all()).item()) and math.isfinite(float(timestep_value))
                    change = relative_l1(proxy, lane["proxy"]) if safe and lane["proxy"] is not None else None
                    execution.update(proxy=snapshot(proxy) if safe else None, change=change)
                    if not safe or (lane["proxy"] is not None and change is None):
                        self.stats["nonfinite"] += 1
                        lane.update(proxy=None, residual=None, accumulated=0.0, skips=0)
                    estimate = None
                    if change is not None and not self.collect:
                        estimate = estimate_change(self.profile, change, step, total)
                    phase = phase_index(step, total)
                    phase_changed = self.profile is not None and self.profile["schemaVersion"] == 2 and lane.get("phase") != phase
                    lane["phase"] = phase
                    accumulated = lane["accumulated"] + estimate if estimate is not None else math.inf
                    execution["skip"] = (not self.collect and 0 < step < total - 1
                        and not phase_changed and lane["residual"] is not None and estimate is not None
                        and accumulated < self.threshold and lane["skips"] < self.profile["maxConsecutiveSkips"])
                    if execution["skip"]:
                        lane.update(accumulated=accumulated, skips=lane["skips"] + 1)
                        self.stats["skippedComputes"] += 1
                        self.stats["skippedBlocks"] += len(blocks)
                    else:
                        execution["input"] = snapshot(hidden)
                        lane.update(accumulated=0.0, skips=0)
                        self.stats["fullComputes"] += 1
                if execution["skip"]:
                    result = hidden + lane["residual"] if index == 0 else hidden
                else:
                    result = original(hidden, encoder, embedded, temb, rotary, extra, mask, control)
                if index == len(blocks) - 1:
                    residual_change = None
                    if not execution["skip"]:
                        residual = result - execution["input"]
                        if finite_tensor(residual) and execution["proxy"] is not None:
                            # Residual change is calibration-only; avoid its reduction/sync in generation.
                            if self.collect and lane["residual"] is not None:
                                residual_change = relative_l1(residual, lane["residual"])
                                if residual_change is None:
                                    self.stats["nonfinite"] += 1
                            lane["residual"] = snapshot(residual)
                        else:
                            self.stats["nonfinite"] += 1
                            lane["residual"] = None
                    lane["proxy"] = execution["proxy"]
                    if self.collect:
                        self.samples.append(dict(branch=branch, step=step, total=total, timestep=float(timestep_value),
                            proxyRelativeL1=execution["change"], residualRelativeL1=residual_change))
                return result
            return forward

        try:
            for index, (block, original, _) in enumerate(originals):
                block.forward = wrap(index, original)
            result = model(**kwargs)
            if execution["visited"] != len(blocks):
                raise ValueError("Pinned Cosmos transformer block traversal changed")
            return result
        except BaseException:
            self.clear()
            raise
        finally:
            for block, original, owned in originals:
                if owned:
                    block.forward = original
                else:
                    del block.forward


def apply_blocks(blocks, controller):
    """Install one denoiser on both stock branches, retaining masked after-step logic."""
    import torch
    from diffusers.modular_pipelines.anima.denoise import AnimaLoopDenoiser
    from diffusers.modular_pipelines.modular_pipeline_utils import InputParam

    class CachedDenoiser(AnimaLoopDenoiser):
        @property
        def inputs(self):
            return super().inputs + [InputParam("timesteps", required=True)]

        @torch.no_grad()
        def __call__(self, components, block, i, t):
            components.guider.set_state(step=i, num_inference_steps=block.num_inference_steps, timestep=t)
            batches = components.guider.prepare_inputs_from_block_state(block, self._guider_input_fields)
            if i == 0:
                # The pinned loop enumerates this fixed, already strength-sliced
                # schedule. Copy once per run instead of synchronizing every step.
                self._timestep_values = block.timesteps.detach().cpu().tolist()
            timestep_value = self._timestep_values[i]
            # The fixed ClassifierFreeGuidance returns stable separate lanes. Include
            # batch count so a changed guidance layout cannot reuse another branch.
            for lane, batch in enumerate(batches):
                components.guider.prepare_models(components.transformer)
                try:
                    condition = {key: getattr(batch, key).to(block.dtype) for key in self._guider_input_fields}
                    batch.noise_pred = controller.call(components.transformer,
                        branch=f"cfg:{len(batches)}:{lane}", step=i, total=len(block.timesteps), timestep_value=timestep_value,
                        hidden_states=block.latent_model_input, timestep=block.timestep,
                        padding_mask=block.padding_mask, return_dict=False, **condition)[0]
                finally:
                    components.guider.cleanup_models(components.transformer)
            block.noise_pred = components.guider(batches)[0]
            return components, block

    for name in ("text2image", "img2img"):
        blocks.sub_blocks["denoise"].sub_blocks[name].sub_blocks["denoise"].sub_blocks["denoiser"] = CachedDenoiser()
    return blocks
