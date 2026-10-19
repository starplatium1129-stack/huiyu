"""Video-specific calls to pinned upstream pipelines; no sampler implementation.

All adapters remain pending primary-machine validation. H3 deliberately loads
only local t2va components; repository loading specs are never followed.
"""
from contextlib import contextmanager


def load(root, spec, data, control, contract):
    import torch
    import diffusers
    if spec["pipeline"] == "MiniMaxH3ModularPipeline":
        import transformers
        pipeline = diffusers.MiniMaxH3ModularPipeline(workflow="t2va")
        index = contract.config(root, root / spec["indexFile"])
        components = {}
        for name in contract.MANIFEST["layouts"][spec["pipeline"]]:
            control.stage("loading", component=name)
            library, class_name = index[name][:2]
            cls = getattr(transformers if library == "transformers" else diffusers, class_name)
            kwargs = {"local_files_only": True}
            if name in ("text_encoder", "transformer", "vae", "audio_vae"):
                kwargs.update(torch_dtype=torch.bfloat16, use_safetensors=True)
            if library == "transformers":
                kwargs["trust_remote_code"] = False
            components[name] = cls.from_pretrained(str(root / name), **kwargs)
        pipeline.update_components(**components)
        return pipeline
    kwargs = dict(local_files_only=True, use_safetensors=True, torch_dtype=torch.bfloat16)
    if spec["pipeline"] == "WanPipeline":
        control.stage("loading", component="vae")
        kwargs["vae"] = diffusers.AutoencoderKLWan.from_pretrained(str(root / "vae"),
            local_files_only=True, use_safetensors=True, torch_dtype=torch.float32)
    return getattr(diffusers, spec["pipeline"]).from_pretrained(str(root), **kwargs)


def prepare(pipeline, spec, data):
    if spec["pipeline"] == "HunyuanVideo15Pipeline":
        from diffusers import ClassifierFreeGuidance
        # The fresh task's guider owns CFG, never the cached model components.
        pipeline.guider = ClassifierFreeGuidance.from_config(pipeline.guider.config, guidance_scale=data["cfg"])
    if spec["pipeline"] in ("HunyuanVideo15Pipeline", "LTX2Pipeline"):
        pipeline.vae.enable_tiling()
    pipeline.set_progress_bar_config(disable=True)


@contextmanager
def observe_scheduler(scheduler, control):
    """Observe real completed updates where upstream has no callback API.

    Hunyuan and H3 at the pinned revision expose scheduler.step, but no pipeline
    step callback. Wrap only this task's scheduler, preserve its returned value,
    and restore in finally. H3 observes audio (the second update in each step).
    Remove this bridge when the selected upstream exposes a public callback.
    """
    original = scheduler.step
    completed = 0

    def step(*args, **kwargs):
        nonlocal completed
        control.check()
        result = original(*args, **kwargs)
        completed += 1
        total = len(scheduler.timesteps)
        control.progress(completed, total)
        if completed == total:
            control.stage("decoding")
        return result

    scheduler.step = step
    try:
        yield
    finally:
        scheduler.step = original


def generate(pipeline, spec, data, control):
    import torch
    args = dict(prompt=data["prompt"], width=data["width"], height=data["height"],
                num_frames=data["frames"], num_inference_steps=data["steps"], output_type="np",
                generator=torch.Generator("cuda").manual_seed(data["seed"]))
    control.stage("encoding")
    name = spec["pipeline"]
    if name == "MiniMaxH3ModularPipeline":
        with observe_scheduler(pipeline.audio_scheduler, control):
            result = pipeline(**args, output=["videos", "audio", "sampling_rate"])
        return result["videos"][0], result["audio"][0], result["sampling_rate"]
    args["negative_prompt"] = data["negativePrompt"]
    if name == "HunyuanVideo15Pipeline":
        with observe_scheduler(pipeline.scheduler, control):
            result = pipeline(**args)
        return result.frames[0], None, None

    def on_step(pipe, step, timestep, callback_kwargs):
        control.progress(step + 1, len(pipe.scheduler.timesteps))
        if step + 1 == len(pipe.scheduler.timesteps):
            control.stage("decoding")
        return callback_kwargs

    args.update(guidance_scale=data["cfg"], callback_on_step_end=on_step, callback_on_step_end_tensor_inputs=[])
    if spec.get("layout") == "WanA14B":
        args["guidance_scale_2"] = spec["cfgLowNoise"]
    if name == "LTX2Pipeline":
        args.update(frame_rate=data["fps"], stg_scale=1.0, modality_scale=3.0, guidance_rescale=0.7,
                    audio_guidance_scale=7.0, audio_stg_scale=1.0, audio_modality_scale=3.0,
                    audio_guidance_rescale=0.7, spatio_temporal_guidance_blocks=[28],
                    use_cross_timestep=True, enable_prompt_enhancement=False)
    result = pipeline(**args)
    if name == "LTX2Pipeline":
        return result.frames[0], result.audio[0], pipeline.vocoder.config.output_sampling_rate
    return result.frames[0], None, None
