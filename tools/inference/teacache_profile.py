"""Local calibration contract; no model imports, downloads or borrowed coefficients."""
from __future__ import annotations

import hashlib
import json
import math
from pathlib import Path
import re
from concurrent.futures import ThreadPoolExecutor
from functools import lru_cache
import importlib.util
import os
import tempfile

ALGORITHM = "huiyu-anima-first-norm-residual-v1"
PHASE_ALGORITHM = "huiyu-anima-phase-envelope-v2"
LOCAL_ALGORITHM = "huiyu-anima-local-guard-v1"
PROFILE_ALGORITHMS = ((1, ALGORITHM), (2, PHASE_ALGORITHM), (3, LOCAL_ALGORITHM))
EXECUTION = os.environ.get("HUIYU_INFERENCE_ACCELERATION", "native")
RUNTIME = {"diffusers": "0.41.0", "torch": "2.8.0", "huiyuInference": "anima-workflow-effects-v3",
           "memoryPolicy": os.environ.get("HUIYU_INFERENCE_MEMORY", "resident"),
           "execution": EXECUTION,
           "executionRevision": "cosmos-v3-native-no-kv-repeat-v1" if EXECUTION == "native" else
               "cosmos-v2-sage220-cu128torch280-post3-triton340post21" +
               ("-fusion-cpu-base-v1" if EXECUTION == "compiled-fused-sage" else "")}
RUNTIME["executionRevision"] += "-text-kv128-v1"
COMPONENTS = ("text_encoder", "text_conditioner", "transformer", "vae", "tokenizer", "t5_tokenizer", "scheduler")
PROFILE_SET_KIND = "huiyu-teacache-profile-set"
PROFILE_LIMIT = 65536
PROFILE_COUNT_LIMIT = 16


class TeaCacheError(ValueError):
    code = "TEACACHE_PROFILE_INVALID"


def canonical_sha256(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()).hexdigest()


@lru_cache(maxsize=1)
def _hash_module():
    spec = importlib.util.spec_from_file_location("huiyu_native_hash", Path(__file__).with_name("native_hash.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def file_sha256(path):
    return _hash_module().file_sha256(path)


@lru_cache(maxsize=1)
def _prompt_module():
    spec = importlib.util.spec_from_file_location("huiyu_anima_prompt_weights", Path(__file__).with_name("anima_prompt_weights.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@lru_cache(maxsize=1)
def _mask_module():
    spec = importlib.util.spec_from_file_location("huiyu_clipseg_scope", Path(__file__).with_name("clipseg_mask.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@lru_cache(maxsize=1)
def _upscale_module():
    spec = importlib.util.spec_from_file_location("huiyu_upscale_scope", Path(__file__).with_name("anima_upscale.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@lru_cache(maxsize=1)
def _postprocess_module():
    spec = importlib.util.spec_from_file_location("huiyu_rcas_scope", Path(__file__).with_name("anima_postprocess.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def adapter_identity(loras):
    """Hash every supplied adapter byte, preserving request order and strength."""
    if not loras:
        return []
    with ThreadPoolExecutor(max_workers=min(4, len(loras))) as pool:
        hashes = list(pool.map(file_sha256, [Path(row["path"]) for row in loras]))
    return [{"sha256": digest, "strength": row["strength"]} for row, digest in zip(loras, hashes)]


def model_identity(root, loras):
    """Hash exact local component bytes, not filenames/mtime or a model display ID.

    This primitive always reads all bytes. The resident Windows lease may reuse
    its result only while OS write/delete protection and change watches remain
    valid. Its acquisition cost belongs in cold-job measurements. Profile/output
    files are excluded.
    """
    root = Path(root).resolve()
    files = [p for name in COMPONENTS for p in (root / name).rglob("*") if p.is_file()]
    files += [p for name in ("modular_model_index.json", "model_index.json") if (p := root / name).is_file()]
    files.sort()
    for path in files:
        if not path.resolve().is_relative_to(root):
            raise TeaCacheError("Model component escapes the selected model directory")
    if not files:
        raise TeaCacheError("No local model files to fingerprint")
    # Bound concurrent disk readers/buffers. map preserves canonical file and
    # adapter order; this primitive reads every byte on every call, including duplicates.
    paths = files + [Path(row["path"]) for row in loras]
    with ThreadPoolExecutor(max_workers=min(4, len(paths))) as pool:
        hashes = list(pool.map(file_sha256, paths))
    identities = [[path.relative_to(root).as_posix(), digest] for path, digest in zip(files, hashes)]
    return {"modelSha256": canonical_sha256(identities),
            "componentSha256": {name: canonical_sha256([[path[len(name) + 1:], digest]
                for path, digest in identities if path.startswith(name + "/")]) for name in COMPONENTS},
            "loras": [{"sha256": digest, "strength": row["strength"]}
                      for row, digest in zip(loras, hashes[len(files):])]}


def compatibility(root, loras, data, mode, dtype, device_name, *, mask_model_dir=None, upscale_model_path=None, identity=None):
    root = Path(root).resolve()
    identity = model_identity(root, loras) if identity is None else identity
    # Component reuse is private residency metadata, not a calibration ABI.
    identity = {key: identity[key] for key in ("modelSha256", "loras")}
    mask_identity = None
    if mode == "masked" and data.get("maskPrompt"):
        if mask_model_dir is None:
            raise TeaCacheError("Automatic-mask calibration requires the exact local CLIPSeg assets")
        mask_root = Path(mask_model_dir).resolve()
        mask_files = sorted(p for p in mask_root.rglob("*") if p.is_file())
        if not mask_files or any(not p.resolve().is_relative_to(mask_root) for p in mask_files):
            raise TeaCacheError("Invalid local CLIPSeg calibration identity")
        mask_identity = canonical_sha256([[p.relative_to(mask_root).as_posix(), file_sha256(p)] for p in mask_files])
    upscale = {}
    weighting = _prompt_module().weights_scope(data.get("prompt"), data.get("negativePrompt"))
    if data.get("hiresFix") and data.get("superResModel"):
        if upscale_model_path is None:
            raise TeaCacheError("Remacri calibration requires the exact local upscaler")
        upscale["upscaleModelSha256"] = file_sha256(upscale_model_path)
    return {**identity, "maskModelSha256": mask_identity, **upscale,
        "sampling": {"width": data["width"], "height": data["height"], "steps": data["steps"],
            "cfg": data["cfg"], "mode": mode, "denoisingStrength": data.get("denoisingStrength"),
            "sampler": data.get("sampler", "euler"), "scheduler": data.get("scheduler", "simple"),
            **({"rcasStrength": data["rcasStrength"], "rcasExecutionRevision": _postprocess_module().EXECUTION_REVISION}
                if data.get("rcasStrength", 0) else {}),
            **({"promptWeighting": weighting} if weighting else {}),
            **({"hires": {key: data.get(key) for key in ("hiresScale", "hiresDenoise", "hiresUpscaler", "hiresSampler", "hiresScheduler", "superResModel")},
                "refinementRevision": "fp32-vae-full-oom-feather-remacri512-kjrcas-v3"} if data.get("hiresFix") else {}),
            **({"upscaleExecutionRevision": _upscale_module().EXECUTION_REVISION} if upscale else {}),
            "maskSource": ("clipseg" if data.get("maskPrompt") else "manual") if mode == "masked" else None,
            **({"maskExecutionRevision": _mask_module().EXECUTION_REVISION}
                if mode == "masked" and data.get("maskPrompt") else {}),
            "growMaskBy": data.get("growMaskBy", 0) if mode == "masked" else None,
            "maskThreshold": data.get("maskThreshold") if mode == "masked" else None,
            "maskPrompt": data.get("maskPrompt") if mode == "masked" else None},
        "dtype": str(dtype), "deviceName": device_name}


def finite(value, low=None, high=None):
    return (not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)
            and (low is None or low <= value) and (high is None or value <= high))


def validate_profile(profile, expected, threshold=None, *, require_accepted=True):
    """Validate a profile and return the resolved threshold. No silent fallback."""
    if not isinstance(profile, dict) or (profile.get("schemaVersion"), profile.get("algorithm")) not in PROFILE_ALGORITHMS:
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
        fields = ("phaseEnvelopes", "localPhaseEnvelopes") if profile["schemaVersion"] == 3 else ("phaseEnvelopes",)
        for field in fields:
            phases = profile.get(field)
            if not isinstance(phases, list) or len(phases) != 3:
                raise TeaCacheError("Phase calibration requires exactly three observed phase envelopes")
            for points in phases:
                if (not isinstance(points, list) or not 2 <= len(points) <= 32 or
                        any(not isinstance(p, list) or len(p) != 2 or not all(finite(v, 0) for v in p) for p in points) or
                        any(a[0] >= b[0] for a, b in zip(points, points[1:]))):
                    raise TeaCacheError("Phase envelope needs finite nonnegative, strictly ordered proxy/error points")
        if profile["schemaVersion"] == 3 and (profile.get("localMetric") != "raster-contiguous-c16-fp32-v1"
                or profile.get("maxGroups") != 16 or not finite(profile.get("localThreshold"), 0.01, 1)):
            raise TeaCacheError("Local cache needs its exact metric and calibrated local threshold")
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


def profile_entries(document):
    """Accept the original single profile or one bounded collection of scopes."""
    if not isinstance(document, dict):
        raise TeaCacheError("TeaCache profile document must be an object")
    if "kind" in document:
        if (set(document) != {"schemaVersion", "kind", "profiles"}
                or document.get("schemaVersion") != 1 or document["kind"] != PROFILE_SET_KIND):
            raise TeaCacheError("Unsupported TeaCache profile collection")
        entries = document["profiles"]
        if not isinstance(entries, list) or not 1 <= len(entries) <= PROFILE_COUNT_LIMIT:
            raise TeaCacheError("TeaCache collection must contain 1..16 profiles")
    else:
        entries = [document]
    for index, entry in enumerate(entries):
        if (not isinstance(entry, dict) or not isinstance(entry.get("runtime"), dict)
                or not isinstance(entry.get("compatibility"), dict)
                or (entry.get("schemaVersion"), entry.get("algorithm")) not in PROFILE_ALGORITHMS):
            raise TeaCacheError("Invalid TeaCache profile entry")
        if any(same_scope(entry, previous) for previous in entries[:index]):
            raise TeaCacheError("Duplicate TeaCache runtime/compatibility scope")
    return entries


def same_scope(left, right):
    # Preserve existing validation equality: e.g. CFG 4 and 4.0 are equivalent.
    return (left["runtime"] == right["runtime"] and left["compatibility"] == right["compatibility"]
            and (left["schemaVersion"] == 3) == (right["schemaVersion"] == 3))


def _read_profile_file(path, root):
    try:
        if not isinstance(path, str) or not path:
            raise TeaCacheError("TeaCache is enabled but no locally calibrated profile was supplied")
        source = Path(path).resolve(strict=True)
        if not source.is_relative_to(Path(root).resolve()) or not source.is_file():
            raise TeaCacheError("TeaCache profile must be a nonempty <=64 KiB file inside the selected model directory")
        with source.open("rb") as stream:
            raw = stream.read(PROFILE_LIMIT + 1)
        if not 0 < len(raw) <= PROFILE_LIMIT:
            raise TeaCacheError("TeaCache profile must be a nonempty <=64 KiB file inside the selected model directory")
        document = json.loads(raw)
        profile_entries(document)
        return document, hashlib.sha256(raw).hexdigest()
    except (OSError, ValueError) as exc:
        if isinstance(exc, TeaCacheError):
            raise
        raise TeaCacheError(f"Cannot read local TeaCache profile: {exc}") from exc


def read_profile(path, root, expected=None, *, auto=False):
    # Automatic selection may decline a scope, but never suppress a corrupt file.
    if auto and path is None:
        return None
    document, _ = _read_profile_file(path, root)
    if "kind" not in document and document["schemaVersion"] != 3 and expected is None and not auto:
        return document
    if expected is None:
        raise TeaCacheError("TeaCache collection selection requires the current compatibility scope")
    matches = [entry for entry in profile_entries(document)
               if entry["schemaVersion"] != 3 and entry["runtime"] == RUNTIME and entry["compatibility"] == expected]
    if auto and not matches:
        return None
    if len(matches) != 1:
        raise TeaCacheError("No accepted TeaCache profile matches the exact runtime and compatibility scope; recalibrate")
    if auto:
        validate_profile(matches[0], expected, require_accepted=False)
        acceptance = matches[0].get("acceptance", {})
        if not isinstance(acceptance, dict):
            raise TeaCacheError("Malformed TeaCache acceptance record")
        if acceptance.get("status") != "accepted":
            return None
    validate_profile(matches[0], expected)
    return matches[0]


def install_profile(root, profile, replace_sha256=None):
    """Merge into the fixed model-local file, preserving the exact-file approval."""
    root = Path(root).resolve(strict=True)
    destination = root / "teacache-profile.json"
    validate_profile(profile, profile["compatibility"])
    # Serialize read/merge/publish between acceptance commands. Never steal a
    # pre-existing lock; interrupted publication needs explicit local inspection.
    lock = root / ".teacache-profile.lock"
    try:
        lock_fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as exc:
        raise TeaCacheError("TeaCache acceptance is locked; inspect the existing .teacache-profile.lock") from exc
    temporary = None
    try:
        os.close(lock_fd)
        if destination.is_symlink():
            raise TeaCacheError("Refusing to replace a symbolic-link profile")
        existing, old_digest = _read_profile_file(str(destination), root) if destination.exists() else (None, None)
        if old_digest is not None and (not replace_sha256 or old_digest != replace_sha256):
            raise TeaCacheError("Existing profile preserved; replacement or append requires its exact --replace-profile-sha256")
        if old_digest is None and replace_sha256:
            raise TeaCacheError("Expected replacement profile is missing")
        entries = list(profile_entries(existing)) if existing is not None else []
        matched = [index for index, entry in enumerate(entries) if same_scope(entry, profile)]
        if matched:
            entries[matched[0]] = profile
        else:
            entries.append(profile)
        document = (entries[0] if len(entries) == 1 and (existing is None or "kind" not in existing) else
                    dict(schemaVersion=1, kind=PROFILE_SET_KIND, profiles=entries))
        profile_entries(document)
        encoded = (json.dumps(document, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")
        if len(encoded) > PROFILE_LIMIT:
            raise TeaCacheError("TeaCache profile collection exceeds 64 KiB; existing profiles preserved")
        with tempfile.NamedTemporaryFile(mode="wb", dir=root, prefix=".teacache-", suffix=".json", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(encoded)
        if old_digest is not None:
            if destination.is_symlink() or _read_profile_file(str(destination), root)[1] != old_digest:
                raise TeaCacheError("Existing profile changed during acceptance")
            os.replace(temporary, destination)
        else:
            # Atomic publish without overwriting a file created after our read.
            os.link(temporary, destination)
        return destination, hashlib.sha256(encoded).hexdigest()
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
        lock.unlink(missing_ok=True)
