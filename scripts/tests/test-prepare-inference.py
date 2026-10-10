"""Focused preparation contract: plan never installs; existing runtimes preserved."""
import argparse
import importlib.util
import json
import pathlib
import tempfile
import unittest
import zipfile
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("prepare", pathlib.Path(__file__).parents[1] / "maintenance/prepare-inference.py")
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class PreparationTests(unittest.TestCase):
    def wheels(self, directory, dependency=""):
        wheelhouse = pathlib.Path(directory) / "wheels"
        wheelhouse.mkdir()
        wheel = wheelhouse / "fixture-1.0-py3-none-any.whl"
        with zipfile.ZipFile(wheel, "w") as archive:
            archive.writestr("fixture-1.0.dist-info/METADATA", "Metadata-Version: 2.1\nName: fixture\nVersion: 1.0\n" + dependency)
        return wheelhouse, wheel

    def test_default_plan_has_no_writes_or_processes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary) / "inference"
            with patch.object(prepare, "run", side_effect=AssertionError("unexpected process")):
                plan = prepare.prepare(argparse.Namespace(target_dir=str(root), apply=False, check=False))
            self.assertTrue(plan["planOnly"])
            self.assertFalse(plan["downloads"])
            self.assertFalse(root.exists())
            self.assertNotIn("ComfyUI", plan["python"])

    def test_apply_requires_explicit_offline_wheels(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaisesRegex(ValueError, "requires --wheelhouse"):
                prepare.prepare(argparse.Namespace(target_dir=temporary, apply=True, check=False, wheelhouse=None))

    def test_apply_preserves_existing_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / "venv").mkdir()
            with patch.object(prepare, "run", side_effect=AssertionError("unexpected install")):
                with self.assertRaisesRegex(ValueError, "already exists"):
                    prepare.prepare(argparse.Namespace(target_dir=temporary, apply=True, check=False, wheelhouse=temporary))
            self.assertTrue((root / "venv").is_dir())

    def test_preflight_resolves_only_inspected_local_wheels_without_creating_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary) / "runtime"
            wheelhouse, wheel = self.wheels(temporary)
            (wheelhouse / "links.html").write_text('<a href="https://example.invalid/pkg.whl">remote</a>')
            with patch.object(prepare, "run", return_value="Would install fixture") as call:
                result = prepare.prepare(argparse.Namespace(target_dir=str(root), apply=False, check=False,
                                                            preflight=True, wheelhouse=str(wheelhouse)))
            command = call.call_args.args[0]
            for flag in ("--dry-run", "--ignore-installed", "--no-index", "--no-cache-dir", "--only-binary=:all:"):
                self.assertIn(flag, command)
            self.assertEqual(command[command.index("--find-links") + 1], str(wheel))
            self.assertNotIn(str(wheelhouse), command)
            self.assertTrue(result["preflightOnly"])
            self.assertFalse(root.exists())
            self.assertEqual(call.call_count, 1)

    def test_missing_transitive_wheel_fails_before_apply_creates_venv(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary) / "runtime"
            wheelhouse, _ = self.wheels(temporary)
            with patch.object(prepare, "run", side_effect=ValueError("No matching distribution for dependency")) as call:
                with self.assertRaisesRegex(ValueError, "No matching distribution"):
                    prepare.prepare(argparse.Namespace(target_dir=str(root), apply=True, check=False, wheelhouse=str(wheelhouse)))
            self.assertEqual(call.call_count, 1)
            self.assertIn("--dry-run", call.call_args.args[0])
            self.assertFalse(root.exists())

    def test_direct_url_wheel_dependency_is_rejected_before_pip(self):
        with tempfile.TemporaryDirectory() as temporary:
            wheelhouse, _ = self.wheels(temporary, "Requires-Dist: external @ https://example.invalid/pkg.whl\n")
            with patch.object(prepare, "run", side_effect=AssertionError("network-capable pip must not run")):
                with self.assertRaisesRegex(ValueError, "direct-URL"):
                    prepare.prepare(argparse.Namespace(target_dir=temporary, apply=False, check=False,
                                                        preflight=True, wheelhouse=str(wheelhouse)))

    def test_resolved_wheel_cannot_be_passed_as_an_html_link_page(self):
        with tempfile.TemporaryDirectory() as temporary:
            wheelhouse, wheel = self.wheels(temporary)
            # Simulate a resolved alias without requiring Windows symlink privileges.
            with patch.object(pathlib.Path, "resolve", return_value=wheelhouse / "links.html"):
                with self.assertRaisesRegex(ValueError, "must remain a .whl"):
                    prepare.offline_wheels(wheelhouse)

    def test_apply_and_check_use_complete_worker_diagnostic_before_receipt(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary) / "runtime"
            wheelhouse, _ = self.wheels(temporary)
            pins = prepare.read_pins(prepare.APP / "tools/inference/requirements.txt")
            diagnostic = json.dumps({"event": "diagnostic", "valid": True, "dependencies": pins,
                                     "cudaAvailable": False, "deviceName": None, "scope": "imports-only"})
            with patch.object(prepare, "run", side_effect=["Would install", "", "", diagnostic]) as call:
                result = prepare.prepare(argparse.Namespace(target_dir=str(root), apply=True, check=False, wheelhouse=str(wheelhouse)))
            calls = [c.args[0] for c in call.call_args_list]
            self.assertIn("--dry-run", calls[0])
            self.assertIn("venv", calls[1])
            self.assertNotIn("--dry-run", calls[2])
            self.assertEqual(calls[3][-2:], [str(prepare.APP / "tools/inference/worker.py"), "--diagnose"])
            self.assertFalse(result["environment"]["cudaAvailable"])
            receipt = root / "runtime-config.json"
            saved = receipt.read_bytes()
            with patch.object(prepare, "run", return_value=diagnostic) as call:
                checked = prepare.prepare(argparse.Namespace(target_dir=str(root), apply=False, check=True))
            self.assertTrue(checked["checkedOnly"])
            self.assertEqual(call.call_count, 1)
            self.assertEqual(receipt.read_bytes(), saved)
            with patch.object(prepare, "run", return_value=json.dumps({"event": "error", "code": "RUNTIME_INCOMPLETE"})):
                with self.assertRaisesRegex(ValueError, "successful dependency diagnostic"):
                    prepare.prepare(argparse.Namespace(target_dir=str(root), apply=False, check=True))
            self.assertEqual(receipt.read_bytes(), saved)


if __name__ == "__main__":
    unittest.main()
