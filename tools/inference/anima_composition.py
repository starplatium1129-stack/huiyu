"""Bounded Anima composition requests; all learned extras and hooks belong to one job.

Denoiser integration adapts Apache-2.0 Diffusers 0.41.0 AnimaLoopDenoiser:
Copyright 2026 The HuggingFace Team. Apache License 2.0, distributed AS IS.
https://github.com/huggingface/diffusers/blob/v0.41.0/src/diffusers/modular_pipelines/anima/denoise.py
https://www.apache.org/licenses/LICENSE-2.0
"""
import math
import os
from pathlib import Path


def number(data, key, default, low, high, integer=False, *, error=ValueError):
    value = data.get(key, default)
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high or (integer and not isinstance(value, int)):
        if error is ValueError:
            raise error(f"{key} must be {'an integer' if integer else 'a number'} in [{low}, {high}]")
        raise error("INVALID_INPUT", f"{key} must be {'an integer' if integer else 'a number'} in [{low}, {high}]")
    return value


def validate(job, data, error):
    sketch, regions = data.get("sketchControl"), data.get("regions", [])
    if not isinstance(regions, list) or len(regions) > 4:
        raise error("INVALID_INPUT", "regions must contain at most four normalized rectangles")
    ids = set()
    for region in regions:
        if not isinstance(region, dict) or set(region) != {"id", "prompt", "x", "y", "width", "height"}:
            raise error("INVALID_INPUT", "Each region needs id, prompt and normalized x/y/width/height")
        if not isinstance(region["id"], str) or not 1 <= len(region["id"]) <= 96 or region["id"] in ids:
            raise error("INVALID_INPUT", "Regional IDs must be nonempty and unique")
        ids.add(region["id"])
        if not isinstance(region["prompt"], str) or not region["prompt"].strip() or len(region["prompt"]) > 1200:
            raise error("INVALID_INPUT", "Regional prompts must contain 1..1200 characters")
        for name in ("x", "y", "width", "height"):
            number(region, name, None, 0, 1, error=error)
        if region["width"] <= 0 or region["height"] <= 0 or region["x"] + region["width"] > 1 + 1e-6 or region["y"] + region["height"] > 1 + 1e-6:
            raise error("INVALID_INPUT", "Regional rectangles must have positive area within the image")
    if sketch is not None:
        if not isinstance(sketch, dict) or set(sketch) != {"image", "strength", "start", "end"}:
            raise error("INVALID_INPUT", "sketchControl needs image, strength, start and end")
        if not isinstance(sketch["image"], str) or not sketch["image"]:
            raise error("INVALID_INPUT", "Sketch image must name a retained recipe reference")
        number(sketch, "strength", None, 0, 2, error=error)
        number(sketch, "start", None, 0, 1, error=error)
        number(sketch, "end", None, 0, 1, error=error)
        if sketch["start"] >= sketch["end"]:
            raise error("INVALID_INPUT", "Sketch start must be earlier than end")
        for name in ("sketchImagePath", "sketchModelPath"):
            value = job.get(name)
            if not isinstance(value, str) or not Path(value).is_absolute() or not Path(value).is_file():
                raise error("INVALID_INPUT", f"{name} must be a host-approved existing absolute path")
        if Path(job["sketchImagePath"]).stat().st_size > 16 * 1024 * 1024:
            raise error("INVALID_INPUT", "Sketch image exceeds 16 MiB")
    elif job.get("sketchImagePath") is not None or job.get("sketchModelPath") is not None:
        raise error("INVALID_INPUT", "Private Sketch paths require sketchControl")
    if sketch is not None or regions:
        if os.environ.get("HUIYU_INFERENCE_ACCELERATION", "native") != "native" or os.environ.get("DIFFUSERS_ATTN_BACKEND") not in (None, "native"):
            raise error("UNSUPPORTED_OPTION", "Anima composition requires native attention; Sage/compiled modes are unsupported")
        if data.get("teaCache") or data.get("hiresFix"):
            raise error("UNSUPPORTED_OPTION", "Anima composition requires TeaCache and HiRes disabled")
    return data


class Composition:
    def __init__(self, job, data, tools, check=None):
        self.job, self.data, self.tools = job, data, tools
        self.check = check or (lambda: None)
        self.active = data.get("sketchControl") is not None or bool(data.get("regions"))
        self.regions = self.sketch = self.image = self.lease = None
        self.pipeline = None

    def apply_blocks(self, blocks):
        if not self.active:
            return blocks
        import torch
        from diffusers.modular_pipelines.anima.denoise import AnimaLoopDenoiser
        from diffusers.modular_pipelines.modular_pipeline_utils import InputParam
        owner = self
        if self.data.get("regions"):
            region_tools = self.tools("anima_regions")
            self.regions = region_tools.Regions(self.data["regions"])
            for route in ("text2image", "img2img"):
                original = blocks.sub_blocks["denoise"].sub_blocks[route].sub_blocks["text_conditioning"]
                def wrap(original):
                    class Conditioner(type(original)):
                        @torch.no_grad()
                        def __call__(self, components, state):
                            components, state = original(components, state)
                            contexts = region_tools.encode(components, owner.data["regions"], owner.tools, owner.check)
                            state.set("prompt_embeds", owner.regions.context(state.get("prompt_embeds"), contexts))
                            return components, state
                    return Conditioner()
                blocks.sub_blocks["denoise"].sub_blocks[route].sub_blocks["text_conditioning"] = wrap(original)

        class Denoiser(AnimaLoopDenoiser):
            @property
            def inputs(self):
                return super().inputs + [InputParam("timesteps", required=True)]

            @torch.no_grad()
            def __call__(self, components, block, i, t):
                components.guider.set_state(step=i, num_inference_steps=block.num_inference_steps, timestep=t)
                batches = components.guider.prepare_inputs_from_block_state(block, self._guider_input_fields)
                for batch in batches:
                    owner.check()
                    identifier = getattr(batch, "__guidance_identifier__")
                    if identifier not in ("pred_cond", "pred_uncond"):
                        raise ValueError("Unsupported composition guidance lane")
                    owner.before(block.latent_model_input, i, len(block.timesteps), identifier == "pred_cond")
                    components.guider.prepare_models(components.transformer)
                    try:
                        values = {name: getattr(batch, name).to(block.dtype) for name in self._guider_input_fields}
                        batch.noise_pred = components.transformer(hidden_states=block.latent_model_input,
                            timestep=block.timestep, padding_mask=block.padding_mask, return_dict=False, **values)[0]
                    finally:
                        if owner.regions is not None:
                            owner.regions.positive = False
                        components.guider.cleanup_models(components.transformer)
                block.noise_pred = components.guider(batches)[0]
                return components, block

        for route in ("text2image", "img2img"):
            blocks.sub_blocks["denoise"].sub_blocks[route].sub_blocks["denoise"].sub_blocks["denoiser"] = Denoiser()
        return blocks

    def before(self, latents, index, total, positive):
        self.check()
        if self.lease is not None and self.lease.cached and not self.lease.valid():
            raise ValueError("Sketch identity protection changed during inference")
        if self.regions is not None:
            self.regions.prepare_mask(latents)
            self.regions.positive = positive
        if self.sketch is not None:
            if self.sketch.cond is None:
                self.sketch.prepare(self.image, latents.shape, self.pipeline.transformer.dtype, latents.device)
            config = self.data["sketchControl"]
            self.sketch.multiplier = config["strength"] if config["start"] <= index / total < config["end"] else 0.

    def run(self, pipeline, data, **kwargs):
        self.pipeline = pipeline
        try:
            if self.active:
                self.check()
                if self.regions is not None:
                    self.regions.bind(pipeline.transformer)
                if self.data.get("sketchControl") is not None:
                    self.lease = self.tools("locked_identity").AssetIdentityLease(tree=False)
                    self.sketch = self.tools("anima_lllite").load(self.job["sketchModelPath"], self.tools, self.lease, self.check)
                    if len(pipeline.transformer.transformer_blocks) != 28:
                        raise ValueError("The official Sketch adapter supports only 28-layer Anima; expanded 40-layer models are unsupported")
                    from PIL import Image, ImageOps
                    import torch
                    with Image.open(self.job["sketchImagePath"]) as source:
                        if source.format not in {"PNG", "JPEG", "WEBP"} or getattr(source, "n_frames", 1) != 1 or source.width * source.height > 4096 * 4096:
                            raise ValueError("Sketch must be one PNG/JPEG/WebP with at most 16 megapixels")
                        rgba = ImageOps.exif_transpose(source).convert("RGBA")
                        white = Image.new("RGBA", rgba.size, "white")
                        white.alpha_composite(rgba)
                        self.image = white.convert("RGB").resize((data["width"], data["height"]), Image.Resampling.LANCZOS)
                        rgba.close()
                        white.close()
                    # The small extra is explicitly owned here, outside base/group-offload hooks.
                    weight_bytes = sum(value.numel() * value.element_size() for value in self.sketch.parameters())
                    if torch.cuda.mem_get_info()[0] < weight_bytes * 2 + 64 * 1024 * 1024:
                        raise ValueError("Insufficient free CUDA memory for the task-owned Sketch adapter")
                    self.sketch.to(device=pipeline._execution_device, dtype=pipeline.transformer.dtype)
                    self.sketch.bind(pipeline.transformer)
                    self.check()
            return self.tools("anima_refinement").run(pipeline, data, **kwargs)
        finally:
            if self.sketch is not None:
                self.sketch.close()
            if self.regions is not None:
                self.regions.close()
            if self.image is not None:
                self.image.close()
            self.sketch = self.image = self.pipeline = None
            if self.lease is not None:
                self.lease.close()
                self.lease = None
