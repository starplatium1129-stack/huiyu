"""Local-only CPU CLIPSeg masks via explicit Transformers package classes.

No ComfyUI code, remote model code, weight conversion, or implicit downloads.
The checkpoint and its license are separate from the Transformers implementation.
"""
import hashlib
import json
import math
import time
from pathlib import Path


FILES = ("config.json", "preprocessor_config.json", "tokenizer_config.json",
         "special_tokens_map.json", "vocab.json", "merges.txt", "model.safetensors")
MAX_PHRASES = 32
MAX_PROMPT_LENGTH = 4096


def phrases(prompt):
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_PROMPT_LENGTH:
        raise ValueError("maskPrompt must contain 1..4096 characters")
    result = list(dict.fromkeys(part.strip() for part in prompt.split("|") if part.strip()))
    if not result or len(result) > MAX_PHRASES:
        raise ValueError("maskPrompt must contain 1..32 nonempty phrases separated by |")
    return result


def _json(path):
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(f"Invalid local CLIPSeg config: {path.name}") from exc
    if not isinstance(value, dict):
        raise ValueError(f"CLIPSeg {path.name} must contain an object")
    return value


def validate_model(value):
    if not isinstance(value, str) or not value or not Path(value).is_absolute():
        raise ValueError("maskModelDir must be an absolute host-approved local CLIPSeg directory")
    root = Path(value).resolve()
    if not root.is_dir():
        raise ValueError("Missing local clipseg-rd64-refined directory")
    for name in FILES:
        path = (root / name).resolve()
        if not path.is_relative_to(root) or not path.is_file() or path.stat().st_size == 0:
            raise ValueError(f"Missing/unsafe local CLIPSeg file: {name}")
    config = _json(root / "config.json")
    if config.get("model_type") != "clipseg" or config.get("reduce_dim") != 64 or config.get("use_complex_transposed_convolution") is not True:
        raise ValueError("Expected CLIPSeg rd64-refined config")
    for name in FILES:
        if name.endswith(".json") and name != "vocab.json":
            settings = _json(root / name)
            if settings.get("auto_map") or settings.get("quantization_config"):
                raise ValueError("Custom-code/quantized CLIPSeg components are unsupported")
    processor = _json(root / "preprocessor_config.json")
    if processor.get("size") not in (352, {"height": 352, "width": 352}):
        raise ValueError("CLIPSeg requires 352x352 image preprocessing")
    for flag in ("do_resize", "do_rescale", "do_normalize"):
        if processor.get(flag, True) is not True:
            raise ValueError(f"CLIPSeg requires {flag}=true")
    factor = processor.get("rescale_factor", 1 / 255)
    if (processor.get("resample", 2) != 2 or isinstance(factor, bool)
            or not isinstance(factor, (int, float)) or not math.isfinite(factor)
            or abs(factor - 1 / 255) > 1e-12):
        raise ValueError("CLIPSeg requires bilinear resize and 1/255 pixel rescaling")
    for field in ("image_mean", "image_std"):
        values = processor.get(field, [0.5, 0.5, 0.5])
        if (not isinstance(values, list) or len(values) != 3
                or any(isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n)
                       or (field == "image_std" and n <= 0) for n in values)):
            raise ValueError(f"Invalid CLIPSeg three-channel {field}")
    return root


def logits_mask(logits, size, threshold):
    """Max-phrase logits, bilinear resize, sigmoid, then a binary edit mask."""
    import numpy as np
    from PIL import Image
    logits = np.asarray(logits, dtype=np.float32)
    if logits.shape != (352, 352) or not np.isfinite(logits).all():
        raise ValueError("CLIPSeg returned invalid/nonfinite mask logits")
    resized = np.asarray(Image.fromarray(logits).resize(size, Image.Resampling.BILINEAR))
    probabilities = 1 / (1 + np.exp(-np.clip(resized, -80, 80)))
    mask = Image.fromarray(np.where(probabilities >= threshold, 255, 0).astype(np.uint8))
    if mask.getbbox() is None:
        raise ValueError("Automatic mask has no editable pixels; adjust maskPrompt/threshold or use a manual mask")
    return mask


class MaskCache:
    """One CPU checkpoint and one 352x352 logit map, owned by a serial worker."""
    def __init__(self):
        self.clear()

    def clear(self):
        self.identity = self.components = self.result_key = self.logits = None
        self.begin_job()

    def begin_job(self):
        self.model_reused = self.result_reused = False
        self.fingerprint_seconds = 0.0

    def stats(self):
        return dict(modelReused=self.model_reused, resultReused=self.result_reused,
                    fingerprintSeconds=self.fingerprint_seconds,
                    resultBytes=0 if self.logits is None else self.logits.nbytes)


def model_identity(root):
    """Re-read exact bytes every job; metadata is never an invalidation proof."""
    root = Path(root).resolve()
    # Tokenizers may load optional tokenizer.json/added_tokens.json or a locally
    # selected versioned asset, so the required-file list is not a complete key.
    rows = []
    for path in sorted(root.rglob("*")):
        resolved = path.resolve()
        if not resolved.is_relative_to(root):
            raise ValueError("CLIPSeg model component escapes its selected directory")
        if path.is_file():
            with path.open("rb") as source:
                rows.append((path.relative_to(root).as_posix(), hashlib.file_digest(source, "sha256").hexdigest()))
    if not rows:
        raise ValueError("No local CLIPSeg files to fingerprint")
    return str(root), tuple(rows)


def generate_mask(root, image, prompt, threshold, *, cache=None, expected_mask_sha256=None):
    """Segment on CPU; bind a supplied profile scope before cache reuse or loading."""
    try:
        if cache is not None:
            cache.begin_job()
        return _generate_mask(root, image, prompt, threshold, cache, expected_mask_sha256)
    except BaseException:
        if cache is not None:
            cache.clear()
        raise


def _generate_mask(root, image, prompt, threshold, cache, expected_mask_sha256):
    import numpy as np
    import torch
    from transformers import CLIPSegForImageSegmentation, CLIPTokenizer, ViTImageProcessorPil
    texts = phrases(prompt)
    fingerprint_started = time.perf_counter()
    identity = model_identity(root) if cache is not None or expected_mask_sha256 is not None else None
    fingerprint_seconds = time.perf_counter() - fingerprint_started
    if expected_mask_sha256 is not None:
        digest = hashlib.sha256(json.dumps(identity[1], sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()
        if digest != expected_mask_sha256:
            raise ValueError("CLIPSeg model bytes changed since TeaCache profile scope validation")
    result_key = None
    if cache is not None:
        if cache.identity != identity:
            cache.clear()
        cache.fingerprint_seconds = fingerprint_seconds
        cache.model_reused = cache.components is not None
        # The image already has the final oriented, resized RGB pixels. Store only
        # their digest and the small logits; threshold/growth remain per-request.
        result_key = (image.mode, image.size, hashlib.sha256(image.tobytes()).digest(), tuple(texts))
        if cache.result_key == result_key and cache.logits is not None:
            cache.result_reused = True
            return logits_mask(cache.logits, image.size, threshold)
    components = cache.components if cache is not None else None
    if components is None:
        tokenizer = CLIPTokenizer.from_pretrained(str(root), local_files_only=True, trust_remote_code=False)
        processor = ViTImageProcessorPil.from_pretrained(str(root), local_files_only=True, trust_remote_code=False,
            do_center_crop=False, do_pad=False)
    else:
        tokenizer, processor, model = components
    tokens = tokenizer(texts, padding=True, truncation=False, return_tensors="pt")
    if tokens["input_ids"].shape[-1] > 77:
        raise ValueError("Each maskPrompt phrase must fit CLIPSeg's 77-token context; shorten the phrase")
    pixels = processor(images=image, return_tensors="pt")["pixel_values"].to(device="cpu", dtype=torch.float32)
    if components is None:
        model, info = CLIPSegForImageSegmentation.from_pretrained(str(root), local_files_only=True,
            trust_remote_code=False, use_safetensors=True, dtype=torch.float32, output_loading_info=True)
        if any(info.get(key) for key in ("missing_keys", "unexpected_keys", "mismatched_keys", "error_msgs")):
            raise ValueError("CLIPSeg checkpoint did not load completely; prepare a matching rd64-refined export")
        model = model.to("cpu").eval()
        if identity is not None:
            fingerprint_started = time.perf_counter()
            loaded_identity = model_identity(root)
            if cache is not None:
                cache.fingerprint_seconds += time.perf_counter() - fingerprint_started
            if loaded_identity != identity:
                raise ValueError("CLIPSeg model bytes changed while loading; retry after preparation completes")
        if cache is not None:
            cache.identity, cache.components = identity, (tokenizer, processor, model)
    combined = None
    with torch.inference_mode():
        for start in range(0, len(texts), 4):
            count = min(4, len(texts) - start)
            inputs = {name: value[start:start + count].to("cpu") for name, value in tokens.items()
                      if name in ("input_ids", "attention_mask")}
            output = model(pixel_values=pixels.repeat(count, 1, 1, 1), return_dict=True, **inputs)
            logits = output.logits.detach().to(device="cpu", dtype=torch.float32).numpy()
            if logits.shape != (count, 352, 352) or not np.isfinite(logits).all():
                raise ValueError("CLIPSeg returned invalid/nonfinite mask logits")
            batch = logits.max(axis=0)
            combined = batch if combined is None else np.maximum(combined, batch)
    mask = logits_mask(combined, image.size, threshold)
    if cache is not None:
        cache.result_key, cache.logits = result_key, combined.copy()
    return mask
