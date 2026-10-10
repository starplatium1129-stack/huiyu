"""Offline calibration protocol tests. Synthetic traces/PNGs do not establish device quality or speed."""
import argparse
import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
ENTRY = ROOT / "scripts/maintenance/calibrate-anima-teacache.py"
spec = importlib.util.spec_from_file_location("calibration_test", ROOT / "tools/inference/teacache_calibration.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")


def fixture(root):
    model = root / "model"
    model.mkdir()
    (model / "model_index.json").write_text('{"_class_name":"AnimaModularPipeline"}')
    paths = []
    for index, prompt in enumerate(("calibration landscape", "held-out portrait")):
        job = {"id": f"source-{index}", "op": "generate", "modelDir": str(model),
               "outputPath": str(root / "must-not-touch.png"),
               "input": {"prompt": prompt, "seed": index + 10, "steps": 12, "width": 64, "height": 64}}
        path = root / f"job-{index}.json"
        module.write(path, job)
        paths.append(str(path))
    return argparse.Namespace(calibration_job=paths[:1], validation_job=paths[1:],
        output_dir=str(root / "run"), threshold=.05, degree=2, repeats=2, timeout=10,
        accept_run=str(root / "run"), accept_quality=True, accept_performance=True,
        replace_profile_sha256=None, strategy="polynomial", resident=False)


def trace_for(job):
    helper = module.load("teacache_profile")
    mode = "masked" if job.get("maskImagePath") else ("img2img" if job.get("inputImagePath") else "txt2img")
    scope = helper.compatibility(Path(job["modelDir"]), [], job["input"], mode, "torch.float16", "FAKE TEST DEVICE")
    return {"schemaVersion": 1, "compatibility": scope,
            "samples": [{"branch": 0, "step": i, "total": 13, "timestep": 20 - i,
                         "proxyRelativeL1": i / 100, "residualRelativeL1": .01 + 2 * i / 100 + 3 * (i / 100) ** 2}
                        for i in range(1, 13)],
            "stats": {"fullComputes": 12, "skippedComputes": 0, "skippedBlocks": 0, "resets": 0, "nonfinite": 0}}


def fake_profile(traces, args):
    return {"schemaVersion": 1, "algorithm": module.ALGORITHM,
            "runtime": {"diffusers": "0.41.0", "torch": "2.8.0"},
            "compatibility": traces[0]["compatibility"], "coefficients": [.01, 2, 3],
            "proxyRange": [.01, .12], "defaultThreshold": .05, "maxThreshold": .05,
            "maxConsecutiveSkips": 1, "calibration": {"source": "local-full-compute", "sampleCount": 12,
                                                      "traceSha256": module.canonical(traces)}}


class CalibrationTests(unittest.TestCase):
    def test_resident_child_disables_text_cache_for_fair_teacache_pairs(self):
        helper = module.load("resident_benchmark")
        calls, cleared = [], []
        resident = types.SimpleNamespace(clear=lambda: cleared.append(True))
        def generate(job, stream, **options):
            calls.append(options)
            return {"textCacheEnabled": False}
        worker = types.SimpleNamespace(generate=generate,
            load_mask_tools=lambda _: types.SimpleNamespace(PipelineCache=lambda: resident))
        with tempfile.TemporaryDirectory() as directory:
            request = Path(directory) / "request.json"
            module.write(request, {"job": {"id": "fixture"}, "collect": False, "profile": None})
            api = types.SimpleNamespace(load=lambda _: worker, read=module.read, write=module.write)
            with patch("sys.stdin", __import__('io').StringIO(json.dumps(str(request)) + "\n")), \
                    patch("sys.stdout", __import__('io').StringIO()):
                self.assertEqual(helper.child_session(api), 0)
            self.assertIs(calls[0]["resident"], resident)
            self.assertIs(calls[0]["cache_text"], False)
            self.assertEqual(cleared, [True])

    def test_resident_measurement_protocol_reuses_process_and_closes_owned_child(self):
        helper = module.load("resident_benchmark")
        original_popen = subprocess.Popen
        script = """import base64,json,os,sys
for line in sys.stdin:
    path=json.loads(line)
    request=json.load(open(path))
    output=request['job']['outputPath']
    open(output,'wb').write(base64.b64decode('PNG_DATA'))
    json.dump({'pid':os.getpid()},open(path.replace('request.json','worker-report.json'),'w'))
    print(json.dumps({'request':path,'done':True}),flush=True)
""".replace("PNG_DATA", base64.b64encode(PNG).decode())
        with tempfile.TemporaryDirectory() as directory:
            args = fixture(Path(directory))
            training, _, _, _ = module.plan(args)
            def launch(command, **kwargs):
                if "--_worker-session" not in command:
                    return original_popen(command, **kwargs)
                return original_popen([sys.executable, "-u", "-c", script], **kwargs)
            with patch.object(helper.subprocess, "Popen", side_effect=launch):
                session = helper.Session(module, Path(directory))
                try:
                    first = session.execute(training[0], Path(directory) / "first", False, None, 5)
                    second = session.execute(training[0], Path(directory) / "second", False, None, 5)
                    self.assertEqual(first["report"]["pid"], second["report"]["pid"])
                    self.assertNotEqual(first["output"], second["output"])
                finally:
                    session.close()
                    session.close()
            self.assertIsNotNone(session.process.poll())
            self.assertFalse(session.reader.is_alive())

    def test_phase_fitting_records_local_spikes_without_polynomial_smoothing(self):
        with tempfile.TemporaryDirectory() as directory:
            args = fixture(Path(directory))
            args.strategy = "phase-envelope"
            training, _, _, _ = module.plan(args)
            trace = trace_for(training[0])
            trace["samples"][4]["residualRelativeL1"] = .8
            value = module.fit([trace], args)
            self.assertEqual(value["schemaVersion"], 2)
            self.assertIn([.05, .8], value["phaseEnvelopes"][1])
            self.assertEqual(value["fitDiagnostics"]["phaseSampleCounts"], [3, 4, 5])
            module.load("teacache_profile").validate_profile(value, value["compatibility"], require_accepted=False)
            trace["samples"][4].pop("total")
            with self.assertRaisesRegex(ValueError, "step/total"):
                module.fit([trace], args)

    def test_default_plan_is_stdlib_only_no_writes_or_model_process(self):
        with tempfile.TemporaryDirectory() as directory:
            root, args = Path(directory), fixture(Path(directory))
            originals = {path: Path(path).read_bytes() for path in args.calibration_job + args.validation_job}
            command = [sys.executable, "-I", "-S", str(ENTRY), "--calibration-job", args.calibration_job[0],
                       "--validation-job", args.validation_job[0], "--output-dir", args.output_dir]
            result = subprocess.run(command, capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(result.stdout)["mode"], "plan")
            self.assertFalse(Path(args.output_dir).exists())
            self.assertFalse((root / "must-not-touch.png").exists())
            self.assertEqual(originals, {path: Path(path).read_bytes() for path in originals})

    def test_plan_rejects_training_leakage_scope_change_and_existing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            args = fixture(Path(directory))
            validation = Path(args.validation_job[0])
            job = module.read(validation)
            for field, value, message in (("seed", 10, "seeds"), ("prompt", "calibration landscape", "prompts"), ("cfg", 7, "scope")):
                changed = json.loads(json.dumps(job))
                changed["input"][field] = value
                validation.write_text(json.dumps(changed))
                with self.assertRaisesRegex(ValueError, message):
                    module.plan(args)
            validation.write_text(json.dumps(job))
            Path(args.output_dir).mkdir()
            with self.assertRaisesRegex(ValueError, "must be new"):
                module.plan(args)

    def test_fits_fresh_polynomial_and_rejects_skipped_or_rank_deficient_traces(self):
        try:
            import numpy  # numerical test only; CLI planning and protocol tests are stdlib
        except ImportError:
            self.skipTest("NumPy unavailable; polynomial fitting must be checked in prepared inference runtime")
        with tempfile.TemporaryDirectory() as directory:
            args = fixture(Path(directory))
            training, _, _, _ = module.plan(args)
            trace = trace_for(training[0])
            profile = module.fit([trace], args)
            for actual, expected in zip(profile["coefficients"], [.01, 2, 3]):
                self.assertAlmostEqual(actual, expected, places=8)
            self.assertNotIn("acceptance", profile)
            trace["stats"]["skippedComputes"] = 1
            with self.assertRaisesRegex(ValueError, "full-compute"):
                module.fit([trace], args)
            trace["stats"]["skippedComputes"] = 0
            for sample in trace["samples"]:
                sample["proxyRelativeL1"] = .1
            with self.assertRaisesRegex(ValueError, "full-rank"):
                module.fit([trace], args)

    def make_run(self, args, skips=2, cached_seconds=6):
        training, heldout, target, _ = module.plan(args)
        calls = []
        def fake_execute(job, folder, collect, profile, timeout):
            calls.append((job["input"]["seed"], collect, profile is not None))
            folder.mkdir()
            output = folder / "output.png"
            output.write_bytes(PNG)
            trace = trace_for(job)
            trace.update(teaCacheEnabled=profile is not None, pipelineSeconds=8, modelLoadSeconds=1,
                         modelReused=not collect, textCacheEnabled=False, fingerprintSeconds=.1 if collect or profile else 0)
            if not collect:
                trace["samples"] = []
            if profile:
                trace["samples"] = []
                trace["stats"]["skippedComputes"] = skips
                trace["stats"]["skippedBlocks"] = skips * 28
            return {"wallSeconds": cached_seconds if profile else 10, "output": str(output),
                    "outputSha256": module.digest(output), "report": trace}
        class Session:
            startup_seconds = .1
            def __init__(self, api, target): pass
            def execute(self, *args): return fake_execute(*args)
            def close(self): pass
        original_load = module.load
        def load(name):
            return types.SimpleNamespace(Session=Session) if name == "resident_benchmark" else original_load(name)
        with patch.object(module, "execute", side_effect=fake_execute), patch.object(module, "fit", side_effect=fake_profile), \
                patch.object(module, "load", side_effect=load), \
                patch.object(module, "pixels", return_value={"qualityVerdict": "requires-human-review"}):
            result = module.run(args, training, heldout, target)
        return result, calls

    def test_warm_comparison_records_reuse_and_acceptance_requires_both_sides(self):
        with tempfile.TemporaryDirectory() as directory:
            args = fixture(Path(directory))
            args.resident = True
            self.make_run(args)
            path = Path(args.output_dir) / "report.json"
            report = module.read(path)
            self.assertEqual(report["executionMode"], "resident")
            self.assertTrue(all(pair[name]["report"]["modelReused"] for pair in report["pairs"] for name in ("baseline", "cached")))
            report["pairs"][0]["baseline"]["report"]["modelReused"] = False
            path.write_text(json.dumps(report))
            with self.assertRaisesRegex(ValueError, "reuse evidence"):
                module.accept(args)
            report["pairs"][0]["baseline"]["report"]["modelReused"] = True
            report["pairs"][0]["baseline"]["report"]["textCacheEnabled"] = True
            path.write_text(json.dumps(report))
            with self.assertRaisesRegex(ValueError, "text-cache evidence"):
                module.accept(args)

    def test_synthetic_protocol_preserves_baseline_and_candidate_needs_explicit_acceptance(self):
        with tempfile.TemporaryDirectory() as directory:
            args = fixture(Path(directory))
            result, calls = self.make_run(args)
            self.assertFalse(result["installed"])
            self.assertEqual(calls, [(10, True, False), (11, False, False), (11, False, True),
                                     (11, False, True), (11, False, False)])
            candidate = module.read(Path(args.output_dir) / "candidate-profile.json")
            helper = module.load("teacache_profile")
            with self.assertRaisesRegex(ValueError, "acceptance"):
                helper.validate_profile(candidate, candidate["compatibility"])
            args.accept_quality = False
            with self.assertRaisesRegex(ValueError, "accept-quality"):
                module.accept(args)
            args.accept_quality = True
            accepted = module.accept(args)
            installed = module.read(accepted["installedProfile"])
            helper.validate_profile(installed, installed["compatibility"])
            self.assertFalse(accepted["teaCacheDefaultEnabled"])
            self.assertEqual(installed["acceptance"]["reportSha256"], module.digest(Path(args.output_dir) / "report.json"))
            with self.assertRaisesRegex(ValueError, "Existing profile preserved"):
                module.accept(args)
            args.replace_profile_sha256 = accepted["sha256"]
            self.assertEqual(module.accept(args)["installedProfile"], accepted["installedProfile"])

    def test_acceptance_rejects_missing_actual_skips_slow_wallclock_and_changed_model(self):
        for skips, seconds, change, message in ((0, 6, False, "actual cache skips"),
                                               (2, 12, False, "speedup"),
                                               (2, 6, True, "does not match")):
            with self.subTest(message=message), tempfile.TemporaryDirectory() as directory:
                args = fixture(Path(directory))
                self.make_run(args, skips, seconds)
                if seconds > 10:
                    report_path = Path(args.output_dir) / "report.json"
                    report = module.read(report_path)
                    report["observedEndToEndSpeedup"] = 100  # aggregate cannot override actual pair timings
                    report_path.write_text(json.dumps(report))
                if change:
                    (Path(directory) / "model/model_index.json").write_text('{"changed":true}')
                with self.assertRaisesRegex(ValueError, message):
                    module.accept(args)
                self.assertFalse((Path(directory) / "model/teacache-profile.json").exists())

    def test_incomplete_or_changed_artifacts_cannot_install(self):
        with tempfile.TemporaryDirectory() as directory:
            args = fixture(Path(directory))
            def failure(*_):
                raise ValueError("fixture worker failure")
            training, heldout, target, _ = module.plan(args)
            with patch.object(module, "execute", side_effect=failure), self.assertRaisesRegex(ValueError, "worker failure"):
                module.run(args, training, heldout, target)
            self.assertFalse((target / "report.json").exists())
            with self.assertRaises(OSError):
                module.accept(args)
        with tempfile.TemporaryDirectory() as directory:
            args = fixture(Path(directory))
            self.make_run(args)
            (Path(args.output_dir) / "candidate-profile.json").write_text("{}")
            with self.assertRaisesRegex(ValueError, "artifact changed"):
                module.accept(args)

    def test_distinct_heldout_edit_images_allowed_but_changed_bytes_block_acceptance(self):
        with tempfile.TemporaryDirectory() as directory:
            root, args = Path(directory), fixture(Path(directory))
            for index, path in enumerate(args.calibration_job + args.validation_job):
                job = module.read(path)
                for key in ("inputImagePath", "maskImagePath"):
                    image = root / f"{key}-{index}.png"
                    image.write_bytes(PNG)
                    job[key] = str(image)
                Path(path).write_text(json.dumps(job))
            training, heldout, _, _ = module.plan(args)
            self.assertNotEqual(training[0]["inputImagePath"], heldout[0]["inputImagePath"])
            self.assertNotEqual(training[0]["maskImagePath"], heldout[0]["maskImagePath"])
            self.make_run(args)
            Path(heldout[0]["maskImagePath"]).write_bytes(PNG + b"changed")
            with self.assertRaisesRegex(ValueError, "Source image or mask changed"):
                module.accept(args)
            self.assertFalse((root / "model/teacache-profile.json").exists())

    def test_pixel_metrics_are_numerical_only(self):
        try:
            import numpy
            from PIL import Image
        except ImportError:
            self.skipTest("NumPy/Pillow unavailable; numerical metrics require prepared inference runtime")
        with tempfile.TemporaryDirectory() as directory:
            left, right = Path(directory) / "a.png", Path(directory) / "b.png"
            Image.new("RGB", (2, 2), (0, 0, 0)).save(left)
            same = module.pixels(left, left)
            self.assertTrue(same["identicalPixels"])
            self.assertIsNone(same["psnrDb"])
            Image.new("RGB", (2, 2), (255, 0, 0)).save(right)
            different = module.pixels(left, right)
            self.assertAlmostEqual(different["maeRgb01"], 1 / 3)
            self.assertEqual(different["qualityVerdict"], "requires-human-review")

    def test_child_uses_actual_worker_api_and_writes_report(self):
        with tempfile.TemporaryDirectory() as directory:
            request = Path(directory) / "request.json"
            module.write(request, {"job": {"id": "fake"}, "collect": True, "profile": None})
            calls = []
            def generate(job, stream, **kwargs):
                calls.append((job, kwargs))
                return {"schemaVersion": 1, "testFixture": True}
            with patch.object(module, "load", return_value=types.SimpleNamespace(generate=generate)):
                module.child(request)
            self.assertEqual(calls, [({"id": "fake"}, {"collect_teacache": True, "teacache_profile": None, "measure_teacache": False})])
            self.assertTrue(module.read(request.with_name("worker-report.json"))["testFixture"])

    def test_timeout_and_keyboard_interrupt_terminate_worker_process(self):
        for exception in (subprocess.TimeoutExpired("fixture", .05), KeyboardInterrupt()):
            with self.subTest(exception=type(exception).__name__), tempfile.TemporaryDirectory() as directory:
                args = fixture(Path(directory))
                training, _, _, _ = module.plan(args)
                original_popen, processes = subprocess.Popen, []
                def fake_popen(command, **kwargs):
                    if "--_worker-job" not in command:
                        return original_popen(command, **kwargs)
                    process = original_popen([sys.executable, "-c", "import time; time.sleep(60)"], **kwargs)
                    original_wait = process.wait
                    first = True
                    def wait(timeout=None):
                        nonlocal first
                        if first:
                            first = False
                            raise exception
                        return original_wait(timeout=timeout)
                    process.wait = wait
                    processes.append(process)
                    return process
                with patch.object(module.subprocess, "Popen", side_effect=fake_popen), self.assertRaises(type(exception)):
                    module.execute(training[0], Path(directory) / "child", True, None, .05)
                self.assertIsNotNone(processes[0].poll())


if __name__ == "__main__":
    unittest.main()
