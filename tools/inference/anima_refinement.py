"""Two-pass Anima refinement and final pixel processing for the desktop worker.

Only the Latent/Remacri product routes are supported. Intermediate pixels stay
display RGB float tensors [1,3,H,W]; normalized diffusion latents stay
[1,C,1,H/8,W/8]. PNG and Lanczos boundaries use RGB uint8 truncation.
No Comfy implementation is imported or copied. Single-frame VAE operations
delegate to the pinned Apache-2.0 Diffusers modules through anima_vae.py.
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
    values = np.array(image.convert("RGB"), dtype=np.float32)
    values /= 255
    return torch.from_numpy(values).permute(2, 0, 1).unsqueeze(0).to(device)


def _pil(images):
    import numpy as np
    from PIL import Image
    values = _rgb(images)[0].detach().cpu().permute(1, 2, 0).numpy()
    pixels = np.empty(values.shape, dtype=np.uint8)
    # Keep FP32 multiply/clip/truncation, with at most 128 rows of scratch
    # instead of two complete float canvases for a Remacri 4x intermediate.
    for top in range(0, values.shape[0], 128):
        band = values[top:top + 128]
        if not np.isfinite(band).all():
            raise ValueError("Decoded image contains nonfinite pixels; refusing to publish a black/corrupted result")
        scaled = band * 255
        np.clip(scaled, 0, 255, out=scaled)
        pixels[top:top + 128] = scaled
        del scaled
    return Image.fromarray(pixels)


def _lanczos(images, size, *, cpu_output=False):
    """Workflow Lanczos: truncate display RGB to uint8 before Pillow resize."""
    from PIL import Image
    images = _rgb(images)
    source = _pil(images).resize(size, Image.Resampling.LANCZOS)
    return _pil_tensor(source, "cpu" if cpu_output else images.device)


def _composite(images, original, mask):
    import numpy as np
    import torch
    images = _rgb(images)
    size = (images.shape[-1], images.shape[-2])
    # The protected reference is explicitly the resized original PIL image.
    reference = _pil_tensor(original, "cpu")
    if original.size != size:
        reference = _lanczos(reference, size, cpu_output=True)
    reference = reference.to(images.device)
    alpha = torch.from_numpy(np.asarray(mask, dtype=np.float32))[None, None].to(images.device)
    if alpha.shape[-2:] != images.shape[-2:]:
        alpha = torch.nn.functional.interpolate(alpha, size=images.shape[-2:], mode="nearest-exact")
    # Reference owns its converted pixels. Reuse only that private allocation
    # and the new result, retaining separate multiply/subtract/multiply/add.
    result = images * alpha
    reference.mul_(1 - alpha)
    return result.add_(reference)


def _upscale_latents(pipeline, latents, size, vae_tools):
    import torch
    if not isinstance(latents, torch.Tensor) or latents.ndim != 5 or latents.shape[0] != 1 or latents.shape[2] != 1:
        raise ValueError("HiRes requires one normalized [1,C,1,H,W] latent")
    if not bool(torch.isfinite(latents).all()):
        raise ValueError("HiRes latents contain nonfinite values; refusing to publish a corrupted result")
    return vae_tools.upscale_latents(pipeline.vae, latents, size)


def _encode(pipeline, pixels, vae_tools, tiling):
    pixels = _rgb(pixels)
    return vae_tools.encode(pipeline, pixels, tiling, height=pixels.shape[-2], width=pixels.shape[-1])


@contextmanager
def _finite_decode(vae, before_decode=None):
    """Check before display clamping while retaining upstream PIL conversion."""
    import torch
    original, owned = vae.decode, "decode" in vae.__dict__
    raw_finite = None

    def check_raw_decoder(module, inputs, output):
        nonlocal raw_finite
        finite = torch.isfinite(output).all()
        raw_finite = finite if raw_finite is None else raw_finite & finite

    # Ordinary upstream _decode clamps before returning; observe the decoder
    # output itself so Inf cannot become a finite display value. Tiles only
    # accumulate device scalars; there is no per-tile host synchronization.
    handle = vae.decoder.register_forward_hook(check_raw_decoder)

    def decode(latents, *args, **kwargs):
        nonlocal raw_finite
        raw_finite = None
        if before_decode is not None:
            before_decode()
        latent_finite = torch.isfinite(latents).all()
        result = original(latents, *args, **kwargs)
        pixels = result[0] if isinstance(result, tuple) else result.sample
        # One scalar readback per decode boundary, not per denoising step.
        finite = latent_finite & torch.isfinite(pixels).all().to(latent_finite.device)
        if raw_finite is not None:
            finite &= raw_finite
        if not bool(finite):
            raise ValueError("VAE latents or decoded pixels contain nonfinite values; refusing to publish a corrupted result")
        return result

    vae.decode = decode
    try:
        yield
    finally:
        handle.remove()
        if owned:
            vae.decode = original
        else:
            del vae.decode


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




def _second_pipeline(pipeline, data, spec, sampling, mask_tools, vae_tools, tiling, prepare_second_blocks=None):
    from diffusers import AnimaModularPipeline, ClassifierFreeGuidance
    from diffusers.modular_pipelines.anima.modular_blocks_anima import AnimaAutoBlocks
    blocks = mask_tools.masked_blocks() if spec["masked"] else AnimaAutoBlocks()
    # Same prompt, exact base/LoRAs and CFG branches: reuse the already computed
    # conditioning, without rerunning Qwen or changing its floating-point values.
    blocks.sub_blocks.pop("text_encoder")
    for name in ("text2image", "img2img"):
        blocks.sub_blocks["denoise"].sub_blocks[name].sub_blocks.pop("text_conditioning")
    blocks = vae_tools.apply_blocks(blocks, tiling)
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
        observe_schedule=None, before_decode=None, vae_tools=None, tiling=None):
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
    GPU work can finish in a later stage. Only real CUDA OOM permits the bounded
    VAE/Remacri tile fallback; no precision or inference-device fallback occurs.
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
                  vaeOperations=pipeline.vae._huiyu_vae_events)

    def timed(field, function):
        before = time.perf_counter()
        try:
            return function()
        finally:
            report[field] += time.perf_counter() - before

    first_steps = data["steps"]
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
            with _finite_decode(current.vae, before_decode):
                result = timed("pipelineWallSeconds", lambda: current(**kwargs))
            if observe_schedule is not None:
                name = "first" if phase == "firstPassSteps" else "second"
                report.setdefault("schedules", {})[name] = observe_schedule(name, current.scheduler, report[phase])
            return result
        finally:
            current.scheduler.step = previous

    options = (sampling.sampling_options(data.get("sampler", "euler"), data.get("scheduler", "simple"),
                                        data["steps"], pipeline.scheduler) if sampling is not None else {})
    kwargs = dict(prompt=data["prompt"], negative_prompt=data.get("negativePrompt", ""), width=data["width"],
                  height=data["height"], num_inference_steps=data["steps"],
                  generator=torch.Generator(device="cpu").manual_seed(data["seed"]), **options)
    if image is not None:
        kwargs.update(image=image, **sampling.refinement_options(data.get("scheduler", "simple"),
            data["steps"], data["denoisingStrength"], pipeline.scheduler, sampler=data.get("sampler", "euler")))
    if mask is not None:
        kwargs["mask_image"] = mask
    if spec["enabled"]:
        primary = "latents" if spec["firstLatents"] else "images"
        kwargs["output"] = [primary, "prompt_embeds", "negative_prompt_embeds"]
        if not spec["firstLatents"]:
            kwargs["output_type"] = "pt"
    else:
        kwargs.update(output="images", output_type="pt")
    with _without_decode(pipeline, spec["firstLatents"]):
        first = execute(pipeline, "firstPassSteps", kwargs)
    del kwargs

    pixels = None if spec["firstLatents"] else _rgb(first["images"] if spec["enabled"] else first)
    conditioning = ({name: first[name] for name in ("prompt_embeds", "negative_prompt_embeds")}
                    if spec["second"] else {})
    first_latents = first["latents"] if spec["firstLatents"] else None
    del first
    if mask is not None:
        pixels = timed("compositeWallSeconds", lambda: _composite(pixels, image, mask))
    size = (spec["width"], spec["height"])
    if spec["enabled"] and spec["kind"] == "Remacri":
        pixels = timed("postprocessWallSeconds", lambda: _lanczos(upscale(pixels), size,
            cpu_output=not spec["second"] and not spec["rcasStrength"]))
    if spec["second"]:
        latents = (first_latents if spec["firstLatents"] else
                   timed("pipelineWallSeconds", lambda: _encode(pipeline, pixels, vae_tools, tiling)))
        first_latents = None
        pixels = None
        if spec["kind"] == "Latent":
            latents = timed("postprocessWallSeconds", lambda: _upscale_latents(pipeline, latents, size, vae_tools))
        second = _second_pipeline(pipeline, data, spec, sampling, mask_tools, vae_tools, tiling, prepare_second_blocks)
        options = sampling.refinement_options(spec["scheduler"], spec["secondSteps"], data["hiresDenoise"],
                                              second.scheduler, sampler=spec["sampler"])
        kwargs = dict(image_latents=latents, width=size[0], height=size[1], output_type="pt", output="images",
                      **conditioning,
                      generator=torch.Generator(device="cpu").manual_seed(spec["secondSeed"]), **options)
        del latents, conditioning
        if mask is not None:
            kwargs["mask_image"] = mask_tools.resize_mask(mask, size)
        with _patch_grid(pipeline.transformer):
            pixels = _rgb(execute(second, "secondPassSteps", kwargs))
        del kwargs, second
        if report["secondPassSteps"] != spec["secondSteps"]:
            raise ValueError("HiRes second pass did not execute its planned denoising steps")
    if spec["rcasStrength"]:
        pixels = timed("postprocessWallSeconds", lambda: postprocess.rcas(pixels, spec["rcasStrength"]))
        report["rcasExecutionRevision"] = postprocess.EXECUTION_REVISION
    if mask is not None and spec["enabled"]:
        pixels = timed("compositeWallSeconds", lambda: _composite(pixels, image, mask))
    result = timed("postprocessWallSeconds", lambda: _pil(pixels))
    report["wallSeconds"] = time.perf_counter() - started
    return result, report["firstPassSteps"] + report["secondPassSteps"], report
