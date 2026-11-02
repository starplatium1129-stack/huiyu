"""MIAOKA MOSS FP16/registered INT8 checkpoint + pinned OpenMOSS components.

Architecture: OpenMOSS-Team/MOSS-Image-Base@85975793d8b3d432f1b6e27f352abaa4c2a4c0d3.
Never load model-directory Python or apply Anima LoRA/TeaCache recipes.
"""
from huiyu_worker_lifecycle import load_sibling
import re
import sys


def pipeline_class():
    return load_sibling("moss_pipeline").MOSSImagePipeline


def load(root, control, contract, *, text_precision="bf16", weight_precision="auto"):
    import torch
    from accelerate import init_empty_weights
    from diffusers import AutoencoderKLFlux2
    from safetensors.torch import load_file
    from transformers import Qwen3_5Model, Qwen2TokenizerFast
    module = load_sibling("moss_pipeline")
    quant = load_sibling("moss_int8")
    variant = quant.selected(root, weight_precision, contract)
    if variant is not None:
        quant.require_backend(contract)
    control.stage("loading", component="text_encoder")
    text = load_sibling("moss_text")
    encoder = (text.load_int8(root, control, contract) if text_precision == "int8" else
        Qwen3_5Model.from_pretrained(str(root / "text_encoder"), local_files_only=True,
            trust_remote_code=False, use_safetensors=True, dtype=torch.bfloat16).eval())
    text.bind_fast_convolution(encoder)
    if text_precision == "fp8":
        from diffusers.hooks import apply_layerwise_casting
        # Text-only MOSS never runs the vision tower. Preserve embeddings,
        # normalization, DeltaNet gates/convolution and the final decoder layer;
        # only Linear weights use FP8 storage with BF16 computation. Original
        # checkpoint views remain protected and are never written or exported.
        last = encoder.config.text_config.num_hidden_layers - 1
        skip = ("embed_tokens", "norm", "visual", "conv1d", "in_proj_a", "in_proj_b",
                rf"language_model\.layers\.{last}(\.|$)")
        for name, layer in encoder.named_modules():
            control.check()
            if isinstance(layer, torch.nn.Linear) and not any(re.search(pattern, name) for pattern in skip):
                apply_layerwise_casting(layer, storage_dtype=torch.float8_e4m3fn,
                    compute_dtype=torch.bfloat16, skip_modules_pattern=None)
    tokenizer = Qwen2TokenizerFast.from_pretrained(str(root / "tokenizer"), local_files_only=True, trust_remote_code=False)
    control.check()
    control.stage("loading", component="transformer")
    checkpoint = contract.safe_file(root, root / (variant["path"] if variant else "transformer/diffusion_pytorch_model.safetensors"))
    weights = load_file(str(checkpoint), device="cpu", backend="pread" if sys.platform == "win32" else "mmap")
    control.check()
    types = (torch.float16, torch.bfloat16, torch.float32, torch.int8, torch.uint8) if variant else (
        torch.float16, torch.bfloat16, torch.float32)
    if not weights or any(value.dtype not in types for value in weights.values()):
        raise contract.AdapterError("UNSUPPORTED_MODEL", "MOSS requires the selected author's FP16 file or registered INT8 ConvRot file")
    # Only whole-file namespaces are accepted. Strict assignment rejects missing,
    # unexpected and wrong-shape tensors; no guessed remaps or silently dropped keys.
    for prefix in ("model.diffusion_model.", "diffusion_model.", "net."):
        if all(key.startswith(prefix) for key in weights):
            weights = {key[len(prefix):]: value for key, value in weights.items()}
            break
    config = contract.config(root, root / "transformer/config.json")
    # Preserve the author's fused DiT QKV: one projection instead of three
    # GEMMs, without concatenating or copying a second checkpoint in host RAM.
    dim, depth = config.get("dim", 3072), config.get("num_layers", 42)
    fused_layers = []
    for key in list(weights):
        match = re.fullmatch(r"layers\.(\d+)\.proj\.qkv\.weight", key)
        if match is None:
            continue
        tensor = weights[key]
        names = [f"layers.{match[1]}.proj.{part}.weight" for part in ("q", "k", "v")]
        if int(match[1]) >= depth or tuple(tensor.shape) != (3 * dim, dim) or any(name in weights for name in names):
            raise contract.AdapterError("UNSUPPORTED_MODEL", f"Invalid or ambiguous MOSS fused QKV tensor: {key}")
        fused_layers.append(int(match[1]))
    with init_empty_weights():
        transformer = module.MOSSImageTransformer.from_config(config)
        for index in fused_layers:
            projections = transformer.layers[index].proj
            projections["qkv"] = torch.nn.Linear(dim, 3 * dim, bias=False)
            for part in ("q", "k", "v"):
                del projections[part]
        if variant is not None:
            quant.configure(transformer, weights, contract, variant)
    transformer.load_state_dict(weights, strict=True, assign=True)
    del weights
    # Preserve the original FP16 file views on CPU. Placement converts on GPU,
    # instead of allocating a second full BF16 checkpoint in host RAM.
    transformer.eval()
    transformer._huiyu_compiler = load_sibling("moss_execution").Compiler(transformer, encoder)
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
    cache = (load_sibling("moss_spectrum").SpectrumCache(control, pipeline.scheduler,
                2 if data["cfg"] != 1 else 1, data["mossSpectrumFlexWindow"])
             if data["mossAcceleration"] == "spectrum" else None)
    pipeline.transformer._huiyu_spectrum = cache
    execution = load_sibling("moss_execution").Execution(control)
    compiler = pipeline.transformer._huiyu_compiler
    compiler.begin(control, data["mossCompile"], pipeline._huiyu_memory)
    pipeline.transformer._huiyu_execution = execution
    try:
        with observer(pipeline.scheduler, control), torch.inference_mode():
            return pipeline(prompt=data["prompt"], negative_prompt=data["negativePrompt"],
                width=data["width"], height=data["height"], num_inference_steps=data["steps"],
                guidance_scale=data["cfg"], uncond_skip_layers=[22], output_type="np",
                generator=torch.Generator("cpu").manual_seed(data["seed"]))
    finally:
        pipeline.transformer._huiyu_execution = None
        observation["mossExecution"] = execution.finish()
        observation["mossExecution"]["textPrecision"] = data["mossTextPrecision"]
        count = getattr(pipeline.transformer, "_huiyu_int8_count", 0)
        observation["mossExecution"].update(weightPrecision="int8-convrot" if count else "fp16", quantizedLinearCount=count)
        observation["mossExecution"]["compile"] = compiler.finish()
        pipeline.transformer._huiyu_spectrum = None
        if cache is not None:
            observation["mossAcceleration"] = dict(cache.stats,
                effective="spectrum" if cache.stats["forecastForwards"] else "full-compute")
            cache.clear()
        else:
            observation["mossAcceleration"] = {"algorithm": "off", "requested": False}
