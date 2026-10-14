"""Prepare pinned PixAI files and private timm using the managed Windows Python.

Rust downloads and owns activation. This helper has no pip/network/model execution.
"""
from __future__ import annotations

import argparse
import contextlib
from email.parser import BytesParser
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import tempfile
import zipfile

MAX_UNPACKED = 64 * 1024 * 1024
MAX_MEMBER = 8 * 1024 * 1024
MAX_ENTRIES = 4096
OWNER = ".huiyu-pixai-deps.json"
PARTIAL = ".huiyu-partial"


def progress(message):
    print(message, file=sys.stderr, flush=True)


def checked(path, kind=None):
    path = Path(path)
    if not path.is_absolute():
        raise ValueError(f"Expected an absolute local path: {path}")
    absolute = os.path.abspath(path)
    if absolute.startswith("\\\\?\\") and len(absolute) > 6 and absolute[5:7] == ":\\":
        absolute = absolute[4:]
    path = Path(absolute)
    for current in reversed((path, *path.parents)):
        try:
            info = current.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
            raise ValueError(f"Linked paths are not accepted: {current}")
        if stat.S_ISREG(info.st_mode) and info.st_nlink != 1:
            raise ValueError(f"Hard-linked files are not accepted: {current}")
        if current != path and not stat.S_ISDIR(info.st_mode):
            raise ValueError(f"Path ancestor is not a directory: {current}")
    if kind == "file" and not path.is_file():
        raise ValueError(f"Required regular file is missing: {path}")
    if kind == "dir" and not path.is_dir():
        raise ValueError(f"Required directory is missing: {path}")
    return path


def read_json(path):
    path = checked(path, "file")
    if path.stat().st_size > 256 * 1024:
        raise ValueError(f"JSON metadata is too large: {path}")
    return json.loads(path.read_text(encoding="utf-8-sig"))


def trusted_hasher(app):
    source = checked(app / "tools/inference/native_hash.py", "file")
    spec = importlib.util.spec_from_file_location("huiyu_pixai_hash", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.file_sha256


def verify_file(root, entry, digest):
    relative = PurePosixPath(entry["path"])
    if len(relative.parts) != 1 or relative.name != entry["path"] or ":" in relative.name or "\\" in relative.name:
        raise ValueError("Pinned PixAI manifest contains an invalid filename")
    target = checked(root / relative.name, "file")
    before = target.stat()
    if before.st_size != entry["bytes"] or digest(target) != entry["sha256"]:
        raise ValueError(f"PixAI fixed file integrity mismatch: {relative.name}")
    after = target.stat()
    if (before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_ino, after.st_size, after.st_mtime_ns):
        raise ValueError(f"PixAI fixed file changed during verification: {relative.name}")
    return target


def runtime_binding(root, runtime, app, digest):
    fixed = checked(app / "tools/inference/managed-runtime.windows-x64.json", "file")
    manifest = read_json(fixed)
    if os.name != "nt" or manifest["schemaVersion"] != 1 or manifest["platform"] != "win32-x64" or sys.maxsize <= 2**32:
        raise ValueError("PixAI preparation requires the fixed managed Windows x64 runtime")
    expected = root.parent / "inference" / manifest["runtimeId"]
    if root.name.casefold() != "pixai" or runtime != checked(expected, "dir"):
        raise ValueError("PixAI must use its sibling application-managed inference runtime")
    python = checked(runtime / "venv/Scripts/python.exe", "file")
    site = checked(runtime / "venv/Lib/site-packages", "dir")
    if checked(sys.executable, "file") != python or not sys.flags.isolated or not sys.dont_write_bytecode:
        raise ValueError("Preparation must run the selected managed Python with -I -B")
    if sys.version_info[:3] != tuple(map(int, manifest["pythonVersion"].split("."))):
        raise ValueError("Managed Python version differs from the fixed manifest")
    saved = read_json(runtime / "runtime-config.json")
    requirements = checked(app / "tools/inference/requirements.txt", "file")
    if (saved.get("schemaVersion") != 1 or saved.get("engine") != "native"
            or saved.get("managedRuntimeId") != manifest["runtimeId"]
            or saved.get("manifestSha256") != digest(fixed)
            or saved.get("requirementsSha256") != digest(requirements)
            or checked(saved.get("python", ""), "file") != python
            or checked(saved.get("root", ""), "dir") != runtime):
        raise ValueError("Managed runtime receipt does not match the fixed environment")
    environment = saved.get("environment", {})
    packages = {entry["package"]: entry["version"] for entry in manifest["files"] if entry["kind"] == "wheel"}
    if (environment.get("cudaAvailable") is not True or environment.get("bf16Supported") is not True
            or environment.get("cudaRuntime") != manifest["cuda"]
            or environment.get("packages") != packages):
        raise ValueError("Managed runtime receipt lacks its verified CUDA/BF16 package environment")
    return python, site, manifest, packages


def wheel_members(archive, version):
    entries = archive.infolist()
    if len(entries) > MAX_ENTRIES or sum(entry.file_size for entry in entries) > MAX_UNPACKED:
        raise ValueError("PixAI timm wheel exceeds bounded extraction limits")
    prefix = f"timm-{version}.dist-info"
    files, directories, names = {}, set(), set()
    for entry in entries:
        raw = entry.filename[:-1] if entry.is_dir() else entry.filename
        parts = raw.split("/")
        if (not raw or raw.startswith("/") or "\\" in raw or ":" in raw
                or any(part in ("", ".", "..") or part.endswith((".", " ")) for part in parts)
                or any(part.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *(f"COM{i}" for i in range(1, 10)), *(f"LPT{i}" for i in range(1, 10))} for part in parts)):
            raise ValueError(f"Unsafe wheel path: {entry.filename}")
        folded = raw.casefold()
        if folded in names:
            raise ValueError(f"Duplicate wheel path: {entry.filename}")
        names.add(folded)
        mode = stat.S_IFMT(entry.external_attr >> 16)
        if mode not in (0, stat.S_IFDIR if entry.is_dir() else stat.S_IFREG) or entry.flag_bits & 1:
            raise ValueError(f"Wheel contains a link/special/encrypted entry: {entry.filename}")
        if parts[0] not in ("timm", prefix) or entry.file_size > MAX_MEMBER or raw.lower().endswith(".pth"):
            raise ValueError(f"Wheel contains an unsupported package entry: {entry.filename}")
        for index in range(1, len(parts)):
            directories.add("/".join(parts[:index]))
        if entry.is_dir():
            directories.add(raw)
        else:
            files[raw] = entry
    if ({name.casefold() for name in files} & {name.casefold() for name in directories}
            or "timm/__init__.py" not in files or f"{prefix}/METADATA" not in files):
        raise ValueError("PixAI timm wheel package layout is invalid")
    metadata = BytesParser().parsebytes(archive.read(files[f"{prefix}/METADATA"]))
    if metadata["Name"].lower() != "timm" or metadata["Version"] != version:
        raise ValueError("PixAI timm wheel package/version metadata does not match")
    return files, directories


def inventory(root, files, directories, owner, candidate):
    if read_json(root / OWNER) != owner:
        raise ValueError(f"Existing dependency directory is not owned by this PixAI preparation: {root}")
    allowed = set(files) | {OWNER}
    if candidate:
        allowed.update(name + PARTIAL for name in files)
    for folder, children, leaves in os.walk(root, followlinks=False):
        for name in children + leaves:
            path = checked(Path(folder) / name)
            relative = path.relative_to(root).as_posix()
            info = path.lstat()
            if stat.S_ISDIR(info.st_mode):
                if relative not in directories:
                    raise ValueError(f"Unowned dependency directory preserved: {relative}")
            elif not stat.S_ISREG(info.st_mode) or relative not in allowed:
                raise ValueError(f"Unowned dependency file preserved: {relative}")


def member_digest(archive, entry):
    checksum, count = hashlib.sha256(), 0
    with archive.open(entry) as source:
        while chunk := source.read(1024 * 1024):
            count += len(chunk)
            if count > entry.file_size or count > MAX_MEMBER:
                raise ValueError("Wheel member exceeds its bounded declared size")
            checksum.update(chunk)
    if count != entry.file_size:
        raise ValueError("Wheel member length differs from its declaration")
    return checksum.hexdigest()


def prepare_deps(root, wheel, manifest, digest):
    timm = manifest["timm"]
    parent = checked(root / "deps")
    parent.mkdir(exist_ok=True)
    name = f"timm-{timm['version']}-{timm['sha256'][:16]}"
    target, candidate = checked(parent / name), checked(parent / f".{name}.candidate")
    owner = {"schemaVersion": 1, "engine": "pixai", "wheelSha256": timm["sha256"]}
    with zipfile.ZipFile(wheel) as archive:
        files, directories = wheel_members(archive, timm["version"])
        if target.exists():
            checked(target, "dir")
            inventory(target, files, directories, owner, False)
            for relative, entry in files.items():
                file = checked(target / relative, "file")
                if file.stat().st_size != entry.file_size or digest(file) != member_digest(archive, entry):
                    raise ValueError("Published timm dependencies differ; existing files were preserved")
            return target
        if not candidate.exists():
            # Publish ownership with the empty candidate before writing package files.
            temporary = Path(tempfile.mkdtemp(prefix=f".{name}.new-", dir=parent))
            marker = temporary / OWNER
            with marker.open("x", encoding="utf-8") as output:
                json.dump(owner, output, separators=(",", ":"))
                output.flush()
                os.fsync(output.fileno())
            temporary.rename(candidate)
        checked(candidate, "dir")
        inventory(candidate, files, directories, owner, True)
        progress("离线准备 PixAI 私有 timm；复用已核验的候选文件")
        for relative, entry in files.items():
            file = checked(candidate / relative)
            expected = member_digest(archive, entry)
            if file.is_file() and file.stat().st_size == entry.file_size and digest(file) == expected:
                continue
            file.parent.mkdir(parents=True, exist_ok=True)
            partial = checked(file.with_name(file.name + PARTIAL))
            checksum, count = hashlib.sha256(), 0
            with archive.open(entry) as source, partial.open("wb") as output:
                while chunk := source.read(1024 * 1024):
                    count += len(chunk)
                    if count > entry.file_size or count > MAX_MEMBER:
                        raise ValueError("Wheel member exceeded its extraction limit")
                    checksum.update(chunk)
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            if count != entry.file_size or checksum.hexdigest() != expected:
                raise ValueError("Extracted timm member failed integrity verification")
            partial.replace(file)
        # A retry can retain a partial file whose final member was already published.
        for relative in files:
            partial = checked(candidate / (relative + PARTIAL))
            if partial.exists():
                partial.unlink()
        inventory(candidate, files, directories, owner, False)
        if digest(wheel) != timm["sha256"]:
            raise ValueError("PixAI timm wheel changed during extraction")
        candidate.rename(target)
    return checked(target, "dir")


def diagnose(site, deps, manifest, packages, timm_version):
    os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                      HF_HUB_DISABLE_PROGRESS_BARS="1", TOKENIZERS_PARALLELISM="false", PYTHONNOUSERSITE="1")
    sys.path[:0] = [str(deps), str(site)]
    with contextlib.redirect_stdout(sys.stderr):
        import torch
        import torchvision
        import timm
        import numpy
        import PIL
        import safetensors
        from timm.layers import DropPath, trunc_normal_
        from transformers import BaseImageProcessor, Pipeline, PretrainedConfig, PreTrainedModel, TensorType
        for module, expected_root in ((torch, site), (torchvision, site), (timm, deps), (numpy, site), (PIL, site), (safetensors, site)):
            if not checked(module.__file__, "file").is_relative_to(expected_root):
                raise ValueError(f"Dependency imported outside its managed directory: {module.__name__}")
        for package, expected in {**packages, "timm": timm_version}.items():
            if importlib.metadata.version(package) != expected:
                raise ValueError(f"Dependency version differs from fixed environment: {package}")
        cuda = torch.cuda.is_available()
        capability = list(torch.cuda.get_device_capability()) if cuda else []
        architectures = torch.cuda.get_arch_list() if cuda else []
        bf16 = bool(cuda and torch.cuda.is_bf16_supported(including_emulation=False))
        supported = any(name.startswith("sm_") and name[3:].isdigit()
                        and int(name[3:]) // 10 == capability[0] and int(name[3:]) % 10 <= capability[1]
                        for name in architectures) if cuda else False
        supported = supported or (any(name.startswith("compute_") and name[8:].isdigit()
                                     and int(name[8:]) <= capability[0] * 10 + capability[1]
                                     for name in architectures) if cuda else False)
        if not cuda or not bf16 or not supported or torch.version.cuda != manifest["cuda"]:
            raise ValueError(f"PixAI requires native CUDA/BF16 support: cudaAvailable={cuda}, bf16Supported={bf16}, cudaRuntime={torch.version.cuda}, SM={capability}")
    return {"pythonVersion": sys.version.split()[0], "packages": {**packages, "timm": timm_version},
            "torchVersion": torch.__version__, "timmVersion": timm_version, "cpuOnly": False,
            "cudaAvailable": True, "bf16Supported": True, "cudaRuntime": torch.version.cuda,
            "deviceCapability": capability, "compiledArchitectures": architectures,
            "deviceName": torch.cuda.get_device_name(0),
            "scope": "dependency imports and CUDA/BF16 capability only; no model loaded or inference tensor allocated"}


def main():
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="strict")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--runtime-root", required=True, type=Path)
    args = parser.parse_args()
    app = checked(Path(__file__).absolute(), "file").parents[2]
    root, runtime = checked(args.root, "dir"), checked(args.runtime_root, "dir")
    digest = trusted_hasher(app)
    python, site, runtime_manifest, packages = runtime_binding(root, runtime, app, digest)
    source = checked(app / "tools/interrogate/pixai-manifest.json", "file")
    manifest = read_json(source)
    if len(manifest["files"]) != 5 or manifest["timm"]["version"] != "1.0.30":
        raise ValueError("Bundled PixAI manifest is outside the fixed model/dependency contract")
    model = checked(root / "model", "dir")
    for index, entry in enumerate(manifest["files"], 1):
        progress(f"核验 PixAI 文件 {index}/5：{entry['path']}")
        verify_file(model, entry, digest)
    wheel = verify_file(checked(root / "wheels", "dir"), manifest["timm"], digest)
    deps = prepare_deps(root, wheel, manifest, digest)
    progress("核验 PixAI 依赖导入、固定包版本与 CUDA/BF16；不加载模型")
    environment = diagnose(site, deps, runtime_manifest, packages, manifest["timm"]["version"])
    print(json.dumps({"ok": True, "schemaVersion": 1, "engine": "pixai", "python": str(python), "modelDir": str(model),
                      "depsDir": str(deps), "torchSitePackages": str(site), "environment": environment}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        progress(f"PixAI 准备失败：{error}")
        raise SystemExit(1)
