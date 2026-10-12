"""Two-pass Anima refinement and final pixel processing for the desktop worker.

Only the Latent/Remacri product routes are supported. Intermediate pixels stay
display RGB float tensors [1,3,H,W]; normalized diffusion latents stay
[1,C,1,H/8,W/8]. PIL conversion happens only at delivery, except the deliberately
unchanged non-hires/no-RCAS path. No Comfy implementation is imported or copied.
VAE encoding delegates to Apache-2.0 Diffusers 0.41's Anima encoder helper.
"""
from contextlib import contextmanager
import math
import time


def plan(data, *, has_input=False, masked=False):
    enabled = bool(data.get("hiresFix")) and data.get("hiresScale", 1) > 1
    kind = data.get("hiresUpscaler", "Latent")
    if enabled and kind not in ("Latent", "Remacri"):
        raise ValueError("Resolve the Anima hires upscaler to Latent or Remacri before refinement")
    width, height = data["width"], data["height"]
    if enabled:
        scale = data["hiresScale"]
        rounding = round if kind == "Latent" else lambda value: math.floor(value + .5)
        width, height = (int(rounding(value * scale / 8)) * 8 for value in (width, height))
    second = enabled and (kind == "Latent" or masked)
    sampler, scheduler = data.get("hiresSampler"), data.get("hiresScheduler")
    if second and (sampler is None or scheduler is None):
        raise ValueError("HiRes sampling needs the host-resolved hiresSampler and hiresScheduler")
    sharpen = (enabled and kind == "Latent") or (not enabled and not has_input)
    return dict(enabled=enabled, kind=kind, width=width, height=height, masked=masked,
                second=second, secondSteps=max(12, math.floor(data["steps"] * .6 + .5)) if second else 0,
                secondSeed=data["seed"] + 1, sampler=sampler, scheduler=scheduler,
                firstLatents=enabled and kind == "Latent" and not masked,
                rcasStrength=data.get("rcasStrength", .75) if sharpen else 0)


def _rgb(images):
    import torch
    if (not isinstance(images, torch.Tensor) or images.ndim != 4 or images.shape[:2] != (1, 3)
            or images.dtype not in (torch.float16, torch.bfloat16, torch.float32)):
        raise ValueError("Refinement requires one display RGB floating [1,3,H,W] image")
    return images.float()


def _pil_tensor(image, device):
    import numpy as np
    import torch
    return torch.from_numpy(np.array(image.convert("RGB"), dtype=np.float32) / 255).permute(2, 0, 1).unsqueeze(0).to(device)


def _pil(images):
    import numpy as np
    from PIL import Image
    values = _rgb(images)[0].detach().cpu().permute(1, 2, 0).numpy()
    if not np.isfinite(values).all():
        raise ValueError("Decoded image contains nonfinite pixels; refusing to publish a black/corrupted result")
    return Image.fromarray((values.clip(0, 1) * 255).round().astype(np.uint8))


def _lanczos(images, size):
    """Pillow float-channel Lanczos, avoiding an intermediate 8-bit RGB image."""
    import numpy as np
    import torch
    from PIL import Image
    images = _rgb(images)
    if images.shape[-2:] == (size[1], size[0]):
        return images
    source = images[0].detach().cpu().numpy()
    channels = [np.asarray(Image.fromarray(channel).resize(size, Image.Resampling.LANCZOS)) for channel in source]
    return torch.from_numpy(np.stack(channels).copy()).unsqueeze(0).to(images.device).clamp(0, 1)


def _composite(images, original, mask):
    import numpy as np
    import torch
    from PIL import Image
    images = _rgb(images)
    size = (images.shape[-1], images.shape[-2])
    # The protected reference is explicitly the resized original PIL image.
    reference = _pil_tensor(original.resize(size, Image.Resampling.LANCZOS), images.device)
    effective = mask.resize(size, Image.Resampling.NEAREST)
    alpha = torch.from_numpy(np.array(effective, dtype=np.float32) / 255).to(images.device)[None, None]
    return torch.where(alpha == 0, reference, images * alpha + reference * (1 - alpha))


def _upscale_latents(latents, size):
    import torch
    if not isinstance(latents, torch.Tensor) or latents.ndim != 5 or latents.shape[0] != 1 or latents.shape[2] != 1:
        raise ValueError("HiRes requires one normalized [1,C,1,H,W] latent")
    return torch.nn.functional.interpolate(latents[:, :, 0].float(), size=(size[1] // 8, size[0] // 8),
                                          mode="bicubic", align_corners=False).unsqueeze(2)


def _encode(pipeline, pixels):
    import torch
    from diffusers.modular_pipelines.anima.encoders import encode_vae_image
    pixels = _rgb(pixels)
    prepared = pipeline.image_processor.preprocess(pixels, height=pixels.shape[-2], width=pixels.shape[-1])
    # Argmax encoding consumes no random numbers; pass two owns a fresh seed+1 RNG.
    with torch.no_grad():
        return encode_vae_image(prepared, pipeline.vae, generator=None, sample_mode="argmax",
                                device=pipeline._execution_device, dtype=pipeline.vae.dtype,
                                latent_channels=pipeline.num_channels_latents)


@contextmanager
def _without_decode(pipeline, enabled):
    if not enabled:
        yield
        return
    decoder = pipeline.blocks.sub_blocks.pop("decode")
    try:
        yield
    finally:
        pipeline.blocks.sub_blocks["decode"] = decoder


@contextmanager
def _patch_grid(transformer):
    """Preserve /8 product dimensions, including an odd latent H or W.

    Pad only the denoiser input to its /2 patch grid; crop its prediction back
    before the scheduler update. Noise, diffusion state and final VAE dimensions
    retain the requested size. This does not enlarge or redraw the noise tensor.
    """
    import torch
    original, owned = transformer.forward, "forward" in transformer.__dict__
    rope, original_max_size = transformer.rope, transformer.rope.max_size

    def forward(hidden_states, *args, **kwargs):
        height, width = hidden_states.shape[-2:]
        if height % 2 or width % 2:
            hidden_states = torch.nn.functional.pad(hidden_states, (0, width % 2, 0, height % 2, 0, 0), mode="circular")
        extent = [size // patch for size, patch in zip(hidden_states.shape[-3:], rope.patch_size)]
        # Cosmos uses max_size only to allocate the RoPE coordinate sequence.
        # Extending it preserves theta/NTK and every existing coordinate value.
        rope.max_size = ([max(limit, size) for limit, size in zip(original_max_size, extent)]
                         if any(size > limit for size, limit in zip(extent, original_max_size))
                         else original_max_size)
        result = original(hidden_states, *args, **kwargs)
        if isinstance(result, tuple):
            return (result[0][..., :height, :width], *result[1:])
        return result.__class__(sample=result.sample[..., :height, :width])

    transformer.forward = forward
    try:
        yield
    finally:
        rope.max_size = original_max_size
        if owned:
            transformer.forward = original
        else:
            del transformer.forward


@contextmanager
def _tiled_vae(vae):
    names = ("use_tiling", "tile_sample_min_height", "tile_sample_min_width",
             "tile_sample_stride_height", "tile_sample_stride_width")
    previous = {name: getattr(vae, name) for name in names}
    vae.enable_tiling(tile_sample_min_height=512, tile_sample_min_width=512,
                      tile_sample_stride_height=384, tile_sample_stride_width=384)
    try:
        yield
    finally:
        for name, value in previous.items():
            setattr(vae, name, value)


def _second_pipeline(pipeline, data, spec, sampling, mask_tools, prepare_second_blocks=None):
    from diffusers import AnimaModularPipeline, ClassifierFreeGuidance
    from diffusers.modular_pipelines.anima.modular_blocks_anima import AnimaAutoBlocks
    blocks = mask_tools.masked_blocks() if spec["masked"] else AnimaAutoBlocks()
    # Same prompt, exact base/LoRAs and CFG branches: reuse the already computed
    # conditioning, without rerunning Qwen or changing its floating-point values.
    blocks.sub_blocks.pop("text_encoder")
    for name in ("text2image", "img2img"):
        blocks.sub_blocks["denoise"].sub_blocks[name].sub_blocks.pop("text_conditioning")
    if prepare_second_blocks is not None:
        # The owner validates a whole-hires profile, clears per-pass Tea lanes,
        # and wraps only these fresh blocks. Samples/statistics may stay pooled.
        blocks = prepare_second_blocks(blocks)
    second = AnimaModularPipeline(blocks=blocks)
    names = {component.name for component in blocks.expected_components}
    components = {name: value for name, value in pipeline.components.items() if name in names}
    components.update(scheduler=sampling.new_scheduler(spec["sampler"], dict(pipeline.scheduler.config)),
                      guider=ClassifierFreeGuidance(guidance_scale=data["cfg"]))
    second.update_components(**components)
    second.set_progress_bar_config(disable=True)
    return second


def run(pipeline, data, *, image=None, mask=None, mask_tools=None, sampling=None,
        postprocess=None, upscale=None, progress=None, prepare_second_blocks=None,
        observe_schedule=None):
    """Return (single PIL image, actual scheduler steps, stage observations).

    pipeline is the caller's configured first-pass pipeline. sampling supplies
    sampling_options/new_scheduler/refinement_options; postprocess supplies
    rcas(); upscale is a preloaded FP32 Remacri images->4x-images callback. The
    caller owns model loading/lifetimes, cancellation and TeaCache cleanup.
    prepare_second_blocks(blocks) returns the fresh pass-two blocks after any
    per-pass controller reset/wrapping. observe_schedule(phase, scheduler, steps)
    optionally captures benchmark evidence after a successful pass; phases are
    first/second and steps are that pass's actual scheduler calls, never the sum.

    Stage timings are CPU wall spans without extra CUDA synchronization; queued
    GPU work can finish in a later stage. No retries or precision fallback occur.
    """
    import torch
    from PIL import Image
    started = time.perf_counter()
    spec = plan(data, has_input=image is not None, masked=mask is not None)
    if mask is not None and (image is None or mask_tools is None):
        raise ValueError("Masked refinement needs the prepared reference and mask tools")
    if spec["rcasStrength"] and postprocess is None:
        raise ValueError("RCAS processing helper is required")
    if spec["enabled"] and spec["kind"] == "Remacri" and upscale is None:
        raise ValueError("HiRes Remacri requires its preloaded local upscaler callback")
    if spec["second"] and sampling is None:
        raise ValueError("HiRes needs the configured sampling helper")
    report = dict(pipelineWallSeconds=0., postprocessWallSeconds=0., compositeWallSeconds=0.,
                  firstPassSteps=0, secondPassSteps=0, width=spec["width"], height=spec["height"],
                  secondPassSeed=spec["secondSeed"] if spec["second"] else None,
                  vaeTiling={"pixels": 512, "stride": 384} if spec["second"] else None)

    def timed(field, function):
        before = time.perf_counter()
        try:
            return function()
        finally:
            report[field] += time.perf_counter() - before

    first_steps = (data["steps"] if image is None else
                   data["steps"] - int(data["steps"] - data["steps"] * data["denoisingStrength"]))
    total = first_steps + spec["secondSteps"]

    def execute(current, phase, kwargs):
        previous = current.scheduler.step

        def step(*args, **kw):
            result = previous(*args, **kw)
            report[phase] += 1
            if progress is not None:
                progress(report["firstPassSteps"] + report["secondPassSteps"], total)
            return result

        current.scheduler.step = step
        try:
            result = timed("pipelineWallSeconds", lambda: current(**kwargs))
            if observe_schedule is not None:
                name = "first" if phase == "firstPassSteps" else "second"
                report.setdefault("schedules", {})[name] = observe_schedule(name, current.scheduler, report[phase])
            return result
        finally:
            current.scheduler.step = previous

    options = (sampling.sampling_options(data.get("sampler", "euler"), data.get("scheduler", "simple"),
                                        data["steps"], pipeline.scheduler) if sampling is not None else {})
    legacy = not spec["enabled"] and not spec["rcasStrength"]
    kwargs = dict(prompt=data["prompt"], negative_prompt=data.get("negativePrompt", ""), width=data["width"],
                  height=data["height"], num_inference_steps=data["steps"],
                  generator=torch.Generator(device=pipeline._execution_device).manual_seed(data["seed"]), **options)
    if image is not None:
        kwargs.update(image=image, strength=data["denoisingStrength"])
    if mask is not None:
        kwargs["mask_image"] = mask
    if spec["enabled"]:
        primary = "latents" if spec["firstLatents"] else "images"
        kwargs["output"] = [primary, "prompt_embeds", "negative_prompt_embeds"]
        if not spec["firstLatents"]:
            kwargs["output_type"] = "pt"
    else:
        kwargs.update(output="images", output_type="pil" if legacy else "pt")
    with _without_decode(pipeline, spec["firstLatents"]):
        first = execute(pipeline, "firstPassSteps", kwargs)
    if legacy:
        if not first or len(first) != 1:
            raise ValueError("Pipeline returned no single image")
        result = timed("compositeWallSeconds", lambda: mask_tools.composite(first[0], image, mask)) if mask is not None else first[0]
        report["wallSeconds"] = time.perf_counter() - started
        return result, report["firstPassSteps"], report

    pixels = None if spec["firstLatents"] else _rgb(first["images"] if spec["enabled"] else first)
    if mask is not None:
        pixels = timed("compositeWallSeconds", lambda: _composite(pixels, image, mask))
    size = (spec["width"], spec["height"])
    if spec["enabled"] and spec["kind"] == "Remacri":
        pixels = timed("postprocessWallSeconds", lambda: _lanczos(upscale(pixels), size))
    if spec["second"]:
        with _tiled_vae(pipeline.vae):
            latents = (first["latents"] if spec["firstLatents"] else
                       timed("pipelineWallSeconds", lambda: _encode(pipeline, pixels)))
            if spec["kind"] == "Latent":
                latents = timed("postprocessWallSeconds", lambda: _upscale_latents(latents, size))
            second = _second_pipeline(pipeline, data, spec, sampling, mask_tools, prepare_second_blocks)
            options = sampling.refinement_options(spec["scheduler"], spec["secondSteps"], data["hiresDenoise"],
                                                  second.scheduler, sampler=spec["sampler"])
            kwargs = dict(image_latents=latents, width=size[0], height=size[1], output_type="pt", output="images",
                          prompt_embeds=first["prompt_embeds"], negative_prompt_embeds=first["negative_prompt_embeds"],
                          generator=torch.Generator(device=pipeline._execution_device).manual_seed(spec["secondSeed"]), **options)
            if mask is not None:
                kwargs["mask_image"] = mask.resize(size, Image.Resampling.NEAREST)
            with _patch_grid(pipeline.transformer):
                pixels = _rgb(execute(second, "secondPassSteps", kwargs))
            if report["secondPassSteps"] != spec["secondSteps"]:
                raise ValueError("HiRes second pass did not execute its planned denoising steps")
    if spec["rcasStrength"]:
        pixels = timed("postprocessWallSeconds", lambda: postprocess.rcas(pixels, spec["rcasStrength"]))
    if mask is not None and spec["enabled"]:
        pixels = timed("compositeWallSeconds", lambda: _composite(pixels, image, mask))
    result = timed("postprocessWallSeconds", lambda: _pil(pixels))
    report["wallSeconds"] = time.perf_counter() - started
    return result, report["firstPassSteps"] + report["secondPassSteps"], report
