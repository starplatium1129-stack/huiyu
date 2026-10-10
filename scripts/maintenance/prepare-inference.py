"""Prepare Huiyu's isolated native inference runtime; never download weights/packages.

Default is a read-only plan. --apply requires a complete trusted local wheelhouse.
This maintainer entry does not replace shipping a platform-specific Python runtime.
"""
from __future__ import annotations

import argparse
from email.parser import BytesParser
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import zipfile

APP = Path(__file__).resolve().parents[2]
def run(args: list[str]) -> str:
    env = os.environ.copy()
    for key in ["PYTHONPATH", "PYTHONHOME", "PIP_EXTRA_INDEX_URL", "PIP_INDEX_URL", "PIP_FIND_LINKS"]:
        env.pop(key, None)
    env.update(PYTHONNOUSERSITE="1", HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", PIP_CONFIG_FILE=os.devnull)
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    if result.returncode:
        detail = (result.stderr + "\n" + result.stdout).strip()[-16000:]
        raise ValueError(f"Local runtime command failed ({result.returncode}): {detail}")
    return result.stdout


def paths(root: Path) -> tuple[Path, Path]:
    return root / "venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python"), root / "runtime-config.json"


def read_pins(requirements: Path) -> dict:
    pins = {}
    for line in requirements.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*==[A-Za-z0-9][A-Za-z0-9.+!-]*", line):
            raise ValueError(f"Preparation requires exact package pins: {line}")
        package, version = line.split("==", 1)
        pins[package] = version
    if not pins:
        raise ValueError("Pinned requirements are empty")
    return pins


def inspect(python: Path, requirements: Path, worker: Path) -> dict:
    pins = read_pins(requirements)
    diagnostic = json.loads(run([str(python), "-I", "-B", "-u", str(worker), "--diagnose"]))
    if (not isinstance(diagnostic, dict) or diagnostic.get("event") != "diagnostic"
            or diagnostic.get("valid") is not True or not isinstance(diagnostic.get("dependencies"), dict)):
        raise ValueError("Worker did not return a successful dependency diagnostic")
    environment = {"packages": diagnostic["dependencies"], "cudaAvailable": diagnostic.get("cudaAvailable"),
                   "deviceName": diagnostic.get("deviceName"), "scope": diagnostic.get("scope")}
    for package, version in pins.items():
        actual = environment["packages"].get(package)
        # CUDA wheels use PEP 440 local version labels; base release must match.
        if not isinstance(actual, str) or actual.split("+", 1)[0] != version:
            raise ValueError(f"Runtime dependency mismatch: {package}: expected {version}, got {actual}")
    return environment


def offline_wheels(wheelhouse: Path) -> list[Path]:
    wheels = sorted(path.resolve() for path in wheelhouse.glob("*.whl") if path.is_file())
    if not wheels:
        raise ValueError("Wheelhouse contains no local .whl files")
    for wheel in wheels:
        if wheel.suffix.lower() != ".whl":
            raise ValueError(f"Resolved wheel target must remain a .whl archive: {wheel.name}")
        # --no-index alone still permits direct-URL Requires-Dist entries.
        # Read metadata only; never import wheel code or extract an archive.
        try:
            with zipfile.ZipFile(wheel) as archive:
                metadata = [entry for entry in archive.infolist() if entry.filename.endswith(".dist-info/METADATA")]
                if len(metadata) != 1 or metadata[0].file_size > 8 * 1024 * 1024:
                    raise ValueError(f"Invalid/bounded wheel metadata: {wheel.name}")
                message = BytesParser().parsebytes(archive.read(metadata[0]))
                if any("@" in requirement for requirement in message.get_all("Requires-Dist", [])):
                    raise ValueError(f"Offline wheel has a direct-URL dependency: {wheel.name}")
        except zipfile.BadZipFile as exc:
            raise ValueError(f"Invalid wheel archive: {wheel.name}") from exc
    return wheels


def pip_command(python: Path, requirements: Path, wheels: list[Path], dry_run=False) -> list[str]:
    # Pass only inspected archives, not a directory which may contain HTML links.
    command = [str(python), "-I", "-B", "-m", "pip", "--isolated", "install", "--disable-pip-version-check",
               "--no-cache-dir", "--no-index", "--only-binary=:all:"]
    if dry_run:
        command.extend(["--dry-run", "--ignore-installed"])
    for wheel in wheels:
        command.extend(["--find-links", str(wheel)])
    command.extend([f"{name}=={version}" for name, version in read_pins(requirements).items()])
    return command


def preflight(requirements: Path, wheels: list[Path]) -> dict:
    # Requires pip with --dry-run support in the chosen trusted base Python.
    # This resolver check completes before any managed runtime is created.
    output = run(pip_command(Path(sys.executable), requirements, wheels, dry_run=True))
    return {"python": sys.executable, "wheelCount": len(wheels), "resolverOutput": output[-16000:],
            "scope": "offline-resolution-only; no installation, imports, models or CUDA validation"}


def prepare(args: argparse.Namespace) -> dict:
    root = Path(args.target_dir).absolute()
    python, receipt = paths(root)
    worker = APP / "tools/inference/worker.py"
    requirements = APP / "tools/inference/requirements.txt"
    plan = {"engine": "native", "root": str(root), "python": str(python), "worker": str(worker),
            "modelRoot": str(root / "models"), "requirements": str(requirements),
            "downloads": False, "inference": "not performed", "changesComfyUI": False}
    preview = getattr(args, "preflight", False)
    if not args.apply and not args.check and not preview:
        return {"planOnly": True, **plan}
    # Refuse filesystem aliases before creating the managed runtime.
    if any(parent.is_symlink() for parent in [root, *root.parents]):
        raise ValueError("Managed inference directory must not traverse symlinks")
    if args.apply or preview:
        if not args.wheelhouse:
            raise ValueError("--apply/--preflight requires --wheelhouse with trusted compatible wheels; no network fallback")
        wheelhouse = Path(args.wheelhouse).resolve(strict=True)
        if not wheelhouse.is_dir():
            raise ValueError("Wheelhouse is not a directory")
        # Never overwrite or mutate a previous/partial runtime. User can select a new target.
        if args.apply and ((root / "venv").exists() or receipt.exists()):
            raise ValueError("Runtime already exists; use --check or select a new target directory")
        if not worker.is_file() or not requirements.is_file():
            raise ValueError("Native inference worker or pinned requirements are missing")
        wheels = offline_wheels(wheelhouse)
        resolution = preflight(requirements, wheels)
        if preview:
            return {"ok": True, "preflightOnly": True, "preflight": resolution, **plan}
        root.mkdir(parents=True, exist_ok=True)
        run([sys.executable, "-I", "-m", "venv", str(root / "venv")])
        run(pip_command(python, requirements, wheels))
    environment = inspect(python, requirements, worker)
    document = {"schemaVersion": 1, **plan, "environment": environment,
                "requirementsSha256": hashlib.sha256(requirements.read_bytes()).hexdigest()}
    if args.check:
        saved = json.loads(receipt.read_text(encoding="utf-8"))
        for key in ["schemaVersion", "engine", "python", "worker", "requirementsSha256"]:
            if saved.get(key) != document[key]:
                raise ValueError(f"Saved runtime receipt differs: {key}")
        return {"ok": True, "checkedOnly": True, **document}
    (root / "models").mkdir(exist_ok=True)
    (root / "loras").mkdir(exist_ok=True)
    temporary = receipt.with_suffix(".tmp")
    with temporary.open("x", encoding="utf-8") as output:
        json.dump(document, output, ensure_ascii=False, indent=2)
        output.write("\n")
    os.replace(temporary, receipt)
    return {"ok": True, "receipt": str(receipt), **document}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-dir", required=True, help="AI_WORKSPACE_ROOT/inference")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--plan", action="store_true", help="read-only (default)")
    action.add_argument("--check", action="store_true", help="check installed dependencies; no inference/install")
    action.add_argument("--preflight", action="store_true", help="resolve local wheels with base pip; no runtime created or installed")
    action.add_argument("--apply", action="store_true", help="create isolated venv from this Python and local wheels")
    parser.add_argument("--wheelhouse", help="trusted, platform-compatible offline wheel directory")
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args), ensure_ascii=False, indent=2))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f"Native runtime preparation failed: {error}", file=sys.stderr)
        raise SystemExit(1)


if __name__ == "__main__":
    main()
