"""Import a pinned MOSS INT8 transformer or paired text encoder.

Standard library only; --apply is required. Source files and the existing FP16
checkpoint are preserved. Run while the desktop/native workers are closed.
--reuse-from prepares a new registered version from verified shared components.
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
        raise ValueError("Checkpoint does not match the pinned INT8 SHA-256")


def publish_document(path, value):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=".moss-receipt-", delete=False) as output:
            temporary = Path(output.name)
            output.write((json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
            output.flush()
            os.fsync(output.fileno())
        ordinary_path(str(path))
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def reuse_components(source, root, model_id, helper):
    manifest = json.loads((Path(__file__).resolve().parents[2] / "tools/inference/managed-adapter-models.json").read_text(encoding="utf-8"))
    prepared = next(item for item in manifest["models"] if item["id"] == model_id)
    source_identity = json.loads(ordinary_path(str(source / "huiyu-model.json")).read_text(encoding="utf-8"))
    if source_identity.get("modelId") not in helper.MODELS or source == root or root.is_relative_to(source) or source.is_relative_to(root):
        raise ValueError("Reuse source must be a separate prepared MOSS model directory")
    checkpoint = helper.component_spec(model_id)
    root.mkdir(parents=True, exist_ok=True)
    for item in prepared["files"]:
        if item["path"] == checkpoint["path"]:
            continue
        origin, target = ordinary_path(str(source / item["path"])), ordinary_path(str(root / item["path"]))
        target.parent.mkdir(parents=True, exist_ok=True)
        transfer(target if target.exists() else origin, None, item, copy=False)
        if not target.exists():
            try:
                os.link(origin, target)
            except OSError:
                shutil.copy2(origin, target)
    # The paired text encoder is shared, but its receipt belongs to the new version.
    text_spec = helper.component_spec(model_id, "text_encoder")
    text_source = ordinary_path(str(source / text_spec["path"]))
    if text_source.is_file():
        target = ordinary_path(str(root / text_spec["path"]))
        transfer(target if target.exists() else text_source, None, text_spec, copy=False)
        if not target.exists():
            try:
                os.link(text_source, target)
            except OSError:
                shutil.copy2(text_source, target)
        publish_document(root / helper.TEXT_RECEIPT, helper.receipt_document(model_id, "text_encoder"))
    return prepared


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--model-id", help="Registered target version; inferred from an existing model when omitted")
    parser.add_argument("--reuse-from", help="Reuse and hash-verify shared components from a prepared MOSS directory")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--component", choices=("transformer", "text_encoder"), default="transformer")
    args = parser.parse_args()
    helper_path = Path(__file__).resolve().parents[2] / "tools/inference/moss_int8.py"
    module_spec = importlib.util.spec_from_file_location("huiyu_moss_int8_import", helper_path)
    helper = importlib.util.module_from_spec(module_spec)
    module_spec.loader.exec_module(helper)
    source, root = ordinary_path(args.source), ordinary_path(args.model_dir)
    identity_path = ordinary_path(str(root / "huiyu-model.json"))
    identity = json.loads(identity_path.read_text(encoding="utf-8")) if identity_path.is_file() else {}
    if not isinstance(identity, dict):
        raise ValueError("Invalid MOSS model identity record")
    model_id = args.model_id or identity.get("modelId")
    expected = helper.component_spec(model_id, args.component)
    if identity and identity.get("modelId") != model_id:
        raise ValueError("Existing model identity differs from the selected version")
    if not source.is_file() or source.stat().st_size != expected["bytes"]:
        raise ValueError("Select the complete pinned INT8 safetensors file for this component")
    reuse = ordinary_path(args.reuse_from) if args.reuse_from else None
    if reuse and args.component != "transformer":
        raise ValueError("Prepare a new version by importing its transformer first")
    if not identity and not reuse:
        raise ValueError("Target must be a prepared MOSS model, or specify --model-id and --reuse-from")
    target = ordinary_path(str(root / expected["path"]))
    marker = ordinary_path(str(root / (helper.TEXT_RECEIPT if args.component == "text_encoder" else helper.RECEIPT)))
    if not target.resolve().is_relative_to(root.resolve()) or not reuse and not target.parent.is_dir():
        raise ValueError("Target component directory is unavailable")
    print(f"INT8 component: {args.component}\nSource: {source}\nModel target: {target}")
    if not args.apply:
        print("Preview only; --apply verifies SHA-256 while copying and publishes the selection receipt")
        return
    if reuse:
        root.mkdir(parents=True, exist_ok=True)
    lock_path = root / ".moss-int8-import.lock"
    lock = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    temporary = receipt_temp = None
    try:
        prepared = reuse_components(reuse, root, model_id, helper) if reuse else None
        index = json.loads(ordinary_path(str(root / "model_index.json")).read_text(encoding="utf-8"))
        if not isinstance(index, dict) or index.get("_class_name") != "MOSSImagePipeline":
            raise ValueError("Target must use the registered MOSSImagePipeline")
        if target.exists():
            if not target.is_file():
                raise ValueError("Existing target is not a regular file")
            # Recover a previously published file whose receipt was interrupted;
            # unknown or changed bytes are never overwritten.
            transfer(target, None, expected, copy=False)
        else:
            if shutil.disk_usage(root).free < expected["bytes"] + 64 * 1024**2:
                raise ValueError("Not enough free space for the INT8 checkpoint")
            with tempfile.NamedTemporaryFile(dir=target.parent, prefix=".moss-int8-", delete=False) as output:
                temporary = Path(output.name)
                transfer(source, output, expected, copy=True)
                output.flush()
                os.fsync(output.fileno())
            ordinary_path(str(target))
            # Windows rename refuses an existing target, including a racing
            # writer. Nothing replaces the author's FP16 or download source.
            temporary.rename(target)
            temporary = None
        with tempfile.NamedTemporaryFile(dir=root, prefix=".moss-int8-receipt-", delete=False) as output:
            receipt_temp = Path(output.name)
            output.write((json.dumps(helper.receipt_document(model_id, args.component), ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
            output.flush()
            os.fsync(output.fileno())
        ordinary_path(str(marker))
        os.replace(receipt_temp, marker)
        receipt_temp = None
        if prepared:
            publish_document(identity_path, dict(schemaVersion=1, modelId=model_id,
                revision=prepared["revision"], scope="downloaded-files-sha256", readyForGeneration=False))
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
