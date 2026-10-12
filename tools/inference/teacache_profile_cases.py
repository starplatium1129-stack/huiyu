"""Bounded profile collection cases called by the existing TeaCache suite."""
import copy
import json
from pathlib import Path
import tempfile
from unittest.mock import patch


def test_profile_collection_selects_exact_scope_and_preserves_numeric_equality(case, profiles, profile):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        path = root / "teacache-profile.json"
        scopes = [{"modelSha256": "base", "loras": loras, "sampling": {"cfg": 4}}
                  for loras in ([], [{"sha256": "nene", "strength": .8}], [{"sha256": "natsume", "strength": .8}])]
        entries = [profile(scope) for scope in scopes]
        path.write_text(json.dumps(entries[0]))
        case.assertEqual(profiles.read_profile(str(path), root), entries[0])
        document = dict(schemaVersion=1, kind=profiles.PROFILE_SET_KIND, profiles=entries)
        path.write_text(json.dumps(document))
        for scope, entry in zip(scopes, entries):
            expected = copy.deepcopy(scope)
            expected["sampling"]["cfg"] = 4.0
            case.assertEqual(profiles.read_profile(str(path), root, expected), entry)
        with case.assertRaisesRegex(profiles.TeaCacheError, "requires the current"):
            profiles.read_profile(str(path), root)
        changed = copy.deepcopy(scopes[1])
        changed["loras"][0]["strength"] = .7
        with case.assertRaisesRegex(profiles.TeaCacheError, "No accepted.*matches"):
            profiles.read_profile(str(path), root, changed)
        bad = copy.deepcopy(document)
        bad["profiles"][1]["runtime"]["execution"] = "different-runtime"
        path.write_text(json.dumps(bad))
        with case.assertRaisesRegex(profiles.TeaCacheError, "No accepted.*matches"):
            profiles.read_profile(str(path), root, scopes[1])
        bad = copy.deepcopy(document)
        bad["profiles"][1].pop("acceptance")
        path.write_text(json.dumps(bad))
        with case.assertRaisesRegex(profiles.TeaCacheError, "acceptance"):
            profiles.read_profile(str(path), root, scopes[1])
        duplicate = copy.deepcopy(entries[0])
        duplicate["compatibility"]["sampling"]["cfg"] = 4.0
        document["profiles"].append(duplicate)
        path.write_text(json.dumps(document))
        with case.assertRaisesRegex(profiles.TeaCacheError, "Duplicate"):
            profiles.read_profile(str(path), root, scopes[0])


def test_profile_collection_install_preserves_other_scopes_and_publication_bounds(case, profiles, profile):
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory).resolve()
        first, second, third = [profile({"loras": loras}) for loras in
            ([], [{"sha256": "nene", "strength": .8}], [{"sha256": "natsume", "strength": .8}])]
        path, digest = profiles.install_profile(root, first)
        original = path.read_bytes()
        with case.assertRaisesRegex(profiles.TeaCacheError, "Existing profile preserved"):
            profiles.install_profile(root, second)
        case.assertEqual(path.read_bytes(), original)
        _, digest = profiles.install_profile(root, second, digest)
        _, digest = profiles.install_profile(root, third, digest)
        case.assertEqual(profiles.profile_entries(json.loads(path.read_bytes())), [first, second, third])
        updated = copy.deepcopy(second)
        updated["defaultThreshold"] = .1
        _, digest = profiles.install_profile(root, updated, digest)
        case.assertEqual(profiles.profile_entries(json.loads(path.read_bytes())), [first, updated, third])
        original = path.read_bytes()
        with patch.object(profiles.os, "replace", side_effect=OSError("publication denied")), case.assertRaises(OSError):
            profiles.install_profile(root, second, digest)
        case.assertEqual(path.read_bytes(), original)
        case.assertFalse((root / ".teacache-profile.lock").exists())
        case.assertEqual(list(root.glob(".teacache-*.json")), [])
        lock = root / ".teacache-profile.lock"
        lock.write_text("owned by another acceptance")
        with case.assertRaisesRegex(profiles.TeaCacheError, "acceptance is locked"):
            profiles.install_profile(root, second, digest)
        case.assertTrue(lock.exists())
        lock.unlink()
        oversized = copy.deepcopy(second)
        oversized["calibration"]["note"] = "x" * 65536
        with case.assertRaisesRegex(profiles.TeaCacheError, "64 KiB"):
            profiles.install_profile(root, oversized, digest)
        case.assertEqual(path.read_bytes(), original)
        entries = [profile({"scope": index}) for index in range(16)]
        path.write_text(json.dumps(dict(schemaVersion=1, kind=profiles.PROFILE_SET_KIND, profiles=entries)))
        original = path.read_bytes()
        with case.assertRaisesRegex(profiles.TeaCacheError, "1..16"):
            profiles.install_profile(root, first, profiles.file_sha256(path))
        case.assertEqual(path.read_bytes(), original)
        path.write_bytes(b" " * 65537)
        with case.assertRaisesRegex(profiles.TeaCacheError, "64 KiB"):
            profiles.read_profile(str(path), root, {})
        with case.assertRaisesRegex(profiles.TeaCacheError, "inside the selected"):
            profiles.read_profile(str(path), root / "elsewhere", {})


def test_profile_scope_hashes_exact_bytes_and_requires_local_acceptance(case, profiles, profile, worker, model_fixture, job_fixture):
    with tempfile.TemporaryDirectory() as directory:
        root = model_fixture(Path(directory))
        request = job_fixture(root)
        data = worker.validate_job(request)
        scope = profiles.compatibility(root, [], data, "txt2img", "torch.bfloat16", "fake CUDA")
        files = sorted([p for name in profiles.COMPONENTS for p in (root / name).rglob("*") if p.is_file()]
                       + [root / "modular_model_index.json"])
        expected = profiles.canonical_sha256([[p.relative_to(root).as_posix(), profiles.file_sha256(p)] for p in files])
        case.assertEqual(scope["modelSha256"], expected)
        value = profile(scope)
        case.assertEqual(profiles.validate_profile(value, scope), 0.15)
        weighted = profiles.compatibility(root, [], {**data, "prompt": "(red coat:1.2)"}, "txt2img", "torch.bfloat16", "fake CUDA")
        with case.assertRaisesRegex(profiles.TeaCacheError, "does not match"):
            profiles.validate_profile(value, weighted)
        sharpened = profiles.compatibility(root, [], {**data, "rcasStrength": 0.75}, "txt2img", "torch.bfloat16", "fake CUDA")
        with case.assertRaisesRegex(profiles.TeaCacheError, "does not match"):
            profiles.validate_profile(value, sharpened)
        hires = {**data, "hiresFix": True, "hiresScale": 2, "hiresDenoise": .35,
                 "hiresUpscaler": "Latent", "hiresSampler": "euler", "hiresScheduler": "normal"}
        refined = profiles.compatibility(root, [], hires, "txt2img", "torch.bfloat16", "fake CUDA")
        with case.assertRaisesRegex(profiles.TeaCacheError, "does not match"):
            profiles.validate_profile(value, refined)
        changed_scale = profiles.compatibility(root, [], {**hires, "hiresScale": 1.5}, "txt2img", "torch.bfloat16", "fake CUDA")
        case.assertNotEqual(refined, changed_scale)
        upscaler = root / "4x_foolhardy_Remacri.safetensors"
        upscaler.write_bytes(b"upscaler identity fixture")
        hires.update(hiresUpscaler="Remacri", superResModel=upscaler.name)
        arguments = (root, [], hires, "txt2img", "torch.bfloat16", "fake CUDA")
        refined = profiles.compatibility(*arguments, upscale_model_path=upscaler)
        upscaler.write_bytes(b"changed upscaler bytes")
        case.assertNotEqual(refined, profiles.compatibility(*arguments, upscale_model_path=upscaler))
        legacy = copy.deepcopy(value)
        legacy["runtime"] = {"diffusers": "0.41.0", "torch": "2.8.0"}
        with case.assertRaisesRegex(profiles.TeaCacheError, "runtime.*recalibrate"):
            profiles.validate_profile(legacy, scope)
        candidate = copy.deepcopy(value)
        candidate.pop("acceptance")
        with case.assertRaisesRegex(profiles.TeaCacheError, "acceptance"):
            profiles.validate_profile(candidate, scope)
        case.assertEqual(profiles.validate_profile(candidate, scope, require_accepted=False), 0.15)
        with case.assertRaises(profiles.TeaCacheError):
            profiles.validate_profile(value, scope, 0.21)
        (root / "transformer" / "model.safetensors").write_bytes(b"CHANGED WEIGHTS")
        changed = profiles.compatibility(root, [], data, "txt2img", "torch.bfloat16", "fake CUDA")
        with case.assertRaisesRegex(profiles.TeaCacheError, "does not match"):
            profiles.validate_profile(value, changed)
        lora = root / "style.safetensors"
        lora.write_bytes(b"LORA")
        with_lora = profiles.compatibility(root, [{"path": str(lora), "strength": 0.5}], data, "txt2img", "torch.bfloat16", "fake CUDA")
        case.assertNotEqual(changed, with_lora)
        other = root / "other.safetensors"
        other.write_bytes(b"OTHER LORA")
        adapters = [{"path": str(other), "strength": 0.8}, {"path": str(lora), "strength": 0.5}]
        case.assertEqual(profiles.model_identity(root, adapters)["loras"],
                         [{"sha256": profiles.file_sha256(row["path"]), "strength": row["strength"]} for row in adapters])

