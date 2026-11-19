"""Offline, single-person speech-to-video with the fixed LongCat 1.6 pipeline."""
from contextlib import ExitStack
from functools import lru_cache
import hashlib
import importlib.metadata
import json
import math
import os
from pathlib import Path
import sys
import tempfile
from types import ModuleType

from huiyu_worker_lifecycle import WorkerError, load_sibling


@lru_cache(maxsize=1)
def _source_package():
    # The checkout has no installable distribution. Only import a private copy
    # of the verified Python sources; the checkout itself never enters sys.path.
    default = Path(sys.prefix) / "upstream" / "LongCat-Video"
    source = Path(os.environ.get("HUIYU_LONGCAT_SOURCE", default)) / "longcat_video"
    paths = sorted(source.rglob("*.py"), key=lambda path: path.relative_to(source).as_posix())
    if len(paths) != 27:
        raise WorkerError("DEPENDENCY_MISSING", f"请准备指定版本的 LongCat-Video 源码，未找到完整源码包：{source}")
    digest = hashlib.sha256()
    snapshot = tempfile.TemporaryDirectory(prefix="huiyu-longcat-source-")
    try:
        root = Path(snapshot.name)
        for path in paths:
            if path.stat().st_size > 2 * 1024**2:
                raise WorkerError("DEPENDENCY_VERSION", "LongCat 源码文件大小与指定版本不符")
            relative = path.relative_to(source)
            content = path.read_bytes().replace(b"\r\n", b"\n")
            digest.update(relative.as_posix().encode() + b"\0" + hashlib.sha256(content).digest())
            dest = root / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(content)
        if digest.hexdigest() != "702482a064a4f4ead19f696a026018b9327014d83b8da3bc4f8504c963342db1":
            raise WorkerError("DEPENDENCY_VERSION", "LongCat 源码与绘遇支持的固定版本不符，请核对 checkout")
        if any(name == "longcat_video" or name.startswith("longcat_video.") for name in sys.modules):
            raise WorkerError("DEPENDENCY_VERSION", "LongCat 专用环境已加载另一份模型实现，请检查环境")
        package = ModuleType("longcat_video")
        package.__path__ = [str(root)]
        sys.modules[package.__name__] = package
        return snapshot
    except BaseException:
        snapshot.cleanup()
        raise


def validate_runtime(spec):
    versions = {}
    for name, pin in (("torch", "2.6.0"), ("torchvision", "0.21.0"), ("diffusers", "0.35.1"),
                      ("transformers", "4.41.0"), ("flash-attn", "2.7.4.post1")):
        try:
            version = importlib.metadata.version(name)
        except importlib.metadata.PackageNotFoundError as exc:
            raise WorkerError("DEPENDENCY_MISSING", f"LongCat 专用环境缺少 {name}=={pin}") from exc
        if version.split("+")[0] != pin:
            raise WorkerError("DEPENDENCY_VERSION", f"LongCat 需要 {name}=={pin}，当前为 {version}")
        versions[name] = version
    import torch
    if not torch.version.cuda or not torch.cuda.is_available() or not torch.cuda.is_bf16_supported(including_emulation=False):
        raise WorkerError("DEVICE_UNAVAILABLE", "LongCat Avatar 1.6 的固定实现需要支持 BF16 和 FlashAttention 2 的 NVIDIA 显卡")
    _source_package()
    from longcat_video.pipeline_longcat_video_avatar import LongCatVideoAvatarPipeline
    from flash_attn import flash_attn_func, flash_attn_varlen_func
    return versions


def _weight_identity(root, spec, control, *, protected):
    contract = load_sibling("adapter_contract")
    catalogs = contract.document(Path(__file__).with_name("managed-adapter-models.json"))
    bundle = next(entry for entry in catalogs["models"] if entry["id"] == "longcat-avatar-1.6")
    receipt = root / "huiyu-model.json"
    prepared_at = 0
    if protected and receipt.is_file():
        record = contract.config(root, receipt)
        if (record.get("modelId") == bundle["id"] and record.get("revision") == spec["revision"]
                and record.get("scope") == "downloaded-files-sha256" and record.get("schemaVersion") == 1):
            prepared_at = receipt.stat().st_mtime_ns
    # A monolithic weight file would take priority over the verified shard index.
    for alternate in ("base_model/diffusion_pytorch_model.safetensors", "text_encoder/model.safetensors", "tokenizer/added_tokens.json",
                      "whisper-large-v3/adapter_config.json", "text_encoder/adapter_config.json"):
        if os.path.lexists(root / alternate):
            raise WorkerError("MODEL_INVALID", f"模型目录中存在会覆盖固定组件的文件：{alternate}")
    for entry in bundle["files"]:
        control.check()
        path = contract.safe_file(root, root / entry["path"])
        stat = path.stat()
        if stat.st_size != entry["bytes"]:
            raise WorkerError("MODEL_INCOMPLETE", f"LongCat 文件大小不符：{entry['path']}")
        if path.suffix == ".safetensors" and prepared_at and stat.st_mtime_ns <= prepared_at:
            continue
        digest = hashlib.sha256()
        with path.open("rb") as stream:
            while chunk := stream.read(8 * 1024**2):
                control.check()
                digest.update(chunk)
        if digest.hexdigest() != entry["sha256"]:
            raise WorkerError("MODEL_INVALID", f"LongCat 文件摘要不符：{entry['path']}")
    return hashlib.sha256(json.dumps(bundle, sort_keys=True).encode()).hexdigest()


def _speech(path, frames, fps):
    import numpy as np
    import soundfile as sf
    import torch
    from scipy.signal import resample_poly

    with sf.SoundFile(path) as stream:
        rate = stream.samplerate
        if (stream.format not in ("WAV", "WAVEX") or stream.subtype not in ("PCM_U8", "PCM_16", "PCM_24", "PCM_32")
                or not 8000 <= rate <= 192000 or stream.channels not in (1, 2) or stream.frames < 1):
            raise WorkerError("INVALID_INPUT_AUDIO", "请提供单声道或双声道 PCM WAV 配音")
        samples = stream.read(math.ceil(frames * rate / fps), dtype="float32", always_2d=True)
    def resample(values, target_rate):
        divisor = math.gcd(rate, target_rate)
        output = resample_poly(values, target_rate // divisor, rate // divisor, axis=0)
        count = round(frames * target_rate / fps)
        if len(output) < count:
            output = np.pad(output, ((0, count - len(output)), (0, 0)))
        return output[:count]

    # Whisper expects mono at 16 kHz; retain the speaker's original channels
    # in the final soundtrack. The official recipe gives Whisper one second of
    # silence at the tail so the last frame has a complete feature window.
    mono = resample(samples.mean(axis=1, keepdims=True), 16000)[:, 0]
    speech = np.pad(mono, (0, 16000))
    soundtrack = torch.from_numpy(resample(samples, 48000).T.copy())
    return speech, soundtrack


def _place_dit(dit, target):
    dit.to(target)
    # LongCat's mixed LoRA network is kept in an ordinary dict outside the
    # transformer's registered torch modules.
    for network in dit.lora_dict.values():
        for layer in network.loras:
            layer.to(target)


def _render(root, data, control, media, job, offload):
    import torch
    import flash_attn
    from PIL import ImageOps
    from transformers import T5TokenizerFast, UMT5EncoderModel, WhisperFeatureExtractor, WhisperModel
    from longcat_video.modules.autoencoder_kl_wan import AutoencoderKLWan
    from longcat_video.modules.avatar.longcat_video_dit_avatar import LongCatVideoAvatarTransformer3DModel
    from longcat_video.modules.scheduling_flow_match_euler_discrete import FlowMatchEulerDiscreteScheduler
    from longcat_video.pipeline_longcat_video_avatar import LongCatVideoAvatarPipeline

    speech, soundtrack = _speech(job["drivingAudioPath"], data["frames"], data["fps"])
    with media.input_image(job["inputImagePath"], WorkerError) as frame:
        width, height = data["width"], data["height"]
        # The official 480p aspect buckets omit a square canvas. Render its
        # nearest landscape bucket then take a centered 608x608 crop.
        inner_width = 640 if width == height else width
        image = ImageOps.fit(frame.convert("RGB"), (inner_width, height))
    target = torch.device("cuda", torch.cuda.current_device())
    weights = dict(torch_dtype=torch.bfloat16, use_safetensors=True, local_files_only=True)
    def component(cls, folder, **options):
        control.stage("loading", component="processor" if folder == "whisper-large-v3" else folder)
        return cls.from_pretrained(str(root / folder), local_files_only=True, **options)

    # Explicit classes and safetensors keep model data separate from code.
    tokenizer = component(T5TokenizerFast, "tokenizer")
    text_encoder = component(UMT5EncoderModel, "text_encoder", torch_dtype=torch.bfloat16, use_safetensors=True)
    vae = component(AutoencoderKLWan, "vae", torch_dtype=torch.bfloat16, use_safetensors=True)
    scheduler = component(FlowMatchEulerDiscreteScheduler, "scheduler")
    control.stage("loading", component="transformer")
    dit = LongCatVideoAvatarTransformer3DModel.from_pretrained(str(root / "base_model"), cp_split_hw=[1, 1], **weights)
    for folder, name in (("loraA", "dmd"), ("loraB", "opsd")):
        control.stage("adapters")
        dit.load_lora(str(root / folder / "lora.safetensors"), name, multiplier=1.0, lora_network_dim=128, lora_network_alpha=64)
    dit.enable_lora_mix("dmd", "opsd", 1.0, 4)
    whisper = component(WhisperModel, "whisper-large-v3", use_safetensors=True).eval().to(target)
    extractor = component(WhisperFeatureExtractor, "whisper-large-v3")
    # Avatar 1.6 uses the upstream 1.5 architecture switch and the 1.6 LoRAs.
    pipe = LongCatVideoAvatarPipeline(tokenizer, text_encoder, vae, scheduler, dit, whisper, extractor, model_type="avatar-v1.5")
    pipe.device = target
    control.stage("encoding")
    audio = pipe.get_audio_embedding(speech, fps=25, device=target, sample_rate=16000,
                                     model_type="avatar-v1.5", use_loudness_norm=False)
    pipe.audio_encoder = None
    del whisper
    if not torch.isfinite(audio).all():
        raise WorkerError("INVALID_MODEL_OUTPUT", "Whisper 返回无效配音特征")
    # VAE time compression requires 4n+1 frames. Trim only after decoding.
    count = 1 + 4 * math.ceil((data["frames"] - 1) / 4)
    indices = torch.arange(count)[:, None] + torch.arange(-2, 3)
    audio = audio[indices.clamp(0, audio.shape[0] - 1)].unsqueeze(0)
    if not offload:
        pipe.to(target)
    calls = dict(sdpa=0, slicedSdpa=0, flash2=0, sage=0)
    with ExitStack() as hooks:
        if offload:
            # These two pipeline stages finish before the first denoising step.
            def place_stage(method, module):
                original = getattr(pipe, method)
                def run(*args, **kwargs):
                    control.check()
                    module.to(target)
                    try:
                        return original(*args, **kwargs)
                    finally:
                        module.to("cpu")
                setattr(pipe, method, run)
                hooks.callback(delattr, pipe, method)
            place_stage("encode_prompt", text_encoder)
            place_stage("prepare_latents", vae)
        completed = 0
        def before_step(_module, _inputs):
            control.check()
            if not completed:
                control.stage("sampling")
                if offload:
                    _place_dit(dit, target)
        def after_step(_module, _inputs, _output):
            nonlocal completed
            completed += 1
            control.progress(completed, data["steps"])
        hooks.callback(dit.register_forward_pre_hook(before_step).remove)
        hooks.callback(dit.register_forward_hook(after_step).remove)
        def counted(kernel):
            def invoke(*args, **kwargs):
                result = kernel(*args, **kwargs)
                calls["flash2"] += 1
                return result
            return invoke
        for name in ("flash_attn_func", "flash_attn_varlen_func"):
            kernel = getattr(flash_attn, name)
            setattr(flash_attn, name, counted(kernel))
            hooks.callback(setattr, flash_attn, name, kernel)
        latents = pipe.generate_ai2v(image=image, prompt=data["prompt"], resolution="480p", num_frames=count,
            num_inference_steps=data["steps"], use_distill=True, text_guidance_scale=1., audio_guidance_scale=1.,
            generator=torch.Generator(device=target).manual_seed(data["seed"]), audio_emb=audio, output_type="latent")
    control.stage("decoding")
    if offload:
        _place_dit(dit, "cpu")
        vae.to(target)
    decoded = pipe._decode_video_latents(pipe.denormalize_latents(latents.to(vae.dtype)))
    frames = pipe.video_processor.postprocess_video(decoded, output_type="np")[0][:data["frames"]]
    left = (inner_width - width) // 2
    return frames[:, :, left:left + width, :], soundtrack, calls


def generate(job, data, spec, control):
    import torch
    media = load_sibling("adapter_media")
    root = Path(job["modelDir"]).resolve()
    if (not job.get("inputImagePath") or not job.get("drivingAudioPath") or job.get("lastFramePath")
            or data["steps"] != 8 or data["cfg"] != 1 or data["videoAttention"] not in spec["attentionModes"]):
        raise WorkerError("INVALID_PARAMETER", "LongCat Avatar 1.6 需要首帧、配音和官方 8 步 FlashAttention 2 配方")
    policy = os.environ.get("HUIYU_INFERENCE_MEMORY", "offload")
    if policy not in ("resident", "offload"):
        raise WorkerError("INVALID_MEMORY_POLICY", "LongCat 支持显卡常驻或分阶段卸载")
    media.encoder(WorkerError)
    control.stage("fingerprint")
    lease = load_sibling("locked_identity").AssetIdentityLease(tree=True)
    try:
        identity = lease.acquire(root, lambda path: _weight_identity(path, spec, control, protected=False),
                                 prepared_identity=lambda path: _weight_identity(path, spec, control, protected=True))
        protection = lease.protection_token()
        with torch.inference_mode():
            frames, soundtrack, calls = _render(root, data, control, media, job, policy == "offload")
        if protection is None:
            # On filesystems without a protected interval recheck the fixed
            # assets before publishing a result from the freshly loaded model.
            _weight_identity(root, spec, control, protected=False)
        elif protection is not lease.protection_token():
            raise WorkerError("MODEL_CHANGED", "模型文件已变化，请重新提交")
    finally:
        lease.close()
    control.stage("saving")
    encoder = media.video(frames, job["outputPath"], data, control, WorkerError, soundtrack, 48000, device_backend="cuda")
    return dict(adapter=data["modelId"], validation="待主力机验证", modelSha256=identity, memoryPolicy=policy,
                weightReuse=False, videoAcceleration=dict(device="cuda", requested=data["videoAttention"],
                selected="flash2", calls=calls, encoder=encoder))
