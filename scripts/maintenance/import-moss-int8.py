"""Import the pinned author MOSS INT8 checkpoint into an existing model.

Standard library only; --apply is required. Source files and the existing FP16
checkpoint are preserved. Run while the desktop/native workers are closed.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile


def ordinary_path(value):
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts:
        raise ValueError("Use an absolute path without parent traversal")
    for part in (path, *path.parents):
        if part.exists() or part.is_symlink():
            info = part.lstat()
            if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                raise ValueError(f"Linked/reparse paths are unsupported: {part}")
    return path


def transfer(source, destination, expected, *, copy):
    digest = hashlib.sha256()
    total = 0
    with source.open("rb") as stream:
        while chunk := stream.read(8 * 1024**2):
            total += len(chunk)
            if total > expected["bytes"]:
                raise ValueError("Checkpoint grew during import")
            digest.update(chunk)
            if copy:
                destination.write(chunk)
    if total != expected["bytes"] or digest.hexdigest() != expected["sha256"]:
        raise ValueError("Checkpoint does not match the author's BASE v1.0 INT8 SHA-256")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    helper_path = Path(__file__).resolve().parents[2] / "tools/inference/moss_int8.py"
    module_spec = importlib.util.spec_from_file_location("huiyu_moss_int8_import", helper_path)
    helper = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(helper)
    source, root = ordinary_path(args.source), ordinary_path(args.model_dir)
    if not source.is_file() or source.stat().st_size != helper.SPEC["bytes"]:
        raise ValueError("Select the complete author BASE v1.0 INT8 safetensors file")
    identity = json.loads((ordinary_path(str(root / "huiyu-model.json"))).read_text(encoding="utf-8"))
    index = json.loads((ordinary_path(str(root / "model_index.json"))).read_text(encoding="utf-8"))
    if (not isinstance(identity, dict) or not isinstance(index, dict)
            or identity.get("modelId") != helper.MODEL_ID or index.get("_class_name") != "MOSSImagePipeline"):
        raise ValueError("Target must be the existing prepared MiaoMiao MOSS BASE v1.0 model")
    target = ordinary_path(str(root / helper.SPEC["path"]))
    marker = ordinary_path(str(root / helper.RECEIPT))
    if not target.parent.is_dir() or not target.resolve().is_relative_to(root.resolve()):
        raise ValueError("Target transformer directory is unavailable")
    print(f"Author INT8: {source}\nModel target: {target}")
    if not args.apply:
        print("Preview only; --apply verifies SHA-256 while copying and publishes the selection receipt")
        return
    lock_path = root / ".moss-int8-import.lock"
    lock = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    temporary = receipt_temp = None
    try:
        if target.exists():
            if not target.is_file():
                raise ValueError("Existing target is not a regular file")
            # Recover a previously published file whose receipt was interrupted;
            # unknown or changed bytes are never overwritten.
            transfer(target, None, helper.SPEC, copy=False)
        else:
            if shutil.disk_usage(root).free < helper.SPEC["bytes"] + 64 * 1024**2:
                raise ValueError("Not enough free space for the INT8 checkpoint")
            with tempfile.NamedTemporaryFile(dir=target.parent, prefix=".moss-int8-", delete=False) as output:
                temporary = Path(output.name)
                transfer(source, output, helper.SPEC, copy=True)
                output.flush()
                os.fsync(output.fileno())
            ordinary_path(str(target))
            # Windows rename refuses an existing target, including a racing
            # writer. Nothing replaces the author's FP16 or download source.
            temporary.rename(target)
            temporary = None
        with tempfile.NamedTemporaryFile(dir=root, prefix=".moss-int8-receipt-", delete=False) as output:
            receipt_temp = Path(output.name)
            output.write((json.dumps(helper.receipt_document(), ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
            output.flush()
            os.fsync(output.fileno())
        ordinary_path(str(marker))
        os.replace(receipt_temp, marker)
        receipt_temp = None
        print(f"Imported and SHA-256 verified: {target}")
    finally:
        os.close(lock)
        lock_path.unlink(missing_ok=True)
        for item in (temporary, receipt_temp):
            if item is not None:
                item.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError) as error:
        raise SystemExit(str(error))
