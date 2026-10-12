"""Synthetic runtime-contract case, executed by the existing calibration test entry."""
import json
from pathlib import Path
import tempfile


def check_runtime_revision(case, fixture, module):
    with tempfile.TemporaryDirectory() as directory:
        args = fixture(Path(directory))
        with case.assertRaisesRegex(ValueError, "runtime.*recalibrate"):
            case.make_run(args, legacy_runtime=True)
        case.assertFalse((Path(args.output_dir) / "report.json").exists())
    with tempfile.TemporaryDirectory() as directory:
        args = fixture(Path(directory))
        case.make_run(args)
        target = Path(args.output_dir)
        traces = module.read(target / "traces.json")
        traces["traces"][0].pop("runtime")
        (target / "traces.json").write_text(json.dumps(traces))
        candidate = module.read(target / "candidate-profile.json")
        candidate["calibration"]["traceSha256"] = module.canonical(traces["traces"])
        (target / "candidate-profile.json").write_text(json.dumps(candidate))
        report = module.read(target / "report.json")
        report.update(tracesSha256=module.digest(target / "traces.json"),
                      candidateSha256=module.digest(target / "candidate-profile.json"))
        (target / "report.json").write_text(json.dumps(report))
        with case.assertRaisesRegex(ValueError, "runtime.*recalibrate"):
            module.accept(args)
        case.assertFalse((Path(directory) / "model/teacache-profile.json").exists())


def check_append_scope(case, fixture, module):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        args = fixture(root)
        case.make_run(args)
        accepted = module.accept(args)
        path = Path(accepted["installedProfile"])
        first = module.read(path)
        second_root = root / "second"
        second_root.mkdir()
        second = fixture(second_root)
        for job_path in second.calibration_job + second.validation_job:
            job = module.read(job_path)
            job["modelDir"] = str(root / "model")
            job["input"]["cfg"] = 6
            Path(job_path).write_text(json.dumps(job))
        case.make_run(second)
        with case.assertRaisesRegex(ValueError, "Existing profile preserved"):
            module.accept(second)
        case.assertEqual(module.read(path), first)
        second.replace_profile_sha256 = accepted["sha256"]
        installed = module.accept(second)
        helper = module.load("teacache_profile")
        entries = helper.profile_entries(module.read(path))
        case.assertEqual(len(entries), 2)
        case.assertEqual(entries[0], first)
        case.assertEqual(entries[1]["compatibility"]["sampling"]["cfg"], 6)
        case.assertEqual(installed["sha256"], module.digest(path))
        with case.assertRaisesRegex(ValueError, "Existing profile preserved"):
            module.accept(second)
