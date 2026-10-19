"""Calibrated TeaCache for pinned Anima/Cosmos, using per-call instance wrappers.

TeaCache algorithm: https://github.com/ali-vilab/TeaCache (Apache-2.0).
The built-in polynomial and accumulation policy are adapted from CocyNoric's
ComfyUI-Anima-TeaCache, Apache-2.0, revision e7a73823c057b4884ca6b70778da803c1f60d557.
https://github.com/CocyNoric/ComfyUI-Anima-TeaCache/blob/e7a73823c057b4884ca6b70778da803c1f60d557/nodes.py
Modifications: Diffusers instance wrappers, separate CFG residuals and finite guards.
See TEACACHE_LICENSE.txt. No ComfyUI runtime is imported.
Modular denoiser integration adapted from Diffusers 0.41.0 (Apache-2.0):
Copyright 2026 The HuggingFace Team. All rights reserved.
https://github.com/huggingface/diffusers/blob/v0.41.0/src/diffusers/modular_pipelines/anima/denoise.py
Licensed under Apache License 2.0, https://www.apache.org/licenses/LICENSE-2.0
Distributed AS IS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.
"""
from __future__ import annotations

import math
from bisect import bisect_left

BUILTIN_ALGORITHM = "anima-teacache-e7a7382-v1"
ANIMA_COEFFICIENTS = (16.440769544691957, -21.14123745515793,
                     13.006701290921894, -1.6731977662609427, 0.08632681059623949)


def builtin_change(current, previous):
    import torch
    # Match the node's original-dtype reduction, then transfer one scalar.
    denominator = previous.abs().mean()
    ratio = (current - previous).abs().mean() / denominator
    return torch.where(denominator > 0, ratio, float("inf")).float()


def builtin_estimate(change):
    estimate = 0.0
    for coefficient in ANIMA_COEFFICIENTS:
        estimate = estimate * change + coefficient
    return estimate if math.isfinite(estimate) else None


def snapshot(tensor):
    return tensor.detach().clone()


def finite_tensor(tensor):
    import torch
    return bool(torch.isfinite(tensor).all().item())


def _relative_l1_tensor(current, previous):
    # Accumulation in float32 avoids low-precision overflow in calibration/statistics.
    import torch
    current, previous = current.float(), previous.float()
    numerator = (current - previous).abs().mean()
    denominator = torch.clamp(previous.abs().mean(), min=1e-8)
    return numerator / denominator


def relative_l1(current, previous):
    value = _relative_l1_tensor(current, previous).item()
    return value if math.isfinite(value) else None


def phase_index(step, total):
    return min(2, 3 * step // max(1, total - 1))


def estimate_change(profile, change, step, total, field="phaseEnvelopes"):
    if profile["schemaVersion"] in (2, 3):
        points = profile[field][phase_index(step, total)]
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
    def __init__(self, profile=None, threshold=None, collect=False, *, collect_local=False, local_tools=None, builtin=False):
        if not collect and (threshold is None or (profile is None and not builtin)):
            raise ValueError("TeaCache needs a validated local profile and threshold")
        self.builtin = builtin
        self.profile, self.threshold, self.collect = profile, threshold, collect
        self.local_guard = (collect and collect_local) or (profile is not None and profile["schemaVersion"] == 3)
        self.local_tools = local_tools
        if self.local_guard and local_tools is None:
            raise ValueError("Local cache requires the bundled local metric")
        self.lanes, self.samples, self.model = {}, [], None
        self.stats = dict(fullComputes=0, skippedComputes=0, skippedBlocks=0, resets=0, nonfinite=0)
        if self.local_guard:
            self.stats.update(localChecks=0, localRiskRejects=0)

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
                        proxy=None, residual=None, accumulated=0.0, local_accumulated=0.0, skips=0)
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
        originals = []
        for block in blocks:
            registry = getattr(block, "_diffusers_hook", None)
            hook = registry.get_hook("group_offloading") if registry is not None else None
            # Pinned Diffusers hook slots keep onload outside our temporary
            # wrapper: Tea's first norm must already have its CUDA weights.
            # No prefetch is used, so skipped blocks cannot strand another group.
            owner = hook.fn_ref if hook is not None else block
            originals.append((owner, owner.forward, "forward" in owner.__dict__))
        execution = dict(skip=False, input=None, proxy=None, change=None, local_change=None, visited=0)

        def wrap(index, original):
            def forward(hidden, encoder, embedded, temb, rotary, extra, mask, control):
                execution["visited"] += 1
                if index == 0:
                    norm_input = hidden + extra if extra is not None else hidden
                    proxy = blocks[0].norm1(norm_input, embedded, temb)[0]
                    safe = torch.isfinite(proxy).all() & torch.isfinite(hidden).all()
                    change, local_change = None, None
                    if lane["proxy"] is None:
                        safe = bool(safe.item())
                    else:
                        # Keep both observations distinct: finite tensors can still
                        # overflow the metric. Transfer their float32 scalars together.
                        if self.local_guard:
                            changes = self.local_tools.relative_changes(proxy, lane["proxy"])
                            safe, change, local_change = torch.cat((safe.float().reshape(1), changes)).cpu().tolist()
                            self.stats["localChecks"] += 1
                        else:
                            metric = builtin_change if self.builtin else _relative_l1_tensor
                            safe, change = torch.stack((safe.float(), metric(proxy, lane["proxy"]))).cpu().tolist()
                    safe = bool(safe) and math.isfinite(float(timestep_value))
                    change = change if safe and change is not None and math.isfinite(change) else None
                    local_change = local_change if safe and local_change is not None and math.isfinite(local_change) else None
                    execution.update(proxy=snapshot(proxy) if safe else None, change=change, local_change=local_change)
                    if not safe or (lane["proxy"] is not None and (change is None or (self.local_guard and local_change is None))):
                        # A zero/overflowed metric forces full computation; only
                        # nonfinite activations invalidate a built-in-cache job.
                        self.stats["nonfinite"] += int(not self.builtin or not safe)
                        lane.update(proxy=None, residual=None, accumulated=0.0, local_accumulated=0.0, skips=0)
                    estimate = None
                    if change is not None and not self.collect:
                        estimate = builtin_estimate(change) if self.builtin else estimate_change(self.profile, change, step, total)
                    phase = phase_index(step, total)
                    phase_changed = self.profile is not None and self.profile["schemaVersion"] in (2, 3) and lane.get("phase") != phase
                    lane["phase"] = phase
                    accumulated = lane["accumulated"] + estimate if estimate is not None else math.inf
                    execution["skip"] = (not self.collect and 0 < step < total - 1
                        and not phase_changed and lane["residual"] is not None and estimate is not None
                        and accumulated < self.threshold
                        and (self.builtin or lane["skips"] < self.profile["maxConsecutiveSkips"]))
                    local_accumulated = math.inf
                    if self.local_guard and not self.collect:
                        local_estimate = (estimate_change(self.profile, local_change, step, total, "localPhaseEnvelopes")
                            if local_change is not None else None)
                        if local_estimate is not None:
                            local_accumulated = lane["local_accumulated"] + local_estimate
                        local_ok = local_accumulated < self.profile["localThreshold"]
                        self.stats["localRiskRejects"] += int(execution["skip"] and not local_ok)
                        execution["skip"] = execution["skip"] and local_ok
                    if execution["skip"]:
                        lane.update(accumulated=accumulated, local_accumulated=local_accumulated, skips=lane["skips"] + 1)
                        self.stats["skippedComputes"] += 1
                        self.stats["skippedBlocks"] += len(blocks)
                    else:
                        execution["input"] = snapshot(hidden)
                        lane.update(accumulated=0.0, local_accumulated=0.0, skips=0)
                        self.stats["fullComputes"] += 1
                if execution["skip"]:
                    result = hidden + lane["residual"] if index == 0 else hidden
                else:
                    result = original(hidden, encoder, embedded, temb, rotary, extra, mask, control)
                if index == len(blocks) - 1:
                    residual_change, local_residual_change = None, None
                    if not execution["skip"]:
                        residual = result - execution["input"]
                        if finite_tensor(residual) and execution["proxy"] is not None:
                            # Residual change is calibration-only; avoid its reduction/sync in generation.
                            if self.collect and lane["residual"] is not None:
                                if self.local_guard:
                                    residual_change, local_residual_change = self.local_tools.relative_changes(residual, lane["residual"]).cpu().tolist()
                                    if not all(math.isfinite(value) for value in (residual_change, local_residual_change)):
                                        residual_change = local_residual_change = None
                                else:
                                    residual_change = relative_l1(residual, lane["residual"])
                                if residual_change is None:
                                    self.stats["nonfinite"] += 1
                            lane["residual"] = snapshot(residual)
                        else:
                            self.stats["nonfinite"] += 1
                            lane["residual"] = None
                    lane["proxy"] = execution["proxy"]
                    if self.collect:
                        sample = dict(branch=branch, step=step, total=total, timestep=float(timestep_value),
                            proxyRelativeL1=execution["change"], residualRelativeL1=residual_change)
                        if self.local_guard:
                            sample.update(localProxyRelativeL1=execution["local_change"], localResidualRelativeL1=local_residual_change)
                        self.samples.append(sample)
                return result
            return forward

        try:
            for index, (owner, original, _) in enumerate(originals):
                owner.forward = wrap(index, original)
            result = model(**kwargs)
            if execution["visited"] != len(blocks):
                raise ValueError("Pinned Cosmos transformer block traversal changed")
            return result
        except BaseException:
            self.clear()
            raise
        finally:
            for owner, original, owned in originals:
                if owned:
                    owner.forward = original
                else:
                    del owner.forward


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
