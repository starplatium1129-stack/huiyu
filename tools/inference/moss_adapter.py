"""MIAOKA MOSS FP16 checkpoint + pinned OpenMOSS components; local code only.

Architecture: OpenMOSS-Team/MOSS-Image-Base@85975793d8b3d432f1b6e27f352abaa4c2a4c0d3.
Never load model-directory Python or apply Anima LoRA/TeaCache recipes.
"""
from huiyu_worker_lifecycle import load_sibling


def pipeline_class():
    return load_sibling("moss_pipeline").MOSSImagePipeline


def load(root, control, contract):
    import torch
    from accelerate import init_empty_weights
    from diffusers import AutoencoderKLFlux2
    from safetensors.torch import load_file
    from transformers import Qwen3_5Model, Qwen2TokenizerFast
    module = load_sibling("moss_pipeline")
    control.stage("loading", component="transformer")
    checkpoint = contract.safe_file(root, root / "transformer/diffusion_pytorch_model.safetensors")
    weights = load_file(str(checkpoint), device="cpu")
    control.check()
    if not weights or any(value.dtype not in (torch.float16, torch.bfloat16, torch.float32) for value in weights.values()):
        raise contract.AdapterError("UNSUPPORTED_MODEL", "MOSS requires the author's FP16 checkpoint; INT8/ConvRot weights need a different loader")
    # Only whole-file namespaces are accepted. Strict assignment rejects missing,
    # unexpected and wrong-shape tensors; no guessed remaps or silently dropped keys.
    for prefix in ("model.diffusion_model.", "diffusion_model.", "net."):
        if all(key.startswith(prefix) for key in weights):
            weights = {key[len(prefix):]: value for key, value in weights.items()}
            break
    config = contract.config(root, root / "transformer/config.json")
    with init_empty_weights():
        transformer = module.MOSSImageTransformer.from_config(config)
    transformer.load_state_dict(weights, strict=True, assign=True)
    del weights
    transformer = transformer.to(dtype=torch.bfloat16).eval()
    control.check()
    control.stage("loading", component="text_encoder")
    encoder = Qwen3_5Model.from_pretrained(str(root / "text_encoder"), local_files_only=True,
        trust_remote_code=False, use_safetensors=True, dtype=torch.bfloat16).eval()
    tokenizer = Qwen2TokenizerFast.from_pretrained(str(root / "tokenizer"), local_files_only=True, trust_remote_code=False)
    control.check()
    control.stage("loading", component="vae")
    vae = AutoencoderKLFlux2.from_pretrained(str(root / "vae"), local_files_only=True,
        use_safetensors=True, torch_dtype=torch.float32).eval()
    scheduler = module.MOSSImageScheduler.from_config(contract.config(root, root / "scheduler/scheduler_config.json"), shift=5.0)
    return module.MOSSImagePipeline(transformer=transformer, scheduler=scheduler,
        text_encoder=encoder, tokenizer=tokenizer, vae=vae)


def generate(pipeline, data, control, observation):
    import torch
    observer = load_sibling("adapter_video").observe_scheduler
    # The upstream MOSS pipeline exposes scheduler.step rather than callbacks.
    # Observe the fresh task-local solver so cancellation/progress remain real.
    control.stage("encoding")
    for name, text in (("正向", data["prompt"]), ("负向", data["negativePrompt"])):
        control.check()
        formatted = pipeline.tokenizer.apply_chat_template([{"role": "user", "content": text}],
            tokenize=False, add_generation_prompt=True, enable_thinking=True)
        if len(pipeline.tokenizer(formatted, truncation=False)["input_ids"]) > 4096:
            raise load_sibling("adapter_contract").AdapterError("PROMPT_TOO_LONG", f"MOSS {name}提示词超过 4096 tokens，请精简内容；未截断提交")
    cache = (load_sibling("moss_spectrum").SpectrumCache(control, pipeline.scheduler, 2 if data["cfg"] != 1 else 1)
             if data["mossAcceleration"] == "spectrum" else None)
    pipeline.transformer._huiyu_spectrum = cache
    try:
        with observer(pipeline.scheduler, control), torch.inference_mode():
            return pipeline(prompt=data["prompt"], negative_prompt=data["negativePrompt"],
                width=data["width"], height=data["height"], num_inference_steps=data["steps"],
                guidance_scale=data["cfg"], uncond_skip_layers=[22], output_type="np",
                generator=torch.Generator("cpu").manual_seed(data["seed"]))
    finally:
        pipeline.transformer._huiyu_spectrum = None
        if cache is not None:
            observation["mossAcceleration"] = dict(cache.stats,
                effective="spectrum" if cache.stats["forecastForwards"] else "full-compute")
            cache.clear()
        else:
            observation["mossAcceleration"] = {"algorithm": "off", "requested": False}
