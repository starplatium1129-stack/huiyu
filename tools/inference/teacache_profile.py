"""Local calibration contract; no model imports, downloads or borrowed coefficients."""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import re

ALGORITHM = "huiyu-anima-first-norm-residual-v1"
PHASE_ALGORITHM = "huiyu-anima-phase-envelope-v2"
RUNTIME = {"diffusers": "0.41.0", "torch": "2.8.0", "huiyuInference": "lora-eval-v1"}
COMPONENTS = ("text_encoder", "text_conditioner", "transformer", "vae", "tokenizer", "t5_tokenizer", "scheduler")


class TeaCacheError(ValueError):
    code = "TEACACHE_PROFILE_INVALID"


def canonical_sha256(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


def file_sha256(path):
    with Path(path).open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def model_identity(root, loras):
    """Hash exact local component bytes, not filenames/mtime or a model display ID.

    Full hashing is intentionally uncached across jobs. Its cold-start cost must be
    included in device end-to-end benchmarks. Profile/output files are excluded.
    """
    root = Path(root).resolve()
    files = [p for name in COMPONENTS for p in (root / name).rglob("*") if p.is_file()]
    files += [p for name in ("modular_model_index.json", "model_index.json") if (p := root / name).is_file()]
    identities = []
    for path in sorted(files):
        if not path.resolve().is_relative_to(root):
            raise TeaCacheError("Model component escapes the selected model directory")
        identities.append([path.relative_to(root).as_posix(), file_sha256(path)])
    if not identities:
        raise TeaCacheError("No local model files to fingerprint")
    return {"modelSha256": canonical_sha256(identities),
            "loras": [{"sha256": file_sha256(row["path"]), "strength": row["strength"]} for row in loras]}


def compatibility(root, loras, data, mode, dtype, device_name, *, mask_model_dir=None, identity=None):
    root = Path(root).resolve()
    identity = model_identity(root, loras) if identity is None else identity
    mask_identity = None
    if mode == "masked" and data.get("maskPrompt"):
        if mask_model_dir is None:
            raise TeaCacheError("Automatic-mask calibration requires the exact local CLIPSeg assets")
        mask_root = Path(mask_model_dir).resolve()
        mask_files = sorted(p for p in mask_root.rglob("*") if p.is_file())
        if not mask_files or any(not p.resolve().is_relative_to(mask_root) for p in mask_files):
            raise TeaCacheError("Invalid local CLIPSeg calibration identity")
        mask_identity = canonical_sha256([[p.relative_to(mask_root).as_posix(), file_sha256(p)] for p in mask_files])
    return {**identity, "maskModelSha256": mask_identity,
        "sampling": {"width": data["width"], "height": data["height"], "steps": data["steps"],
            "cfg": data["cfg"], "mode": mode, "denoisingStrength": data.get("denoisingStrength"),
            "sampler": data.get("sampler", "euler"), "scheduler": data.get("scheduler", "simple"),
            "maskSource": ("clipseg" if data.get("maskPrompt") else "manual") if mode == "masked" else None,
            "growMaskBy": data.get("growMaskBy", 0) if mode == "masked" else None,
            "maskThreshold": data.get("maskThreshold") if mode == "masked" else None,
            "maskPrompt": data.get("maskPrompt") if mode == "masked" else None},
        "dtype": str(dtype), "deviceName": device_name}


def finite(value, low=None, high=None):
    return (not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)
            and (low is None or low <= value) and (high is None or value <= high))


def validate_profile(profile, expected, threshold=None, *, require_accepted=True):
    """Validate a profile and return the resolved threshold. No silent fallback."""
    if not isinstance(profile, dict) or (profile.get("schemaVersion"), profile.get("algorithm")) not in ((1, ALGORITHM), (2, PHASE_ALGORITHM)):
        raise TeaCacheError("Unsupported TeaCache profile schema/algorithm; locally calibrate this runtime")
    if profile.get("runtime") != RUNTIME or profile.get("compatibility") != expected:
        raise TeaCacheError("TeaCache profile does not match the exact runtime, model/LoRAs, sampling scope, dtype or device; recalibrate")
    if profile["schemaVersion"] == 1:
        coefficients = profile.get("coefficients")
        if not isinstance(coefficients, list) or not 1 <= len(coefficients) <= 6 or not all(finite(c) for c in coefficients):
            raise TeaCacheError("TeaCache coefficients must be 1..6 finite ascending-order polynomial coefficients")
        domain = profile.get("proxyRange")
        if not isinstance(domain, list) or len(domain) != 2 or not all(finite(x, 0) for x in domain) or domain[0] > domain[1]:
            raise TeaCacheError("TeaCache proxyRange must be the finite nonnegative calibrated interval")
    else:
        phases = profile.get("phaseEnvelopes")
        if not isinstance(phases, list) or len(phases) != 3:
            raise TeaCacheError("Phase calibration requires exactly three observed phase envelopes")
        for points in phases:
            if (not isinstance(points, list) or not 2 <= len(points) <= 32 or
                    any(not isinstance(p, list) or len(p) != 2 or not all(finite(v, 0) for v in p) for p in points) or
                    any(a[0] >= b[0] for a, b in zip(points, points[1:]))):
                raise TeaCacheError("Phase envelope needs finite nonnegative, strictly ordered proxy/error points")
    default, maximum = profile.get("defaultThreshold"), profile.get("maxThreshold")
    if not finite(default, 0.01, 1) or not finite(maximum, default, 1):
        raise TeaCacheError("TeaCache profile threshold bounds are invalid")
    skips = profile.get("maxConsecutiveSkips")
    if type(skips) is not int or not 1 <= skips <= 3:
        raise TeaCacheError("TeaCache maxConsecutiveSkips must be 1..3")
    calibration = profile.get("calibration", {})
    if (not isinstance(calibration, dict) or calibration.get("source") != "local-full-compute"
            or type(calibration.get("sampleCount")) is not int or calibration["sampleCount"] < 2
            or not isinstance(calibration.get("traceSha256"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", calibration["traceSha256"])):
        raise TeaCacheError("TeaCache requires explicit local full-compute calibration evidence")
    acceptance = profile.get("acceptance", {})
    if require_accepted and (not isinstance(acceptance, dict) or acceptance.get("status") != "accepted"
            or not isinstance(acceptance.get("reportSha256"), str)
            or not re.fullmatch(r"[0-9a-f]{64}", acceptance["reportSha256"])):
        raise TeaCacheError("TeaCache profile needs explicit acceptance after local held-out device comparison")
    selected = default if threshold is None else threshold
    if not finite(selected, 0.01, maximum):
        raise TeaCacheError(f"TeaCache threshold must be in [0.01, {maximum}] for this calibration")
    return selected


def read_profile(path, root):
    try:
        if not isinstance(path, str) or not path:
            raise TeaCacheError("TeaCache is enabled but no locally calibrated profile was supplied")
        source = Path(path).resolve(strict=True)
        if not source.is_relative_to(Path(root).resolve()) or not source.is_file() or not 0 < source.stat().st_size <= 65536:
            raise TeaCacheError("TeaCache profile must be a nonempty <=64 KiB file inside the selected model directory")
        return json.loads(source.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        if isinstance(exc, TeaCacheError):
            raise
        raise TeaCacheError(f"Cannot read local TeaCache profile: {exc}") from exc
