"""Strict local component loading, with byte-identified unadapted reuse."""


def load(root, cfg, blocks, reusable, tools, error):
    import torch
    from diffusers import AnimaModularPipeline, AnimaTextConditioner, AutoencoderKLQwenImage, CosmosTransformer3DModel, FlowMatchEulerDiscreteScheduler, ClassifierFreeGuidance
    from transformers import Qwen3Model, Qwen2Tokenizer, T5Tokenizer, T5TokenizerFast
    if not torch.cuda.is_available():
        raise error("DEVICE_UNAVAILABLE", "A CUDA-capable PyTorch installation and NVIDIA GPU are required; no CPU fallback is attempted")
    dtype = torch.bfloat16 if torch.cuda.is_bf16_supported() else torch.float16
    pipeline = AnimaModularPipeline(blocks=blocks) if blocks is not None else AnimaModularPipeline()
    classes = {"text_encoder": Qwen3Model, "text_conditioner": AnimaTextConditioner,
               "transformer": CosmosTransformer3DModel, "vae": AutoencoderKLQwenImage,
               "tokenizer": Qwen2Tokenizer, "t5_tokenizer": (T5Tokenizer if (root / "t5_tokenizer" / "spiece.model").is_file() else T5TokenizerFast),
               "scheduler": FlowMatchEulerDiscreteScheduler}
    components, reused = {}, []
    for name, cls in classes.items():
        previous = (reusable or {}).get(name)
        if (previous is not None and type(previous) is cls
                and (name not in tools("anima_memory").WEIGHTS or previous.dtype == dtype)):
            components[name] = previous
            reused.append(name)
            continue
        kwargs = {"local_files_only": True}
        if name in ("text_encoder", "tokenizer", "t5_tokenizer"):
            kwargs["trust_remote_code"] = False
        if name in tools("anima_memory").WEIGHTS:
            kwargs.update(use_safetensors=True, torch_dtype=dtype)
            components[name] = tools("resident_anima").load_weights(name, cls, str(root / name), **kwargs)
        else:
            components[name] = cls.from_pretrained(str(root / name), **kwargs)
    components["guider"] = ClassifierFreeGuidance(guidance_scale=cfg)
    pipeline.update_components(**components)
    tools("anima_memory").upload(pipeline, tools)
    tools("anima_acceleration").configure(pipeline.transformer)
    pipeline._huiyu_component_reuse = tuple(reused)
    pipeline.set_progress_bar_config(disable=True)
    return pipeline
