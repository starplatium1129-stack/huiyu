"""Optional local Qwen editing and official MangaLineExtraction; no auto-downloads.

The plain MangaScreen path never imports this module. All adaptations remain
Network definitions and their MIT notice are shipped separately.
"""
import gc
import hashlib
import importlib.metadata
import pickle
from pathlib import Path
from huiyu_worker_lifecycle import load_sibling as sibling


contract = sibling("manga_contract")
Error = contract.MangaError
_adapter_ready = _line_ready = False


def prepare(data):
    global _adapter_ready, _line_ready
    # Called per job: a warm CPU worker may receive its first model task later.
    if data.get("rewrite"):
        if not _adapter_ready:
            sibling("adapter_worker").dependencies(data["rewrite"]["modelId"])
            _adapter_ready = _line_ready = True
    elif data.get("autoLines") and not _line_ready:
        try:
            version = importlib.metadata.version("torch").split("+")[0]
        except importlib.metadata.PackageNotFoundError as exc:
            raise Error("MANGA_DEPENDENCY_MISSING", "自动线稿需要独立环境中的 torch==2.8.0") from exc
        # 2.8 is the extraction baseline; managed/shared image runtimes use
        # 2.9/2.13. All keep weights_only loading and strict state assignment.
        if version not in (contract.MANIFEST["lineart"]["torch"], "2.9.0", "2.13.0"):
            raise Error("MANGA_DEPENDENCY_VERSION", "自动线稿需要已支持的图像运行库；请勿修改 Anima 环境")
        import torch  # Import only, never initializes a model or CUDA here.
        _line_ready = True


def rewrite(job, data, rgb, control, *, resident=None):
    import numpy as np
    from PIL import Image
    adapter = sibling("adapter_worker")
    request = dict(data["rewrite"])
    spec = adapter.contract.model(request["modelId"])
    request.update(steps=spec["steps"], cfg=spec["cfg"], negativePrompt="")
    # Validate the same local layout before considering a protected pixel result.
    root = adapter.contract.layout(job["modelDir"], spec)
    key = resident.key(root, request, rgb) if resident is not None else None
    if resident is not None:
        cached = resident.get(key)
        if cached is not None:
            control.stage("manga_rewrite")
            return cached
    observation = {}
    try:
        control.stage("manga_rewrite")
        redraw_job = dict(id=job["id"], op="generate", input=request, modelDir=job["modelDir"],
                          inputImagePath=job["inputImagePath"], outputPath=job["outputPath"])
        pixels = adapter.generate(redraw_job, control, None, result_callback=observation.update,
            resident=resident.adapters() if resident is not None else None, manga_pixels=rgb,
            reference_resolution=round((request["width"] * request["height"]) ** 0.5))
        control.check()
        if pixels.shape[-1] == 4:
            with Image.fromarray(pixels) as image, Image.new("RGBA", image.size, "white") as background:
                background.alpha_composite(image)
                with background.convert("RGB") as flattened:
                    pixels = np.array(flattened)
        observation["resultReused"] = False
        if resident is not None:
            resident.put(key, pixels, observation)
        return pixels, observation
    finally:
        # The request shell is retired; the worker owns any reusable weight cache.
        # Return temporary allocator reserves before optional line extraction.
        gc.collect()
        import torch
        if torch.cuda.is_initialized():
            torch.cuda.empty_cache()


def extract(rgb, weight, control, *, resident=None):
    import cv2
    import numpy as np
    import torch
    source = Path(weight)
    if source.is_symlink() or getattr(source, "is_junction", lambda: False)() or not source.is_file():
        raise Error("MANGA_LINE_MODEL_MISSING", "需要本地 manga-line-extraction/erika.pth，不会自动下载")
    key = token = None
    if resident is not None:
        key, token, cached = resident.line_input(source, rgb)
        if cached is not None:
            control.stage("manga_line_extract")
            return cached
    model = None
    hooks = []
    try:
        control.stage("manga_line_loading")
        # Hash and load the same open file. weights_only never unpickles arbitrary
        # Python objects; do not retry unsafe loading for an incompatible checkpoint.
        with source.open("rb") as stream:
            before = source.stat()
            if not 0 < before.st_size <= 256 * 1024 * 1024:
                raise Error("MANGA_LINE_MODEL_INVALID", "erika.pth 大小不符合支持范围")
            digest = hashlib.sha256()
            while chunk := stream.read(8 * 1024 * 1024):
                control.check()
                digest.update(chunk)
            stream.seek(0)
            state = torch.load(stream, map_location="cpu", weights_only=True)
            after = source.stat()
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
                raise Error("MODEL_CHANGED", "线稿权重在加载期间发生变化")
        control.check()
        model = sibling("manga_line_model").res_skip().eval()
        model.load_state_dict(state, strict=True)
        del state
        # Official CLI preprocessing: grayscale in [0,255], pad to 16 with 1,
        # crop to the source size. No undocumented detect-resolution downsampling.
        gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
        h, w = gray.shape
        patch = np.ones((1, 1, (h + 15) // 16 * 16, (w + 15) // 16 * 16), dtype=np.float32)
        patch[0, 0, :h, :w] = gray
        device = "cpu"
        if torch.cuda.is_available():
            required = 256 * 1024**2 + h * w * 2048
            free, _ = torch.cuda.mem_get_info()
            # A completed Qwen rewrite can still own almost all VRAM. Release
            # only as many offloadable denoiser groups as this line pass needs.
            weights = resident.weights if resident is not None else None
            if (free < required and weights is not None
                    and isinstance(weights.memory, sibling("mapped_residency").Residency)):
                weights.memory.make_room(required)
                free, _ = torch.cuda.mem_get_info()
            if free >= required:
                device = "cuda:0"
        model.to(device)
        # Cancellation at module boundaries; a long convolution is still covered
        # by the host's bounded cancellation wait and process termination.
        for layer in model.modules():
            if not any(layer.children()):
                hooks.append(layer.register_forward_pre_hook(lambda *_: control.check()))
        control.stage("manga_line_extract")
        with torch.inference_mode():
            line = model(torch.from_numpy(patch).to(device)).cpu().numpy()[0, 0, :h, :w]
        control.check()
        if not np.isfinite(line).all():
            raise Error("MANGA_LINE_OUTPUT_INVALID", "线稿模型返回非有限值")
        # Author's output is black on white. MangaFinish pen_lines expects the
        # inverse (same polarity documented by comfyui_controlnet_aux Manga Lineart).
        pen = 1 - line.clip(0, 255).astype(np.uint8).astype(np.float32) / 255
        observation = {"model": contract.MANIFEST["lineart"]["id"], "modelSha256": digest.hexdigest(),
                       "sourceRevision": contract.MANIFEST["lineart"]["revision"],
                       "device": "cuda" if device != "cpu" else "cpu", "resultReused": False}
        if resident is not None:
            resident.put_line(key, token, pen, observation)
        return pen, observation
    except (RuntimeError, ValueError, KeyError, pickle.UnpicklingError) as exc:
        raise Error("MANGA_LINE_MODEL_INVALID", f"无法加载或执行官方 erika.pth：{exc}；不会替换算法或使用不安全加载") from exc
    finally:
        for hook in hooks:
            hook.remove()
        model = None
        gc.collect()
