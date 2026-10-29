"""Install only verified, fixed Windows wheels into an application owned runtime.

Called by prepare-native-runtime.ps1 using the downloaded embedded CPython.
No pip, network, system interpreter, model loading or image generation.
"""
from __future__ import annotations

import argparse
from email.parser import BytesParser
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import zipfile


def progress(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def digest(path: Path) -> str:
    checksum = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            checksum.update(chunk)
    return checksum.hexdigest()


def safe_file(root: Path, relative: str) -> Path:
    name = PurePosixPath(relative)
    if name.is_absolute() or any(part in ("", ".", "..") or ":" in part or "\\" in part for part in name.parts):
        raise ValueError(f"Unsafe archive path: {relative}")
    target = root.joinpath(*name.parts)
    if not target.resolve().is_relative_to(root.resolve()):
        raise ValueError(f"Archive path leaves runtime: {relative}")
    return target


def install_wheel(file: dict, cache: Path, root: Path, remaining: int) -> int:
    archive_path = cache / file["filename"]
    if archive_path.stat().st_size != file["bytes"]:
        raise ValueError(f"Downloaded wheel integrity mismatch: {file['filename']}")
    site = root / "venv/Lib/site-packages"
    with zipfile.ZipFile(archive_path) as archive:
        total = sum(entry.file_size for entry in archive.infolist())
        installed = announced = 0
        metadata_files = [entry for entry in archive.infolist() if entry.filename.endswith(".dist-info/METADATA")]
        if len(metadata_files) != 1 or metadata_files[0].file_size > 8 * 1024 * 1024:
            raise ValueError(f"Invalid wheel metadata: {file['filename']}")
        raw_metadata = archive.read(metadata_files[0])
        if hashlib.sha256(raw_metadata).hexdigest() != file["metadataSha256"]:
            raise ValueError(f"Wheel metadata differs from fixed publisher metadata: {file['filename']}")
        metadata = BytesParser().parsebytes(raw_metadata)
        if metadata["Version"] != file["version"]:
            raise ValueError(f"Wheel version mismatch: {file['filename']}")
        for entry in archive.infolist():
            if entry.is_dir():
                continue
            if stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError(f"Wheel contains a filesystem link: {entry.filename}")
            remaining -= entry.file_size
            if remaining < 0:
                raise ValueError("Fixed runtime archive exceeds the reserved extraction space")
            parts = PurePosixPath(entry.filename).parts
            if not parts:
                raise ValueError("Empty archive member")
            relative = entry.filename
            destination = site
            if parts[0].endswith(".data"):
                if len(parts) < 3:
                    raise ValueError(f"Invalid wheel data path: {entry.filename}")
                scheme = parts[1]
                relative = "/".join(parts[2:])
                if scheme in ("purelib", "platlib"):
                    destination = site
                elif scheme == "data":
                    destination = root / "venv"
                elif scheme == "headers":
                    destination = root / "venv/Include" / file["package"]
                elif scheme == "scripts":
                    # Product execution uses Python + bundled source, never wheel CLI wrappers.
                    continue
                else:
                    raise ValueError(f"Unsupported wheel data scheme: {scheme}")
            target = safe_file(destination, relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(entry) as source, target.open("xb") as output:
                while chunk := source.read(1024 * 1024):
                    output.write(chunk)
                    installed += len(chunk)
                    if installed - announced >= 128 * 1024 * 1024:
                        progress(f"解包 {file['package']}：{installed * 100 // total}% ({installed // 1024 ** 2}/{total // 1024 ** 2} MiB)")
                        announced = installed
    return remaining


def install_diffusers_source(file: dict, cache: Path, root: Path, remaining: int) -> int:
    """Copy the reviewed pure-Python package; never execute archive setup hooks."""
    archive_path = cache / file["filename"]
    if file["package"] != "diffusers" or archive_path.stat().st_size != file["bytes"]:
        raise ValueError("Fixed Diffusers source archive differs")
    site = root / "venv/Lib/site-packages"
    prefix = f"diffusers-{file['revision']}/src/"
    info = site / f"diffusers-{file['version']}.dist-info"
    info.mkdir()
    count = 0
    with zipfile.ZipFile(archive_path) as archive:
        for entry in archive.infolist():
            if entry.is_dir() or not entry.filename.startswith(prefix + "diffusers/"):
                continue
            if stat.S_ISLNK(entry.external_attr >> 16):
                raise ValueError("Source archive contains a link")
            remaining -= entry.file_size
            if remaining < 0:
                raise ValueError("Source archive exceeds extraction budget")
            target = safe_file(site, entry.filename.removeprefix(prefix))
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive.open(entry) as source, target.open("xb") as output:
                while chunk := source.read(1024 * 1024): output.write(chunk)
            count += 1
        (info / "LICENSE").write_bytes(archive.read(f"diffusers-{file['revision']}/LICENSE"))
    if count == 0: raise ValueError("Source archive has no Diffusers package")
    metadata = f"Metadata-Version: 2.3\nName: diffusers\nVersion: {file['version']}\nLicense-Expression: Apache-2.0\nRequires-Python: >=3.11\n"
    metadata += "".join(f"Requires-Dist: {dependency}\n" for dependency in file["requiresDist"])
    (info / "METADATA").write_text(metadata + "\n", encoding="utf-8")
    (info / "direct_url.json").write_text(json.dumps({"url": file["repository"],
        "vcs_info": {"vcs": "git", "commit_id": file["revision"]}}), encoding="utf-8")
    (info / "INSTALLER").write_text("huiyu-fixed-source\n", encoding="utf-8")
    return remaining


def diagnose(root: Path, manifest: dict) -> dict:
    expected_python = root / "venv/Scripts/python.exe"
    if Path(sys.executable).resolve() != expected_python.resolve():
        raise ValueError("Preparation must use the selected application managed Python")
    if sys.version_info[:3] != tuple(int(part) for part in manifest["pythonVersion"].split(".")):
        raise ValueError("Managed Python version differs from the fixed runtime")
    packages = {}
    for file in manifest["files"]:
        if file["kind"] in ("wheel", "python-source"):
            actual = importlib.metadata.version(file["package"])
            if actual != file["version"]:
                raise ValueError(f"Installed dependency differs: {file['package']} expected {file['version']}, found {actual}")
            packages[file["package"]] = actual
    import torch
    if not torch.cuda.is_available():
        raise ValueError("NVIDIA CUDA unavailable")
    if torch.version.cuda != manifest["cuda"]:
        raise ValueError(f"Expected CUDA {manifest['cuda']} PyTorch wheel; found {torch.version.cuda}")
    capability = torch.cuda.get_device_capability()
    architectures = torch.cuda.get_arch_list()
    supported = any(architecture.startswith("sm_") and architecture[3:].isdigit()
                    and int(architecture[3:]) // 10 == capability[0]
                    and int(architecture[3:]) % 10 <= capability[1] for architecture in architectures)
    supported = supported or any(architecture.startswith("compute_") and architecture[8:].isdigit()
                                 and int(architecture[8:]) <= capability[0] * 10 + capability[1]
                                 for architecture in architectures)
    bf16 = torch.cuda.is_bf16_supported(including_emulation=False)
    if not supported or not bf16:
        raise ValueError(f"NVIDIA device SM {capability[0]}.{capability[1]} is outside this runtime's native BF16 support; compiled architectures: {architectures}")
    return {"packages": packages, "cudaAvailable": True, "deviceName": torch.cuda.get_device_name(),
            "cudaRuntime": torch.version.cuda, "deviceCapability": list(capability),
            "compiledArchitectures": architectures, "bf16Supported": bf16,
            "scope": "dependency imports and CUDA device capability; no model loaded, tensor allocated or image generated"}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True)
    parser.add_argument("--target-root", required=True)
    parser.add_argument("--cache-dir", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    root, target, cache = (Path(value).resolve() for value in (args.root, args.target_root, args.cache_dir))
    manifest_path = Path(args.manifest).resolve()
    manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
    if manifest["schemaVersion"] != 1 or manifest["platform"] != "win32-x64" or os.name != "nt":
        raise ValueError("This fixed runtime supports Windows x64 only")
    app = manifest_path.parents[2]
    adapter = manifest.get("worker") == "adapter_worker.py"
    worker = app / "tools/inference" / ("adapter_worker.py" if adapter else "worker.py")
    requirements = app / "tools/inference" / ("requirements-adapters.txt" if adapter else "requirements.txt")
    manifest_hash, requirements_hash = digest(manifest_path), digest(requirements)
    if args.check:
        saved = json.loads((root / "runtime-config.json").read_text(encoding="utf-8"))
        if (saved.get("managedRuntimeId") != manifest["runtimeId"] or saved.get("manifestSha256") != manifest_hash
                or saved.get("requirementsSha256") != requirements_hash or Path(saved.get("root", "")).resolve() != target
                or Path(saved.get("python", "")).resolve() != (target / "venv/Scripts/python.exe").resolve()):
            raise ValueError("Existing runtime record is incompatible; existing files have been preserved")
    else:
        remaining = manifest["requiredFreeBytes"] - manifest["downloadBytes"]
        wheels = [file for file in manifest["files"] if file["kind"] == "wheel"]
        for index, file in enumerate(wheels, 1):
            progress(f"安装依赖 {index}/{len(wheels)}：{file['package']} {file['version']}")
            remaining = install_wheel(file, cache, root, remaining)
        for file in manifest["files"]:
            if file["kind"] == "python-source":
                remaining = install_diffusers_source(file, cache, root, remaining)
    progress("校验全部固定依赖、NVIDIA CUDA、显卡架构与 BF16 支持；不加载模型")
    environment = diagnose(root, manifest)
    document = {"schemaVersion": 1, "engine": "native", "root": str(target),
                "python": str(target / "venv/Scripts/python.exe"), "worker": str(worker),
                "modelRoot": str(target.parent / "models"), "lorasRoot": str(target.parent / "loras"),
                "requirementsSha256": requirements_hash, "manifestSha256": manifest_hash,
                "managedRuntimeId": manifest["runtimeId"], "environment": environment}
    print(json.dumps(document, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, RuntimeError, zipfile.BadZipFile, importlib.metadata.PackageNotFoundError) as error:
        progress(f"原生运行库准备失败：{error}")
        raise SystemExit(1)
