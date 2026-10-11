"""Adversarial auto-selection cases; fake ML only, no device or model calls."""
import copy
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

from PIL import Image
import teacache_profile as profiles
import worker
from test_teacache_anima import modules, profile
from test_worker import model, job


class AutoTeaAdversarialTests(unittest.TestCase):
    def test_foreign_scopes_and_unaccepted_profiles_cannot_enable_auto(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "teacache-profile.json"
            scope = {"loras": [{"sha256": "nene", "strength": .8}], "sampling": {"steps": 24}}
            accepted = profile(scope)
            for mutation in ("lora", "strength", "steps", "runtime", "unaccepted"):
                candidate = copy.deepcopy(accepted)
                if mutation == "lora":
                    candidate["compatibility"]["loras"][0]["sha256"] = "natsume"
                elif mutation == "strength":
                    candidate["compatibility"]["loras"][0]["strength"] = 1
                elif mutation == "steps":
                    candidate["compatibility"]["sampling"]["steps"] = 30
                elif mutation == "runtime":
                    candidate["runtime"] = {**candidate["runtime"], "execution": "foreign"}
                else:
                    candidate.pop("acceptance")
                path.write_text(json.dumps(candidate))
                with self.subTest(mutation=mutation):
                    self.assertIsNone(profiles.read_profile(str(path), root, scope, auto=True))
                    with self.assertRaises(profiles.TeaCacheError):
                        profiles.read_profile(str(path), root, scope)
            path.write_text(json.dumps(accepted))
            self.assertEqual(profiles.read_profile(str(path), root, scope, auto=True), accepted)
            self.assertIsNone(profiles.read_profile(None, root, scope, auto=True))

    def test_auto_does_not_hide_corrupt_duplicate_or_escaped_profiles(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "model"
            root.mkdir()
            path = root / "teacache-profile.json"
            accepted = profile({"scope": "exact"})
            for mutation in ("nan", "acceptance", "digest", "duplicate", "json"):
                candidate = copy.deepcopy(accepted)
                if mutation == "nan":
                    candidate["coefficients"] = [float("nan")]
                elif mutation == "acceptance":
                    candidate["acceptance"] = None
                elif mutation == "digest":
                    candidate["acceptance"]["reportSha256"] = "forged"
                elif mutation == "duplicate":
                    candidate = dict(schemaVersion=1, kind=profiles.PROFILE_SET_KIND, profiles=[candidate, candidate])
                path.write_text("broken{" if mutation == "json" else json.dumps(candidate))
                with self.subTest(mutation=mutation), self.assertRaises(profiles.TeaCacheError):
                    profiles.read_profile(str(path), root, accepted["compatibility"], auto=True)
            escaped = root.parent / "foreign.json"
            escaped.write_text(json.dumps(accepted))
            with self.assertRaises(profiles.TeaCacheError):
                profiles.read_profile(str(escaped), root, accepted["compatibility"], auto=True)

    def test_auto_marker_cannot_override_disable_or_explicit_threshold(self):
        for data in ({"teaCache": False, "teaCacheAuto": True},
                     {"teaCache": True, "teaCacheAuto": "true"},
                     {"teaCache": True, "teaCacheAuto": True, "teaCacheThresh": .1}):
            with self.subTest(data=data), self.assertRaises(worker.WorkerError):
                worker.validate_job({"id": "adversarial", "op": "generate", "input": {"prompt": "test", **data}})

    def test_worker_does_not_misreport_mismatch_or_ignore_manual_disable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = model(Path(directory))
            request = job(root)
            request["input"].update(teaCache=True, teaCacheAuto=True)
            data = worker.validate_job(request)
            scope = profiles.compatibility(root, [], data, "txt2img", "torch.bfloat16", "fake CUDA")
            path = root / "teacache-profile.json"
            pipeline = types.SimpleNamespace(scheduler=types.SimpleNamespace(step=lambda: None))
            with patch.dict("sys.modules", modules()), patch.object(worker, "dependencies"), \
                 patch.object(worker, "load_pipeline", return_value=pipeline), \
                 patch.object(worker.load_mask_tools("anima_prompt_weights"), "apply_prompt_weights", side_effect=lambda blocks, **_: blocks), \
                 patch.object(worker.load_mask_tools("anima_refinement"), "run", return_value=(Image.new("RGB", (16, 16)), 2,
                     dict(compositeWallSeconds=0, postprocessWallSeconds=0))):
                for scenario in ("missing", "foreign", "matched", "disabled"):
                    if scenario != "missing":
                        path.write_text(json.dumps(profile({"foreign": True} if scenario == "foreign" else scope)))
                        request["teaCacheProfilePath"] = str(path)
                    if scenario == "disabled":
                        request["input"].update(teaCache=False, teaCacheAuto=False)
                        request.pop("teaCacheProfilePath")
                    stream = io.StringIO()
                    with self.subTest(scenario=scenario):
                        worker.generate(request, stream)
                        result = json.loads(stream.getvalue().splitlines()[-1])
                        actual = result["nativeRuntime"]["teaCache"]
                        self.assertEqual(actual["enabled"], scenario == "matched")
                        self.assertEqual(actual["reason"], "matched-profile" if scenario == "matched" else
                                         "request-disabled" if scenario == "disabled" else "no-matching-profile")


if __name__ == "__main__":
    unittest.main()
