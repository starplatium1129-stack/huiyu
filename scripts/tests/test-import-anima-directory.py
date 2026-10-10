"""Importer fixtures use opaque fake weight bytes, never ML or real models.

Successful layout/copy checks deliberately do not establish inference readiness.
"""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
ENTRY = ROOT / "scripts/maintenance/import-anima-directory.py"
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("anima_import_test", ENTRY)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def write_json(path, value):
    path.write_text(json.dumps(value), encoding="utf-8")


def fixture(root):
    source, target = root / "source", root / "imported"
    source.mkdir()
    index = {"_class_name": "AnimaModularPipeline", "_blocks_class_name": "AnimaAutoBlocks"}
    for name, (library, classes) in module.CLASSES.items():
        folder = source / name
        folder.mkdir()
        index[name] = [library, sorted(classes)[0]]
        if name in module.WEIGHTS:
            write_json(folder / "config.json", {"_class_name": sorted(classes)[0]})
            (folder / "model.safetensors").write_bytes(b"fixture bytes, not tensor weights\x00\xff")
        elif name == "scheduler":
            write_json(folder / "scheduler_config.json", {"_class_name": "FlowMatchEulerDiscreteScheduler"})
        else:
            write_json(folder / "tokenizer_config.json", {"tokenizer_class": sorted(classes)[0]})
    write_json(source / "tokenizer/vocab.json", {"fixture": 0})
    (source / "tokenizer/merges.txt").write_text("# fixture\n", encoding="utf-8")
    write_json(source / "t5_tokenizer/tokenizer.json", {"fixture": True})
    write_json(source / "model_index.json", index)
    return source, target


def file_bytes(root):
    return {p.relative_to(root).as_posix(): p.read_bytes() for p in root.rglob("*") if p.is_file()}


class ImportTests(unittest.TestCase):
    def test_cli_plan_is_stdlib_only_and_does_not_create_missing_parent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            source, _ = fixture(root)
            target = root / "missing/models/anima"
            before = file_bytes(source)
            result = subprocess.run([sys.executable, "-I", "-S", "-B", str(ENTRY), "--source-dir", str(source),
                                     "--target-dir", str(target)], capture_output=True, text=True, check=True)
            report = json.loads(result.stdout)
            self.assertTrue(report["ok"])
            self.assertTrue(report["planOnly"])
            self.assertEqual(report["scope"], "layout-only")
            self.assertFalse(report["readyForInference"])
            self.assertFalse(report["published"])
            self.assertFalse(report["copyVerified"])
            self.assertFalse(report["targetParentExists"])
            self.assertFalse((root / "missing").exists())
            self.assertEqual(report["fileCount"], len(before))
            self.assertEqual(report["totalBytes"], sum(map(len, before.values())))
            self.assertEqual(file_bytes(source), before)
            self.assertEqual(list(root.iterdir()), [source])

    def test_apply_streams_copies_and_publishes_only_complete_verified_layout(self):
        with tempfile.TemporaryDirectory() as directory:
            source, _ = fixture(Path(directory).resolve())
            target = source.parent / "new/models/imported"
            (source / "LICENSE.md").write_text("Fixture license; inert upstream metadata", encoding="utf-8")
            (source / "transformer/model.safetensors").write_bytes(b"F" * (module.CHUNK_BYTES * 2 + 17))
            (source / "transformer/model-2.safetensors").write_bytes(b"second fixture shard")
            write_json(source / "transformer/model.safetensors.index.json",
                       {"weight_map": {"fixture.a": "model.safetensors", "fixture.b": "model-2.safetensors"}})
            before, publish = file_bytes(source), module.publish
            source_stats = {name: (source / name).stat().st_mtime_ns for name in before}
            def check_publication(staged, destination):
                self.assertFalse(destination.exists())
                self.assertEqual(file_bytes(staged), before)
                return publish(staged, destination)
            with patch.object(module, "publish", side_effect=check_publication) as called:
                report = module.import_directory(str(source), str(target), apply=True)
            self.assertEqual(called.call_count, 1)
            self.assertFalse(report["planOnly"])
            self.assertTrue(report["published"])
            self.assertTrue(report["copyVerified"])
            self.assertFalse(report["readyForInference"])
            self.assertEqual(file_bytes(target), before)
            self.assertEqual(file_bytes(source), before)
            self.assertEqual({name: (source / name).stat().st_mtime_ns for name in before}, source_stats)
            self.assertEqual(sorted(p.name for p in source.parent.iterdir()), ["new", "source"])
            self.assertEqual(list(target.parent.iterdir()), [target])
            self.assertEqual(report["createdParentDirs"], [str(source.parent / "new"), str(target.parent)])

    def test_raw_incomplete_custom_quantized_and_external_assets_are_refused(self):
        cases = ("raw_file", "missing_component", "missing_shard", "custom", "quantized", "python", "calibration", "external", "wrong_class", "bad_mapping")
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                source, target = fixture(Path(directory).resolve())
                if case == "raw_file":
                    source = source / "transformer/model.safetensors"
                elif case == "missing_component":
                    (source / "vae/model.safetensors").unlink()
                elif case == "missing_shard":
                    write_json(source / "transformer/model.safetensors.index.json", {"weight_map": {"x": "missing.safetensors"}})
                elif case == "custom":
                    write_json(source / "t5_tokenizer/tokenizer_config.json", {"auto_map": {"AutoTokenizer": "custom.Custom"}})
                elif case == "quantized":
                    write_json(source / "transformer/config.json", {"quantization_config": {"bits": 4}})
                elif case in {"python", "calibration"}:
                    (source / ("modeling_custom.py" if case == "python" else "teacache-profile.json")).write_text("{}")
                elif case == "external":
                    write_json(source / "tokenizer/tokenizer_config.json", {"vocab_file": "../../other.json"})
                elif case == "wrong_class":
                    write_json(source / "transformer/config.json", {"_class_name": "Unknown"})
                else:
                    write_json(source / "model_index.json", {"_class_name": "AnimaModularPipeline", "vae": ["diffusers", []]})
                with self.assertRaises(module.ImportFailure):
                    module.import_directory(str(source), str(target), apply=True)
                self.assertFalse(target.exists())
                self.assertFalse(list(target.parent.glob(".imported.import-*")))

    def test_symlinks_in_source_tree_and_either_ancestry_are_refused(self):
        cases = ("weight", "broken", "source_parent", "target_parent")
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                source, target = fixture(root)
                link = root / "alias"
                try:
                    link.symlink_to(root, target_is_directory=True)
                except OSError as error:
                    self.skipTest(f"Host cannot create symlink fixture: {error}")
                if case in {"weight", "broken"}:
                    path = source / "transformer/model.safetensors"
                    original = root / "original.safetensors"
                    path.rename(original)
                    path.symlink_to(original if case == "weight" else root / "missing.safetensors")
                elif case == "source_parent":
                    source = link / "source"
                else:
                    target = link / "target"
                with self.assertRaisesRegex(module.ImportFailure, "Symlinks"):
                    module.import_directory(str(source), str(target), apply=True)
                self.assertFalse(target.exists())

    def test_existing_overlapping_and_relative_targets_preserve_source(self):
        cases = ("empty", "populated", "inside_source", "contains_source", "relative")
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                root = Path(directory).resolve()
                source, target = fixture(root)
                if case in {"empty", "populated"}:
                    target.mkdir()
                    if case == "populated":
                        (target / "keep.txt").write_text("keep")
                elif case == "inside_source":
                    target = source / "missing/parents/nested"
                elif case == "contains_source":
                    target = root
                else:
                    target = Path("relative-import-target")
                before = file_bytes(source)
                with self.assertRaises(module.ImportFailure):
                    module.import_directory(str(source), str(target), apply=True)
                self.assertEqual(file_bytes(source), before)
                if case == "inside_source":
                    self.assertFalse((source / "missing").exists())
                if case == "populated":
                    self.assertEqual((target / "keep.txt").read_text(), "keep")

    def test_source_drift_refuses_publication_and_reports_retained_staging(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = fixture(Path(directory).resolve())
            original, changed = module.digest_file, False
            def mutate_after_copy(path, expected, destination=None):
                nonlocal changed
                result = original(path, expected, destination)
                if destination is not None and not changed:
                    changed = True
                    info = path.stat()
                    path.write_bytes(b"X" * info.st_size)
                    os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns))
                return result
            with patch.object(module, "digest_file", side_effect=mutate_after_copy):
                with self.assertRaises(module.ImportFailure) as failure:
                    module.import_directory(str(source), str(target), apply=True)
            self.assertEqual(failure.exception.code, "SOURCE_CHANGED")
            self.assertFalse(target.exists())
            self.assertTrue(Path(failure.exception.temporary_dir).is_dir())

    def test_cancel_during_copy_never_publishes_target(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = fixture(Path(directory).resolve())
            before = file_bytes(source)
            with patch.object(module, "digest_file", side_effect=KeyboardInterrupt):
                with self.assertRaises(module.ImportFailure) as failure:
                    module.import_directory(str(source), str(target), apply=True)
            self.assertEqual(failure.exception.code, "CANCELLED")
            self.assertFalse(target.exists())
            self.assertTrue(Path(failure.exception.temporary_dir).is_dir())
            self.assertEqual(file_bytes(source), before)

    def test_atomic_publish_never_replaces_racing_empty_target(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = fixture(Path(directory).resolve())
            original, identity = module.publish, []
            def race(staged, destination):
                destination.mkdir()
                identity.append(destination.stat().st_ino)
                original(staged, destination)
            with patch.object(module, "publish", side_effect=race):
                with self.assertRaises(module.ImportFailure) as failure:
                    module.import_directory(str(source), str(target), apply=True)
            self.assertEqual(target.stat().st_ino, identity[0])
            self.assertEqual(list(target.iterdir()), [])
            self.assertTrue(Path(failure.exception.temporary_dir).is_dir())


if __name__ == "__main__":
    unittest.main()
