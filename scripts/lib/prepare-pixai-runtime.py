"""Prepare pinned PixAI files and private timm using the managed Windows Python.

Rust downloads and owns activation. This helper has no pip/network/model execution.
"""
from __future__ import annotations

import argparse
from email.parser import BytesParser
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


def model_file(root, entry):
    relative = PurePosixPath(entry["path"])
    if len(relative.parts) != 1 or relative.name != entry["path"] or ":" in relative.name or "\\" in relative.name:
        raise ValueError("Pinned PixAI manifest contains an invalid filename")
    target = checked(root / relative.name, "file")
    before = target.stat()
    if before.st_size != entry["bytes"]:
        raise ValueError(f"PixAI fixed file integrity mismatch: {relative.name}")
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
    packages = {entry["package"]: entry["version"] for entry in manifest["files"] if entry["kind"] in ("wheel", "python-source")}
    if (environment.get("cudaAvailable") is not True or environment.get("bf16Supported") is not True
            or environment.get("cudaRuntime") != manifest["cuda"]
            or environment.get("packages") != packages):
        raise ValueError("Managed runtime receipt lacks its verified CUDA/BF16 package environment")
    return python, site, packages, environment


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


def prepare_deps(root, wheel, manifest):
    timm = manifest["timm"]
    parent = checked(root / "deps")
    parent.mkdir(exist_ok=True)
    name = f"timm-{timm['version']}-{timm['sha256'][:16]}"
    target, candidate = checked(parent / name), checked(parent / f".{name}.candidate")
    owner = {"schemaVersion": 1, "engine": "pixai", "wheelSha256": timm["sha256"]}
    if target.exists():
        checked(target, "dir")
        if read_json(target / OWNER) != owner:
            raise ValueError("Published timm installation belongs to another version")
        return target
    with zipfile.ZipFile(wheel) as archive:
        files, _ = wheel_members(archive, timm["version"])
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
        if read_json(candidate / OWNER) != owner:
            raise ValueError("Candidate timm installation belongs to another version")
        progress("离线准备 PixAI 私有 timm")
        for relative, entry in files.items():
            file = checked(candidate / relative)
            partial = checked(file.with_name(file.name + PARTIAL))
            if file.is_file() and file.stat().st_size == entry.file_size:
                if partial.exists():
                    partial.unlink()
                continue
            file.parent.mkdir(parents=True, exist_ok=True)
            count = 0
            with archive.open(entry) as source, partial.open("wb") as output:
                while chunk := source.read(1024 * 1024):
                    count += len(chunk)
                    if count > entry.file_size or count > MAX_MEMBER:
                        raise ValueError("Wheel member exceeded its extraction limit")
                    output.write(chunk)
            if count != entry.file_size:
                raise ValueError("Extracted timm member is incomplete")
            partial.replace(file)
        candidate.rename(target)
    return checked(target, "dir")


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
    python, site, packages, runtime_environment = runtime_binding(root, runtime, app, digest)
    source = checked(app / "tools/interrogate/pixai-manifest.json", "file")
    manifest = read_json(source)
    if len(manifest["files"]) != 5 or manifest["timm"]["version"] != "1.0.30":
        raise ValueError("Bundled PixAI manifest is outside the fixed model/dependency contract")
    model = checked(root / "model", "dir")
    for entry in manifest["files"]:
        model_file(model, entry)
    wheel = model_file(checked(root / "wheels", "dir"), manifest["timm"])
    deps = prepare_deps(root, wheel, manifest)
    environment = {**runtime_environment, "packages": {**packages, "timm": manifest["timm"]["version"]},
                   "timmVersion": manifest["timm"]["version"], "cpuOnly": False,
                   "scope": "managed-runtime-receipt-and-local-timm-installation"}
    print(json.dumps({"ok": True, "schemaVersion": 1, "engine": "pixai", "python": str(python), "modelDir": str(model),
                      "depsDir": str(deps), "torchSitePackages": str(site), "environment": environment}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        progress(f"PixAI 准备失败：{error}")
        raise SystemExit(1)
