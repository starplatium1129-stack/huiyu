"""Weight-reading and pipeline loading helpers for native adapters."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from collections import defaultdict
import copy
import contextlib
import os
import threading
from types import SimpleNamespace
from pathlib import Path
from huiyu_worker_lifecycle import load_sibling as sibling


contract = sibling("adapter_contract")
video = sibling("adapter_video")
identity = sibling("adapter_identity")


def windows_weight_reads():
    return sibling("mapped_weights").windows_weight_reads()


def resolve_moss_text_precision(root, data):
    if data["mossTextPrecision"] == "auto":
        variant = sibling("moss_int8").selected(root, "auto", contract, component="text_encoder", expected_model=data["modelId"])
        data["mossTextPrecision"] = "int8" if variant else "bf16"


def style_selection(job):
    return tuple((Path(row["path"]), row.get("strength", 1.0)) for row in job.get("loras", ()))


def prepare_protected_start(root, data, spec, resident, control, ready, styles):
    # The lease and DLL imports stay on the owner thread. Preload the stdlib
    # helpers before starting the independent read of the protected bytes.
    sibling("native_hash")
    if spec.get("kreaInt8"):
        sibling("import_krea_int8")
    else:
        sibling("moss_int8")
        resolve_moss_text_precision(root, data)

    def import_pipeline():
        try:
            identity.dependencies(data["modelId"])
        finally:
            ready()

    def protected_identity(path):
        stop = threading.Event()

        def check():
            control.check()
            if stop.is_set():
                raise InterruptedError("Stopped model verification after an import failure")

        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="weight-verify") as pool:
            verification = pool.submit(identity.model_identity, path, data["modelId"], SimpleNamespace(check=check),
                moss_weight_precision=data.get("mossWeightPrecision", "auto"), moss_text_precision=data.get("mossTextPrecision"))
            try:
                import_pipeline()
                if not verification.done():
                    control.stage("fingerprint")
                return verification.result()
            finally:
                stop.set()

    # Without NTFS protection, leave both full reads to the normal loader.
    resident.lease.acquire(root, lambda _: None, prepared_identity=protected_identity)
    if resident.lease.cached:
        policy = os.environ.get("HUIYU_INFERENCE_MEMORY", "resident")
        resident.scope = resident.weight_scope(root, data, policy, styles)
    else:
        import_pipeline()


def prepare_moss_start(root, data, resident, control, ready):
    prepare_protected_start(root, data, contract.model(data["modelId"]), resident, control, ready, ())


def prepare_job(job, *, resident=None, control=None, ready=None):
    data, spec = contract.validate(job)
    if "mossUpscaleScale" in data:
        identity.runtime_dependencies()
    elif resident is not None and os.name == "nt" and spec["family"] == "moss-image":
        prepare_moss_start(contract.layout(job["modelDir"], spec), data, resident, control, ready)
    elif resident is not None and os.name == "nt" and spec.get("kreaInt8") and resident.components is None:
        prepare_protected_start(contract.layout(job["modelDir"], spec), data, spec, resident, control, ready, style_selection(job))
    else:
        identity.dependencies(data["modelId"])
    return data, spec


def load_qwen_pipeline(root, spec, control):
    import torch
    from diffusers import (AutoencoderKLQwenImage21, FlowMatchEulerDiscreteScheduler,
                           QwenImage21Pipeline, QwenImage21Transformer2DModel)
    from transformers import Qwen3VLForConditionalGeneration, Qwen3VLProcessor

    # layout() has checked the five fixed component classes and the model's
    # sigma grid. The processor reads tokenizer/config files only, so it can
    # overlap the sequential weight loaders without sharing their meta-init.
    weights = dict(local_files_only=True, use_safetensors=True)
    manga = sibling("qwen_manga_euler") if spec.get("packedManga") else None
    processor_cls = manga.MangaProcessor if manga else Qwen3VLProcessor
    scheduler_cls = manga.MangaEulerScheduler if manga else FlowMatchEulerDiscreteScheduler
    pipeline_cls = manga.MangaPipeline if manga else QwenImage21Pipeline
    with ThreadPoolExecutor(max_workers=1) as pool:
        processor = pool.submit(processor_cls.from_pretrained, str(root / "processor"),
                                local_files_only=True, trust_remote_code=False)
        control.check()
        if manga:
            encoder, transformer = sibling("qwen_manga_int8").load(root, control)
        else:
            encoder = Qwen3VLForConditionalGeneration.from_pretrained(str(root / "text_encoder"),
                dtype=torch.bfloat16, trust_remote_code=False, **weights)
            control.check()
            transformer = QwenImage21Transformer2DModel.from_pretrained(str(root / "transformer"),
                torch_dtype=torch.bfloat16, low_cpu_mem_usage=True, **weights)
            target_modulation = sibling("qwen_prefix_cache").use_target_modulation
            for block in transformer.transformer_blocks:
                block.register_forward_pre_hook(target_modulation, with_kwargs=True)
        sibling("qwen_prefix_cache").bind_target_forward(transformer, packed_manga=bool(manga))
        control.check()
        vae = AutoencoderKLQwenImage21.from_pretrained(str(root / "vae"),
            torch_dtype=torch.bfloat16, low_cpu_mem_usage=True, **weights)
        image_vae = sibling("qwen_manga_vae")
        image_vae.disable_video_cache(vae)
        if manga:
            image_vae.configure(vae)
        scheduler = scheduler_cls.from_pretrained(str(root / "scheduler"), local_files_only=True)
        return pipeline_cls(scheduler=scheduler, vae=vae, text_encoder=encoder, processor=processor.result(),
                                   transformer=transformer, sample_sigmas=spec.get("sampleSigmas"))


def load_krea_pipeline(root, spec, policy, control, identity, protection):
    import torch
    from accelerate import init_empty_weights
    from diffusers import AutoencoderKLQwenImage, FlowMatchEulerDiscreteScheduler, Krea2Pipeline, Krea2Transformer2DModel
    from transformers import AutoModel, Qwen2Tokenizer, Qwen2TokenizerFast, Qwen3VLConfig, Qwen3VLModel
    from transformers.models.qwen3_vl.modeling_qwen3_vl import Qwen3VLPreTrainedModel

    index = contract.config(root, root / "model_index.json")
    options = {key: index[key] for key in ("text_encoder_select_layers", "is_distilled", "patch_size") if key in index}
    transport = sibling("krea_transport")
    verified = policy == "offload" and protection is not None and identity["scope"] == "prepared-local-weights"
    weights = dict(torch_dtype=torch.bfloat16, use_safetensors=True, low_cpu_mem_usage=True, local_files_only=True)
    with ThreadPoolExecutor(max_workers=2) as pool:
        tokenizer_cls = {"Qwen2Tokenizer": Qwen2Tokenizer, "Qwen2TokenizerFast": Qwen2TokenizerFast}[index["tokenizer"][1]]
        tokenizer = pool.submit(tokenizer_cls.from_pretrained, str(root / "tokenizer"), local_files_only=True)
        scheduler = pool.submit(FlowMatchEulerDiscreteScheduler.from_pretrained, str(root / "scheduler"), local_files_only=True)
        control.check()
        config = Qwen3VLConfig.from_dict(contract.config(root, root / "text_encoder/config.json"))
        depth = config.text_config.num_hidden_layers
        taps = options.get("text_encoder_select_layers") or (2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35)
        text_config = copy.deepcopy(config.text_config)
        if min(taps) > 0 and max(taps) < depth:
            text_config.num_hidden_layers = max(taps)
        with init_empty_weights(include_buffers=False):
            # Same class/forward and text decoder as the pinned Qwen3VLModel.
            # Construct only its text side, including the real CPU RoPE buffers.
            encoder = Qwen3VLModel.__new__(Qwen3VLModel)
            Qwen3VLPreTrainedModel.__init__(encoder, config)
            encoder.visual = encoder.rope_deltas = None
            encoder.language_model = AutoModel.from_config(text_config, trust_remote_code=False)
            encoder.post_init()
        encoder.language_model.config.num_hidden_layers = depth
        if verified and transport.prepared(root, "text_encoder"):
            transport.load_packed(root, "text_encoder", encoder, control)
        else:
            # The image-only encoder never calls the vision tower. Even a
            # mixed shard exposes only requested language tensors to PyTorch.
            folder = root / "text_encoder"
            index_file = folder / "model.safetensors.index.json"
            names = list(encoder.state_dict())
            if index_file.is_file():
                mapping = contract.config(root, index_file)["weight_map"]
            else:
                single = contract.safe_file(root, folder / "model.safetensors")
                with sibling("mapped_weights").ReadOnlyWeights(single) as reader:
                    mapping = dict.fromkeys(reader.keys(), single.name)
            shards = defaultdict(list)
            for key in names:
                actual = key if key in mapping else "model." + key
                shards[mapping[actual]].append((key, actual))
            state = {}
            for shard, keys in shards.items():
                with sibling("mapped_weights").ReadOnlyWeights(contract.safe_file(root, folder / shard)) as reader:
                    for key, actual in keys:
                        control.check()
                        state[key] = reader.get_tensor(actual).to(torch.bfloat16)
            encoder.load_state_dict(state, strict=True, assign=True)
            del state
        control.check()
        if spec.get("kreaInt8") or (verified and transport.prepared(root)):
            with init_empty_weights(include_buffers=False):
                transformer = Krea2Transformer2DModel.from_config(contract.config(root, root / "transformer/config.json"))
            if spec.get("kreaInt8"):
                sibling("krea_int8").load(root, transformer, policy, control)
            else:
                transport.load_packed(root, "transformer", transformer, control)
        else:
            transformer = Krea2Transformer2DModel.from_pretrained(str(root / "transformer"), **weights)
        control.check()
        vae = AutoencoderKLQwenImage.from_pretrained(str(root / "vae"), **weights)
        return Krea2Pipeline(tokenizer=tokenizer.result(), scheduler=scheduler.result(), text_encoder=encoder.eval(),
                             transformer=transformer.eval(), vae=vae, **options)


def load_adapter_pipeline(root, spec, data, policy, control, *, is_video, video_device, device_backend,
                          memory_pixels, conditioned, render_pixels, model_identity, protection):
    import torch
    import diffusers

    kwargs = {"local_files_only": True, "use_safetensors": True, "torch_dtype": torch.bfloat16,
              "low_cpu_mem_usage": True}
    placement = None
    try:
        if spec["family"] == "moss-image":
            with windows_weight_reads():
                template = sibling("moss_adapter").load(root, control, contract, data["modelId"],
                    text_precision=data["mossTextPrecision"], weight_precision=data["mossWeightPrecision"])
            if policy == "offload":
                sibling("native_memory").keep_token_table_on_cpu(template.text_encoder.language_model)
            else:
                if getattr(template.transformer, "_huiyu_int8_count", 0):
                    sibling("moss_int8").place_resident(template.transformer)
                else:
                    template.transformer.to(device="cuda:0", dtype=torch.bfloat16)
        elif is_video:
            with windows_weight_reads():
                template = video.load(root, spec, data, control, contract)
            control.stage("uploading")
            placement = video.placement(template.components, policy, data, spec, video_device, device_backend)
        else:
            with windows_weight_reads() if spec["family"] in ("qwen-image", "krea2") else contextlib.nullcontext():
                if spec["family"] == "qwen-image":
                    template = load_qwen_pipeline(root, spec, control)
                elif spec["family"] == "krea2":
                    template = load_krea_pipeline(root, spec, policy, control, model_identity, protection)
                else:
                    template = getattr(diffusers, spec["pipeline"]).from_pretrained(str(root), **kwargs)
            if spec["family"] == "krea2":
                sibling("krea_adapter").configure(template, policy)
            if spec["family"] == "qwen-image":
                encoder = template.text_encoder
                encoder.set_attn_implementation("sdpa")
                # This pipeline consumes only the final hidden state. Like
                # Comfy's conditioning encoder, skip vocabulary logits,
                # unused LM-head weights, KV cache and all intermediate states.
                # Its task-local final-norm hook still selects pre-norm output.
                encoder.lm_head = torch.nn.Identity()
                if policy == "offload":
                    sibling("native_memory").keep_token_table_on_cpu(encoder.model.language_model)
                def hidden_only(*args, **values):
                    values.update(output_hidden_states=False, use_cache=False)
                    mask = values.get("attention_mask")
                    if mask is not None and bool(mask.all()):
                        values["attention_mask"] = None
                    output = encoder.model(*args, **values)
                    return SimpleNamespace(hidden_states=(output.last_hidden_state,))
                encoder.forward = hidden_only
        if spec["family"] in ("qwen-image", "moss-image") and policy == "offload":
            mapped = sibling("mapped_residency")
            qwen = spec["family"] == "qwen-image" and not spec.get("packedManga")
            owner = mapped.QwenResidency if qwen else mapped.Residency
            placement = owner(template.components, policy, memory_pixels,
                image_conditioned=conditioned, decode_pixels=render_pixels,
                retain_components=spec["family"] == "moss-image", stream_text=qwen,
                stream_mapped_dit=spec["family"] == "qwen-image")
        control.check()
        return template, placement
    except BaseException:
        if placement is not None:
            placement.close()
        raise
