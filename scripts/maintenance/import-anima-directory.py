"""Offline import of a complete local Anima Diffusers directory.

Read-only plan by default; --apply copies into a fresh target. This checks layout
and copy integrity only, never tensor semantics, dependencies, GPU or inference.
No packages, model code, installation or downloads are used.
"""
from __future__ import annotations

import argparse
import ctypes
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import stat
import sys
import tempfile

sys.dont_write_bytecode = True
APP = Path(__file__).resolve().parents[2]
CHUNK_BYTES = 1024 * 1024
MAX_JSON_BYTES = 32 * 1024 * 1024
MAX_FILES = 10000
INDEXES = {"model_index.json", "modular_model_index.json"}
CLASSES = {"transformer": ("diffusers", {"CosmosTransformer3DModel"}),
           "text_conditioner": ("diffusers", {"AnimaTextConditioner"}),
           "text_encoder": ("transformers", {"Qwen3Model"}),
           "vae": ("diffusers", {"AutoencoderKLQwenImage"}),
           "tokenizer": ("transformers", {"Qwen2Tokenizer", "Qwen2TokenizerFast"}),
           "t5_tokenizer": ("transformers", {"T5Tokenizer", "T5TokenizerFast"}),
           "scheduler": ("diffusers", {"FlowMatchEulerDiscreteScheduler"})}
WEIGHTS = {"transformer", "text_conditioner", "text_encoder", "vae"}
ROOT_FILES = INDEXES | {"README.md", "LICENSE", "LICENSE.txt", "LICENSE.md", "NOTICE", ".gitattributes", "conversion.json"}
TOKENIZER_FILES = {"tokenizer_config.json", "tokenizer.json", "special_tokens_map.json", "added_tokens.json",
                   "vocab.json", "merges.txt", "spiece.model", "config.json", "chat_template.jinja"}


class ImportFailure(ValueError):
    def __init__(self, code, message, temporary_dir=None, created_parents=None):
        super().__init__(message)
        self.code, self.temporary_dir = code, temporary_dir
        self.created_parents = created_parents or []


def reject(code, message):
    raise ImportFailure(code, message)


def file_state(info):
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def no_links(path):
    # lstat, not resolve: even a broken symlink or Windows junction is forbidden.
    for part in reversed((path, *path.parents)):
        try:
            info = part.lstat()
        except FileNotFoundError:
            continue
        if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
            reject("UNSAFE_PATH", f"Symlinks/reparse points are unsupported: {part}")


def absolute_path(value):
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts:
        reject("UNSAFE_PATH", "Use absolute paths without '..' components")
    no_links(path)
    return path


def validate_paths(source, target):
    source, target = absolute_path(source), absolute_path(target)
    if source == target or source in target.parents or target in source.parents:
        reject("OVERLAPPING_PATHS", "Source and target must not overlap")
    if not source.is_dir():
        reject("MODEL_INCOMPLETE", "Source must be a complete Anima Diffusers directory. Raw weights require convert-anima-checkpoint.py with its explicit supported profile and assets.")
    if os.path.lexists(target):
        reject("TARGET_EXISTS", "Target already exists; select a fresh directory (nothing will be overwritten)")
    return source, target


def create_parents(target, created):
    # Only called after source/layout/overlap validation. Reserve each missing
    # directory separately and never clean up pre-existing or racing directories.
    missing, parent = [], target.parent
    while not os.path.lexists(parent):
        missing.append(parent)
        parent = parent.parent
    no_links(parent)
    if not parent.is_dir():
        reject("UNSAFE_PATH", f"Target ancestor is not a directory: {parent}")
    for folder in reversed(missing):
        no_links(folder)
        try:
            folder.mkdir()
            created.append(str(folder))
        except FileExistsError:
            no_links(folder)
            if not folder.is_dir():
                reject("UNSAFE_PATH", f"Target ancestor is not a directory: {folder}")


def allowed_file(relative):
    parts = relative.parts
    if len(parts) == 1:
        return parts[0] in ROOT_FILES
    if len(parts) != 2:
        return False
    component, name = parts
    if component in WEIGHTS:
        return name == "config.json" or name.endswith(".safetensors") or name.endswith(".safetensors.index.json")
    if component in {"tokenizer", "t5_tokenizer"}:
        return name in TOKENIZER_FILES
    return component == "scheduler" and name == "scheduler_config.json"


def inventory(root):
    no_links(root)
    entries, files = {".": file_state(root.lstat())}, {}
    for folder in [root, *(root / name for name in sorted(CLASSES))]:
        if not folder.is_dir():
            reject("MODEL_INCOMPLETE", f"Missing component directory: {folder.name}")
        no_links(folder)
        with os.scandir(folder) as children:
            for child in children:
                path = Path(child.path)
                relative = path.relative_to(root)
                info = child.stat(follow_symlinks=False)
                if stat.S_ISLNK(info.st_mode) or getattr(info, "st_file_attributes", 0) & 0x400:
                    reject("UNSAFE_PATH", f"Symlinks/reparse points are unsupported: {relative}")
                if stat.S_ISDIR(info.st_mode):
                    if len(relative.parts) != 1 or child.name not in CLASSES:
                        reject("UNSUPPORTED_MODEL", f"Unsupported directory: {relative}")
                elif not stat.S_ISREG(info.st_mode) or not allowed_file(relative):
                    reject("UNSUPPORTED_MODEL", f"Unsupported file/layout: {relative}; raw weights require the strict converter")
                else:
                    files[relative.as_posix()] = file_state(info)
                entries[relative.as_posix()] = file_state(info)
                if len(entries) > MAX_FILES:
                    reject("MODEL_INVALID", f"Too many model entries (limit {MAX_FILES})")
    return entries, files


def open_checked(path, expected):
    no_links(path)
    if file_state(path.lstat()) != expected:
        reject("SOURCE_CHANGED", f"File changed: {path}")
    fd = os.open(path, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode) or file_state(os.fstat(fd)) != expected:
            reject("SOURCE_CHANGED", f"File changed while opening: {path}")
        return os.fdopen(fd, "rb")
    except BaseException:
        os.close(fd)
        raise


def read_config(path, expected):
    if expected[3] > MAX_JSON_BYTES:
        reject("MODEL_INVALID", f"Configuration exceeds {MAX_JSON_BYTES} bytes: {path}")
    with open_checked(path, expected) as source:
        data = source.read(MAX_JSON_BYTES + 1)
        if file_state(os.fstat(source.fileno())) != expected:
            reject("SOURCE_CHANGED", f"Configuration changed: {path}")
    try:
        value = json.loads(data)
        if not isinstance(value, dict):
            raise ValueError("expected object")
        return value
    except (ValueError, UnicodeError) as error:
        reject("MODEL_INVALID", f"Invalid JSON configuration {path}: {error}")


def safe_fields(value):
    if isinstance(value, dict):
        forbidden = {"auto_map", "quantization_config", "quant_method", "load_in_4bit", "load_in_8bit",
                     "custom_pipeline", "custom_revision", "trust_remote_code"}
        if forbidden.intersection(value):
            reject("UNSUPPORTED_MODEL", "Custom-code and quantized configurations are unsupported")
        for item in value.values():
            safe_fields(item)
    elif isinstance(value, list):
        for item in value:
            safe_fields(item)


def validate_layout(root, files):
    if not INDEXES.intersection(files):
        reject("MODEL_INCOMPLETE", "Missing Anima pipeline index; raw weights require convert-anima-checkpoint.py with the supported profile and assets")
    for name, expected in files.items():
        path = root / name
        if not (path.name.endswith("config.json") or path.name in INDEXES or path.name.endswith(".safetensors.index.json")):
            continue
        config = read_config(path, expected)
        safe_fields(config)
        if name in INDEXES:
            if config.get("_class_name") != "AnimaModularPipeline" or config.get("_blocks_class_name", "AnimaAutoBlocks") != "AnimaAutoBlocks":
                reject("UNSUPPORTED_MODEL", "Only the bundled AnimaModularPipeline layout is supported")
            for key, value in config.items():
                if key in CLASSES:
                    library, classes = CLASSES[key]
                    if not isinstance(value, list) or len(value) != 2 or value[0] != library or not isinstance(value[1], str) or value[1] not in classes:
                        reject("UNSUPPORTED_MODEL", f"Unsupported model-index component: {key}")
                elif key not in {"_class_name", "_blocks_class_name", "_diffusers_version", "_name_or_path"}:
                    reject("UNSUPPORTED_MODEL", f"Unsupported model-index field: {key}")
        elif path.name == "tokenizer_config.json":
            classes = CLASSES[path.parent.name][1]
            if config.get("tokenizer_class") is not None and config["tokenizer_class"] not in tuple(classes):
                reject("UNSUPPORTED_MODEL", "Unsupported tokenizer class")
            refs = {"vocab_file": "vocab.json" if path.parent.name == "tokenizer" else "spiece.model",
                    "merges_file": "merges.txt", "tokenizer_file": "tokenizer.json"}
            for key, filename in refs.items():
                if config.get(key) not in (None, filename):
                    reject("UNSUPPORTED_MODEL", f"External tokenizer reference: {key}")
                if config.get(key) is not None and f"{path.parent.name}/{filename}" not in files:
                    reject("MODEL_INCOMPLETE", f"Missing referenced tokenizer asset: {filename}")
            if "fast_tokenizer_files" in config and config["fast_tokenizer_files"] != ["tokenizer.json"]:
                reject("UNSUPPORTED_MODEL", "Only local tokenizer.json is supported")
        elif path.name == "config.json" and path.parent.name in WEIGHTS:
            if config.get("_class_name") is not None and config["_class_name"] not in tuple(CLASSES[path.parent.name][1]):
                reject("UNSUPPORTED_MODEL", f"Unsupported component class: {path.parent.name}")
    # Load only shipped code. validate_model uses stdlib and does not import ML.
    spec = importlib.util.spec_from_file_location("huiyu_import_layout", APP / "tools/inference/worker.py")
    worker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(worker)
    try:
        worker.validate_model(str(root))
    except worker.WorkerError as error:
        reject(error.code, str(error))
    except (ValueError, TypeError) as error:
        reject("MODEL_INVALID", f"Invalid model layout: {error}")


def digest_file(path, expected, destination=None):
    digest, remaining = hashlib.sha256(), expected[3]
    with open_checked(path, expected) as source:
        while remaining:
            chunk = source.read(min(CHUNK_BYTES, remaining))
            if not chunk:
                reject("SOURCE_CHANGED", f"File truncated: {path}")
            digest.update(chunk)
            if destination is not None:
                destination.write(chunk)
            remaining -= len(chunk)
        if source.read(1) or file_state(os.fstat(source.fileno())) != expected:
            reject("SOURCE_CHANGED", f"File changed during read: {path}")
    return digest.hexdigest()


def publish(staged, target):
    """Atomic directory rename with NOREPLACE; never fall back to os.replace."""
    no_links(staged)
    no_links(target)
    if os.name == "nt":
        # Windows rename fails if any target exists, including an empty directory.
        os.rename(staged, target)
        return
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform.startswith("linux") and hasattr(libc, "renameat2"):
        rename = libc.renameat2
        rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
        result = rename(-100, os.fsencode(staged), -100, os.fsencode(target), 1)  # RENAME_NOREPLACE
    elif sys.platform == "darwin" and hasattr(libc, "renamex_np"):
        rename = libc.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        result = rename(os.fsencode(staged), os.fsencode(target), 4)  # RENAME_EXCL
    else:
        reject("ATOMIC_PUBLISH_UNAVAILABLE", "This platform lacks supported atomic no-replace directory publication")
    if result:
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error), str(target))


def import_directory(source_dir, target_dir, apply=False):
    source, target = validate_paths(source_dir, target_dir)
    before, files = inventory(source)
    validate_layout(source, files)
    if inventory(source)[0] != before:
        reject("SOURCE_CHANGED", "Source changed during layout inspection")
    report = dict(ok=True, planOnly=not apply, sourceDir=str(source), targetDir=str(target),
                  scope="layout-only", readyForInference=False, fileCount=len(files),
                  totalBytes=sum(info[3] for info in files.values()), published=False,
                  targetParentExists=target.parent.is_dir(), downloads=False, copyVerified=False,
                  validation="layout only; tensor content, shapes, dependencies and device not validated")
    if not apply:
        return report
    staged, created = None, []
    try:
        validate_paths(str(source), str(target))
        create_parents(target, created)
        no_links(target.parent)
        parent_identity = file_state(target.parent.lstat())[:2]
        staged = Path(tempfile.mkdtemp(prefix=f".{target.name}.import-", dir=target.parent))
        for name in CLASSES:
            (staged / name).mkdir()
        hashes = {}
        # The staging directory is hidden and never selected as the target model.
        for name, expected in sorted(files.items(), key=lambda item: (item[0] in INDEXES, item[0])):
            with (staged / name).open("xb") as destination:
                hashes[name] = digest_file(source / name, expected, destination)
                destination.flush()
                os.fsync(destination.fileno())
        _, saved_files = inventory(staged)
        validate_layout(staged, saved_files)
        if set(saved_files) != set(files):
            reject("COPY_MISMATCH", "Staged inventory differs from source")
        for name, expected in files.items():
            if digest_file(staged / name, saved_files[name]) != hashes[name]:
                reject("COPY_MISMATCH", f"Staged SHA-256 differs: {name}")
            if digest_file(source / name, expected) != hashes[name]:
                reject("SOURCE_CHANGED", f"Source SHA-256 changed: {name}")
        if inventory(source)[0] != before:
            reject("SOURCE_CHANGED", "Source inventory changed during copy")
        validate_paths(str(source), str(target))
        if file_state(target.parent.lstat())[:2] != parent_identity:
            reject("UNSAFE_PATH", "Target parent changed during import")
        publish(staged, target)
        return {**report, "published": True, "copyVerified": True, "targetParentExists": True,
                "createdParentDirs": created, "verification": "SHA-256 copied bytes and source recheck"}
    except (OSError, ValueError, KeyboardInterrupt) as error:
        code = "CANCELLED" if isinstance(error, KeyboardInterrupt) else getattr(error, "code", "IMPORT_FAILED")
        message = "Import cancelled before completion" if isinstance(error, KeyboardInterrupt) else str(error)
        raise ImportFailure(code, message, str(staged) if staged is not None and staged.exists() else None, created) from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-dir", required=True)
    parser.add_argument("--target-dir", required=True)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--plan", action="store_true", help="read-only plan (default)")
    action.add_argument("--apply", action="store_true", help="explicitly copy and publish to a fresh target")
    args = parser.parse_args()
    def cancelled(_signum, _frame):
        raise KeyboardInterrupt
    signal.signal(signal.SIGTERM, cancelled)
    try:
        print(json.dumps(import_directory(args.source_dir, args.target_dir, args.apply), ensure_ascii=False))
        return 0
    except (OSError, ValueError, KeyboardInterrupt) as error:
        report = dict(ok=False, scope="layout-only", readyForInference=False,
                      error={"code": "CANCELLED" if isinstance(error, KeyboardInterrupt) else getattr(error, "code", "IMPORT_FAILED"),
                             "message": str(error) or "Import cancelled"})
        if getattr(error, "temporary_dir", None):
            report["temporaryDir"] = error.temporary_dir
        if getattr(error, "created_parents", None):
            report["createdParentDirs"] = error.created_parents
        if "temporaryDir" in report or "createdParentDirs" in report:
            report["cleanup"] = "Temporary copy/new parent directories retained for inspection; source and existing targets were not deleted"
        print(json.dumps(report, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
