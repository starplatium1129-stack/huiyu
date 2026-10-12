"""Local-only CPU CLIPSeg masks via explicit Transformers package classes.

No ComfyUI code, remote model code, weight conversion, or implicit downloads.
The checkpoint and its license are separate from the Transformers implementation.
Postprocessing follows AP ClipSEG Light's MIT workflow; retain MASK_PROCESSING_LICENSE.txt.
"""
import hashlib
import importlib.util
from functools import lru_cache
import json
import math
import time
from pathlib import Path


FILES = ("config.json", "preprocessor_config.json", "tokenizer_config.json",
         "special_tokens_map.json", "vocab.json", "merges.txt", "model.safetensors")
MAX_PHRASES = 32
MAX_PROMPT_LENGTH = 4096
MAX_CONDITIONING_BYTES = 64 * 1024


def phrases(prompt):
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > MAX_PROMPT_LENGTH:
        raise ValueError("maskPrompt must contain 1..4096 characters")
    result = [part.strip() for part in prompt.split("|") if part.strip()]
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
    processor = None
    processor_path = root / "processor_config.json"
    if processor_path.is_file():
        processor_path = processor_path.resolve()
        if not processor_path.is_relative_to(root):
            raise ValueError("Missing/unsafe local CLIPSeg file: processor_config.json")
        processor = _json(processor_path).get("image_processor")
    # Transformers 5.10.1 prefers nested settings; only None falls back.
    if processor is None:
        processor = _json(root / "preprocessor_config.json")
    if not isinstance(processor, dict):
        raise ValueError("CLIPSeg image_processor must contain an object")
    if processor.get("auto_map") or processor.get("quantization_config"):
        raise ValueError("Custom-code/quantized CLIPSeg components are unsupported")
    if (processor.get("size") not in (352, {"height": 352, "width": 352})
            or (processor.get("size") == 352 and not processor.get("default_to_square", True))):
        raise ValueError("CLIPSeg requires 352x352 image preprocessing")
    if processor.get("input_data_format") not in (None, "channels_last"):
        raise ValueError("CLIPSeg RGB input requires input_data_format=channels_last or null")
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


def logits_mask(logits, size, threshold, grow=8):
    """Mean logits, bilinear resize, AP-style smooth/threshold/grow/feather."""
    import numpy as np
    import torch
    from torch.nn import functional as functional
    logits = np.asarray(logits, dtype=np.float32)
    if logits.shape != (352, 352) or not np.isfinite(logits).all():
        raise ValueError("CLIPSeg returned invalid/nonfinite mask logits")
    resized = functional.interpolate(torch.from_numpy(logits)[None, None],
        size=(size[1], size[0]), mode="bilinear", align_corners=False)
    def blur(values, radius):
        width = 2 * radius + 1
        # A uniform 2D box is separable. Keep the same reflected three-pass
        # filter while avoiding a width*width convolution on the full image.
        horizontal = values.new_full((1, 1, 1, width), 1 / width)
        vertical = horizontal.transpose(-1, -2)
        for _ in range(3):
            values = functional.conv2d(functional.pad(values, (radius, radius, 0, 0), mode="reflect"), horizontal)
            values = functional.conv2d(functional.pad(values, (0, 0, radius, radius), mode="reflect"), vertical)
        return values
    mask = (blur(resized, 2).sigmoid() >= threshold).float()
    if grow:
        mask = functional.max_pool2d(mask, 2 * grow + 1, stride=1, padding=grow)
    mask = blur(mask, 12).clamp(0, 1)[0, 0].numpy()
    if not np.any(mask > 0):
        raise ValueError("Automatic mask has no editable pixels; adjust maskPrompt/threshold or use a manual mask")
    return mask


class MaskCache:
    """One CPU checkpoint/logit map and at most 64 KiB of text conditioning."""
    def __init__(self):
        self.clear()

    def clear(self):
        self.identity = self.components = self.result_key = self.logits = None
        self.conditioning_key = self.conditioning = None
        self.begin_job()

    def begin_job(self):
        self.model_reused = self.result_reused = False
        self.fingerprint_seconds = 0.0

    def stats(self):
        return dict(modelReused=self.model_reused, resultReused=self.result_reused,
                    fingerprintSeconds=self.fingerprint_seconds,
                    resultBytes=0 if self.logits is None else self.logits.nbytes)


@lru_cache(maxsize=1)
def _file_hasher():
    spec = importlib.util.spec_from_file_location("huiyu_native_hash", Path(__file__).with_name("native_hash.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.file_sha256


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
            rows.append((path.relative_to(root).as_posix(), _file_hasher()(path)))
    if not rows:
        raise ValueError("No local CLIPSeg files to fingerprint")
    return str(root), tuple(rows)


def generate_mask(root, image, prompt, threshold, *, grow=8, cache=None, expected_mask_sha256=None):
    """Segment on CPU; bind a supplied profile scope before cache reuse or loading."""
    try:
        if cache is not None:
            cache.begin_job()
        return _generate_mask(root, image, prompt, threshold, grow, cache, expected_mask_sha256)
    except BaseException:
        if cache is not None:
            cache.clear()
        raise


def _generate_mask(root, image, prompt, threshold, grow, cache, expected_mask_sha256):
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
            return logits_mask(cache.logits, image.size, threshold, grow)
    components = cache.components if cache is not None else None
    if components is None:
        root = validate_model(str(root))
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
    conditioning = cache.conditioning if cache is not None and cache.conditioning_key == tuple(texts) else None
    pending = [] if cache is not None and conditioning is None else None
    pending_bytes = 0
    combined = None
    with torch.inference_mode():
        for start in range(0, len(texts), 4):
            count = min(4, len(texts) - start)
            inputs = {name: value[start:start + count].to("cpu") for name, value in tokens.items()
                      if name in ("input_ids", "attention_mask")}
            if conditioning is not None:
                inputs["conditional_embeddings"] = conditioning[start // 4].to(device="cpu", copy=True)
            output = model(pixel_values=pixels.repeat(count, 1, 1, 1), return_dict=True, **inputs)
            logits = output.logits.detach().to(device="cpu", dtype=torch.float32).numpy()
            if logits.shape != (count, 352, 352) or not np.isfinite(logits).all():
                raise ValueError("CLIPSeg returned invalid/nonfinite mask logits")
            if pending is not None:
                embedding = output.conditional_embeddings
                pending_bytes += embedding.numel() * embedding.element_size()
                if pending_bytes <= MAX_CONDITIONING_BYTES:
                    pending.append(embedding.detach().to(device="cpu", copy=True))
                else:
                    pending = None  # Oversized conditioning still produces an ordinary mask.
                del embedding
            # Preserve phrase order, duplicates and a short final batch's weight.
            for phrase_logits in logits:
                combined = phrase_logits.copy() if combined is None else combined + phrase_logits
    combined /= len(texts)
    mask = logits_mask(combined, image.size, threshold, grow)
    if cache is not None:
        cache.result_key, cache.logits = result_key, combined.copy()
        if conditioning is None:
            cache.conditioning_key, cache.conditioning = (tuple(texts), tuple(pending)) if pending is not None else (None, None)
    return mask
