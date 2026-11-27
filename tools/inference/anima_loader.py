"""Strict local component loading, with byte-identified unadapted reuse."""
import hashlib
import json
import time


QWEN_EXPORTS = {
    11423189: "45dbe18236d2648841f2da3a36e67d6958e980405aece18d7fe16542eb6d9483",
    11422924: "476870a1f2fb6f6a2759a6ede2383bf9d5d738f17844563b65c91965b722ae09",
}
QWEN_CONFIG_SHA256 = "b0af17a39a4e6b6bc7d4523534668cbb8ffa2669ace1f1d7a3dd47c640411602"


def _qwen_options(folder):
    # Transformers 5.10.1 first parses the full export just for added tokens,
    # then parses it again for Qwen's BPE. These shipped headers contain the
    # complete list; keep the official loader for model and wrapper settings.
    path = folder / "tokenizer.json"
    if not path.is_file() or (folder / "added_tokens.json").exists() or (folder / "special_tokens_map.json").exists():
        return {}
    expected = QWEN_EXPORTS.get(path.stat().st_size)
    if expected is None or hashlib.sha256((folder / "tokenizer_config.json").read_bytes()).hexdigest() != QWEN_CONFIG_SHA256:
        return {}
    with path.open("rb") as stream:
        source = stream.read(max(QWEN_EXPORTS) + 1)
    if hashlib.sha256(source).hexdigest() != expected:
        return {}
    end = source.index(b',\n  "normalizer":')
    header = json.loads(source[:end] + b"}")
    decoder = {}
    for token in header["added_tokens"]:
        index = token.pop("id")
        decoder[index] = token
    return {"added_tokens_decoder": decoder}


def load(root, cfg, blocks, reusable, tools, device, stage=None):
    from diffusers import AnimaModularPipeline, AnimaTextConditioner, AutoencoderKLQwenImage, CosmosTransformer3DModel, FlowMatchEulerDiscreteScheduler, ClassifierFreeGuidance
    from transformers import Qwen3Model, Qwen2Tokenizer, T5Tokenizer, T5TokenizerFast
    dtype = device.dtype
    pipeline = AnimaModularPipeline(blocks=blocks) if blocks is not None else AnimaModularPipeline()
    classes = {"text_encoder": Qwen3Model, "text_conditioner": AnimaTextConditioner,
               "transformer": CosmosTransformer3DModel, "vae": AutoencoderKLQwenImage,
               "tokenizer": Qwen2Tokenizer, "t5_tokenizer": (T5Tokenizer if (root / "t5_tokenizer" / "spiece.model").is_file() else T5TokenizerFast),
               "scheduler": FlowMatchEulerDiscreteScheduler}
    components, reused, loading = {}, [], []
    memory = tools("anima_memory")
    memory.validate()
    for name, cls in classes.items():
        if stage is not None:
            stage("loading", component=name)
        previous = (reusable or {}).get(name)
        if (previous is not None and type(previous) is cls
                and (name not in tools("anima_memory").WEIGHTS or previous.dtype == dtype)):
            components[name] = previous
            reused.append(name)
            continue
        kwargs = {"local_files_only": True}
        if name in ("text_encoder", "tokenizer", "t5_tokenizer"):
            kwargs["trust_remote_code"] = False
        if name == "tokenizer":
            kwargs.update(_qwen_options(root / name))
        if name in memory.WEIGHTS:
            kwargs.update(use_safetensors=True, torch_dtype=dtype, low_cpu_mem_usage=True)
            started = time.perf_counter()
            # Offloaded CPU components can be mutated by PEFT or outlive the
            # checkpoint lease. Private tensors keep the file view immutable.
            with tools("mapped_weights").windows_weight_reads(private_tensors=device.memory_policy == "offload"):
                components[name] = tools("resident_anima").load_weights(name, cls, str(root / name), **kwargs)
            read_wall = time.perf_counter() - started
            started = time.perf_counter()
            if stage is not None:
                stage("uploading", component=name)
            upload = memory.upload_component(name, components[name], tools, device)
            loading.append(dict(name=name, readWallSeconds=read_wall,
                uploadWallSeconds=time.perf_counter() - started, upload=upload))
        else:
            components[name] = cls.from_pretrained(str(root / name), **kwargs)
    components["guider"] = ClassifierFreeGuidance(guidance_scale=cfg)
    pipeline.update_components(**components)
    # Prompt encoding never consumes KV state; avoid constructing/discarding it.
    pipeline.text_encoder.config.use_cache = False
    execution = tools("anima_execution").Execution(pipeline.transformer)
    pipeline.transformer._huiyu_execution = execution
    tools("anima_acceleration").configure(pipeline.transformer, execution, tools, device)
    pipeline._huiyu_component_reuse = tuple(reused)
    pipeline._huiyu_loading = dict(strategy="component-sequential-v1", components=loading)
    pipeline.set_progress_bar_config(disable=True)
    return pipeline
