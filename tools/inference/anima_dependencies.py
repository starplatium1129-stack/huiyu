"""Pinned imports: generation loads core classes, explicit diagnostics check all.

Optional mask/adapter libraries retain their version checks and import at their
actual use boundary. A cold plain drawing job need not preload CLIPSeg classes.
"""
import importlib.metadata

PINS = {"torch": "2.8.0", "torchvision": "0.23.0", "diffusers": "0.41.0", "transformers": "5.10.1",
        "accelerate": "1.12.0", "safetensors": "0.8.0", "Pillow": "11.3.0",
        "peft": "0.19.0", "sentencepiece": "0.2.1", "protobuf": "6.33.5",
        "huggingface-hub": "1.32.0"}


def check(tools, error, *, full):
    for name in ("masked_anima", "clipseg_mask", "teacache_anima", "anima_cache", "worker_lifecycle",
                 "anima_local_cache", "teacache_profile", "resident_anima", "anima_text_cache",
                 "inference_metrics", "anima_execution", "anima_lora", "anima_lora_fusion", "anima_sampling",
                 "anima_refinement", "anima_vae", "anima_tiling", "anima_postprocess", "anima_prompt_weights",
                 "anima_upscale", "native_hash", "native_upload", "anima_loader", "locked_identity"):
        tools(name)
    tools("anima_memory").validate()
    if tools("anima_acceleration").validate() != "native":
        tools("worker_lifecycle").load_sibling("anima_fused")
    versions = {}
    for name, expected in PINS.items():
        try:
            version = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError as exc:
            raise error("DEPENDENCY_MISSING", f"Missing {name}; prepare the dedicated environment with requirements.txt") from exc
        if version.split("+")[0] != expected:
            raise error("DEPENDENCY_VERSION", f"{name}=={expected} required; found {version}")
        versions[name] = version
    try:
        import torch
        from diffusers import AnimaModularPipeline, AnimaTextConditioner, AutoencoderKLQwenImage, CosmosTransformer3DModel, FlowMatchEulerDiscreteScheduler, ClassifierFreeGuidance
        from transformers import Qwen3Model, Qwen2Tokenizer, T5Tokenizer, T5TokenizerFast
        from PIL import Image, ImageOps
        from safetensors import safe_open
        if full:
            from torchvision.transforms.functional import resize
            from transformers import CLIPSegForImageSegmentation, CLIPTokenizer, ViTImageProcessorPil
            from peft import LoraConfig, get_peft_model_state_dict
    except Exception as exc:
        raise error("DEPENDENCY_IMPORT", f"Inference dependency import failed: {exc}") from exc
    return versions
