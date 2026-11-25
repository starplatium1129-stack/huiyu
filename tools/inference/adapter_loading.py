"""Weight-reading and pipeline loading helpers for native adapters."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import contextlib
import os
import sys
import threading
from types import SimpleNamespace
from huiyu_worker_lifecycle import load_sibling as sibling


contract = sibling("adapter_contract")
video = sibling("adapter_video")
identity = sibling("adapter_identity")


@contextlib.contextmanager
def windows_weight_reads():
    if sys.platform != "win32":
        yield
        return
    import safetensors
    import safetensors.torch
    from transformers import modeling_utils as encoder_loading
    # Diffusers imports safe_open inside its loading functions; changing the
    # public entry point covers those imports without inventing module aliases.
    readers = (safetensors, safetensors.torch, encoder_loading)
    originals = [(module, module.safe_open) for module in readers]
    reader_class = sibling("mapped_weights").ReadOnlyWeights
    async_loading = os.environ.get("HF_DEACTIVATE_ASYNC_LOAD")
    os.environ["HF_DEACTIVATE_ASYNC_LOAD"] = "1"

    def safe_open(*args, **kwargs):
        return reader_class(*args, **kwargs)

    # The pinned loader's writable mmap reserves Windows commit for whole files.
    # Use immutable file views during weight loading, then restore readers.
    for module, _ in originals:
        module.safe_open = safe_open
    try:
        yield
    finally:
        for module, reader in originals:
            module.safe_open = reader
        if async_loading is None:
            os.environ.pop("HF_DEACTIVATE_ASYNC_LOAD", None)
        else:
            os.environ["HF_DEACTIVATE_ASYNC_LOAD"] = async_loading


def resolve_moss_text_precision(root, data):
    if data["mossTextPrecision"] == "auto":
        variant = sibling("moss_int8").selected(root, "auto", contract, component="text_encoder", expected_model=data["modelId"])
        data["mossTextPrecision"] = "int8" if variant else "bf16"


def prepare_moss_start(root, data, resident, control, ready):
    # The lease and DLL imports stay on the owner thread. Preload the stdlib
    # helpers before starting the independent read of the protected bytes.
    sibling("moss_int8")
    sibling("native_hash")
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

        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="moss-verify") as pool:
            verification = pool.submit(identity.model_identity, path, data["modelId"], SimpleNamespace(check=check),
                moss_weight_precision=data["mossWeightPrecision"], moss_text_precision=data["mossTextPrecision"])
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
        resident.scope = resident.weight_scope(root, data, policy, None)
    else:
        import_pipeline()


def prepare_job(job, *, resident=None, control=None, ready=None):
    data, spec = contract.validate(job)
    if "mossUpscaleScale" in data:
        identity.runtime_dependencies()
    elif resident is not None and os.name == "nt" and spec["family"] == "moss-image":
        prepare_moss_start(contract.layout(job["modelDir"], spec), data, resident, control, ready)
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
        control.check()
        vae = AutoencoderKLQwenImage21.from_pretrained(str(root / "vae"),
            torch_dtype=torch.bfloat16, low_cpu_mem_usage=True, **weights)
        if manga:
            sibling("qwen_manga_vae").configure(vae)
        scheduler = scheduler_cls.from_pretrained(str(root / "scheduler"), local_files_only=True)
        return pipeline_cls(scheduler=scheduler, vae=vae, text_encoder=encoder, processor=processor.result(),
                                   transformer=transformer, sample_sigmas=spec.get("sampleSigmas"))


def load_adapter_pipeline(root, spec, data, policy, control, *, is_video, video_device, device_backend,
                          memory_pixels, conditioned, render_pixels):
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
            placement = sibling("mapped_residency").Residency(template.components, policy, memory_pixels,
                image_conditioned=conditioned, decode_pixels=render_pixels,
                retain_components=spec["family"] == "moss-image", stream_mapped_dit=spec["family"] == "qwen-image")
        control.check()
        return template, placement
    except BaseException:
        if placement is not None:
            placement.close()
        raise
