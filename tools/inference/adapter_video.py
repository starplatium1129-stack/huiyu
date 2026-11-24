"""Native video execution with pinned upstream pipelines and local model layouts.

H3 loads the video encoder only for DWD tasks with keyframes.
"""
from contextlib import contextmanager, nullcontext
from huiyu_worker_lifecycle import load_sibling


def load(root, spec, data, control, contract):
    import torch
    import diffusers
    if spec.get("blocks"):
        import transformers
        kwargs = {"workflow": spec["workflow"]} if spec.get("workflow") else {}
        cls = getattr(diffusers, spec["pipeline"])
        dwd = data.get("h3Decoder") == "dwd"
        pipeline = load_sibling("h3_piflow").pipeline(cls, data["_videoImage"]) if dwd else cls(**kwargs)
        index = contract.config(root, root / spec["indexFile"])
        components = {}
        for name in contract.MANIFEST["layouts"][spec["pipeline"]]:
            if dwd and name not in pipeline.pretrained_component_names:
                continue
            control.stage("loading", component=name)
            library, class_name = index[name][:2]
            cls = getattr(transformers if library == "transformers" else diffusers, class_name)
            kwargs = {"local_files_only": True}
            if name in ("text_encoder", "image_encoder", "transformer", "vae", "audio_vae"):
                kwargs.update(torch_dtype=torch.bfloat16, use_safetensors=True)
            if library == "transformers":
                kwargs["trust_remote_code"] = False
            if data.get("_h3TurboSteps"):
                if name == "transformer":
                    packed = load_sibling("h3_packed")
                    variant = data.get("_h3AccelerationPath")
                    extra = {("fused_path" if data["videoAttention"] == "h3-fused" else "sla_path"): variant} if variant else {}
                    if dwd:
                        extra["dwd_path"] = data["_h3DwdPath"]
                    components[name] = packed.load_transformer(root, data["steps"], control, contract, **extra)
                    continue
                if name == "text_encoder":
                    components[name] = load_sibling("h3_text").load_encoder(root, control)
                    continue
                if name in ("vae", "audio_vae"):
                    vae = load_sibling("h3_vae")
                    components[name] = vae.load_vae(root, name, control, contract,
                        lightvae=name == "vae" and data.get("h3Decoder") == "lightvae",
                        encoder_only=name == "vae" and dwd)
                    continue
            component = cls.from_pretrained(str(root / name), **kwargs)
            if name == "text_encoder" and spec["pipeline"] == "MiniMaxH3ModularPipeline":
                # Both H3 workflows condition on hidden_states[50]. Keep one more
                # layer so this index remains the pre-normalization intermediate.
                language = component.model.language_model
                keep = pipeline.text_encoder_layer + 1
                if len(language.layers) > keep:
                    language.layers = language.layers[:keep]
                    language.config.num_hidden_layers = keep
                component.lm_head = torch.nn.Identity()
            components[name] = component
        pipeline.update_components(**components)
        return pipeline
    kwargs = dict(local_files_only=True, use_safetensors=True, torch_dtype=torch.bfloat16)
    if spec.get("layout") == "LTX25Distilled":
        # Fixed-duration, single-stage generation needs only the distilled DiT
        # and its own Gemma 4 encoder. The upstream index also lists optional
        # components in separate folders that the managed bundle omits.
        kwargs.update(prompt_enhancer=None, processor=None, duration_head=None)
    if spec["pipeline"] == "WanPipeline":
        control.stage("loading", component="text_encoder")
        kwargs["text_encoder"] = load_sibling("wan_pipeline").text_encoder(root, contract)
        control.stage("loading", component="vae")
        kwargs["vae"] = diffusers.AutoencoderKLWan.from_pretrained(str(root / "vae"),
            local_files_only=True, use_safetensors=True, torch_dtype=torch.float32)
    return getattr(diffusers, spec["pipeline"]).from_pretrained(str(root), **kwargs)


def task_pipeline(pipeline_class, components, parameters, spec, image_conditioned, *, dwd=False):
    if spec.get("blocks"):
        kwargs = {"workflow": "fl2va" if image_conditioned else "t2va"} if spec["pipeline"] == "MiniMaxH3ModularPipeline" else {}
        pipeline = load_sibling("h3_piflow").pipeline(pipeline_class, image_conditioned) if dwd else pipeline_class(**kwargs)
        # A modular workflow creates its own preprocessing components from
        # config, including the keyframe resizer for fl2va.
        pipeline.update_components(**{name: components[name] for name in pipeline.pretrained_component_names})
        return pipeline
    if image_conditioned and spec["pipeline"] != "Kandinsky6TI2VAPipeline":
        import diffusers
        if spec["pipeline"] == "WanPipeline" and parameters.get("expand_timesteps"):
            pipeline_class = diffusers.WanImageToVideoPipeline
        elif spec["pipeline"] == "LTX2Pipeline":
            pipeline_class = diffusers.LTX2ImageToVideoPipeline
        else:
            raise ValueError(f"No image-to-video pipeline for {spec['pipeline']}")
    pipeline = pipeline_class(**components, **parameters)
    if spec["pipeline"] == "WanPipeline":
        return load_sibling("wan_pipeline").bind(pipeline)
    return pipeline


def placement(components, policy, data, spec, device, backend):
    local_video = data["modelId"] == "wan2.2-ti2v-5b" or data.get("_h3TurboSteps")
    if local_video and policy == "offload" and backend == "cuda" and device.index in (0, None):
        return load_sibling("video_memory").Residency(components, data)
    return load_sibling("native_memory").Residency(components, policy, device=device)


def prepare(pipeline, spec, data):
    if spec["pipeline"] == "HunyuanVideo15Pipeline":
        from diffusers import ClassifierFreeGuidance
        # The fresh task's guider owns CFG, never the cached model components.
        pipeline.guider = ClassifierFreeGuidance.from_config(pipeline.guider.config, guidance_scale=data["cfg"])
    if (spec["pipeline"] in ("HunyuanVideo15Pipeline", "LTX2Pipeline", "Kandinsky6TI2VAPipeline")
            or data.get("_h3TurboSteps") and getattr(pipeline, "vae", None) is not None
            or spec["pipeline"] in ("WanPipeline", "WanAnimate2DistilledModularPipeline")
            and pipeline._huiyu_memory.policy == "offload"):
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


def generate(pipeline, spec, data, control, *, device, image=None, last_frame=None, driving_video=None):
    if spec["pipeline"] == "WanAnimate2DistilledModularPipeline":
        return load_sibling("wan_motion").generate(pipeline, data, control, device, image, driving_video)
    import torch
    args = dict(prompt=data["prompt"], width=data["width"], height=data["height"],
                num_frames=data["frames"], num_inference_steps=data["steps"], output_type="np",
                generator=torch.Generator(device=device).manual_seed(data["seed"]))
    if image is not None:
        args["image"] = image
    if last_frame is not None:
        args["last_image"] = last_frame
    control.stage("encoding")
    name = spec["pipeline"]
    if name == "MiniMaxH3ModularPipeline":
        context = nullcontext()
        if data.get("_h3TurboSteps"):
            context = load_sibling("h3_packed").refine_context(pipeline.transformer, pipeline._huiyu_h3_conditioning)
            if data.get("h3Decoder") == "dwd":
                with context:
                    return load_sibling("h3_piflow").generate(pipeline, args, data, control, device, observe_scheduler)
            # The installed four-step adapter is the 768p release. The eight-step
            # adapter is the 544p release, whose video noise shift differs.
            pipeline.scheduler.set_shift(float(data["h3VideoShift"]))
            pipeline.audio_scheduler.set_shift(3.0)
            # MiniMaxH3Scheduler includes zero in its grid. N Turbo evaluations
            # require N+1 grid points on both the video and audio schedules.
            args["num_inference_steps"] = data["steps"] + 1
        with context, observe_scheduler(pipeline.audio_scheduler, control):
            result = pipeline(**args, output=["videos", "audio", "sampling_rate"])
        return result["videos"][0], result["audio"][0], result["sampling_rate"]
    if spec["negative"]:
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
        # The keyframe pipeline's optional lossy CRF preprocessing needs PyAV.
        # Feed the decoded RGB keyframe directly in the offline adapter runtime.
        if image is not None:
            args["image_crf"] = 0
        args.update(frame_rate=data["fps"], use_cross_timestep=True, enable_prompt_enhancement=False)
        if spec.get("layout") == "LTX25Distilled":
            from diffusers.pipelines.ltx2.utils import DISTILLED_SIGMA_VALUES
            # The eight teacher-distilled noise levels replace the generic
            # linear schedule, with one joint video/audio prediction per step.
            args.pop("num_inference_steps")
            args.update(sigmas=DISTILLED_SIGMA_VALUES, audio_guidance_scale=1.0,
                        stg_scale=0.0, audio_stg_scale=0.0, modality_scale=1.0, audio_modality_scale=1.0,
                        guidance_rescale=0.0, audio_guidance_rescale=0.0)
        else:
            args.update(stg_scale=1.0, modality_scale=3.0, guidance_rescale=0.7, audio_guidance_scale=7.0,
                        audio_stg_scale=1.0, audio_modality_scale=3.0, audio_guidance_rescale=0.7,
                        spatio_temporal_guidance_blocks=[28])
    elif name == "Kandinsky6TI2VAPipeline":
        args.update(frame_rate=data["fps"], sample_audio=True, expand_prompts=False)
    result = pipeline(**args)
    if name == "Kandinsky6TI2VAPipeline":
        # output_type=np yields a batched mono NumPy waveform; the muxer takes
        # a channel-first waveform with its channel axis intact.
        return result.frames[0], torch.from_numpy(result.audio[0]).unsqueeze(0), pipeline.audio_sample_rate
    if name == "LTX2Pipeline":
        return result.frames[0], result.audio[0], pipeline.vocoder.config.output_sampling_rate
    return result.frames[0], None, None
