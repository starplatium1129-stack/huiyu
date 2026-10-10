"""Offline conversion tests with explicit fake ML models/tensors, never real weights.

Sparse safetensors files exercise real header and saved-output validation only.
This does not establish real-model conversion or device/inference acceptance.
"""
import argparse
import contextlib
import importlib.util
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
ENTRY = ROOT / "scripts/maintenance/convert-anima-checkpoint.py"
spec = importlib.util.spec_from_file_location("anima_conversion_test", ROOT / "tools/inference/anima_conversion.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

# Explicit reduced schemas, not replicas of upstream classes. Production --check
# obtains the complete schema from exact-pinned real classes on meta.
RAW = {
    "checkpoint": {"net.x_embedder.proj.1.weight": [2048, 68],
                   "net.final_layer.linear.weight": [64, 2048],
                   "net.blocks.0.self_attn.q_norm.weight": [128],
                   "net.blocks.0.self_attn.k_proj.weight": [2048, 2048],
                   "net.blocks.27.mlp.layer1.weight": [8192, 2048],
                   "net.t_embedder.1.linear_1.weight": [2048, 2048],
                   "net.llm_adapter.embed.weight": [32128, 1024],
                   "net.llm_adapter.blocks.5.self_attn.q_norm.weight": [64]},
    "text_encoder": {"embed_tokens.weight": [151936, 1024],
                     "layers.27.mlp.gate_proj.weight": [3072, 1024],
                     "layers.0.self_attn.q_proj.weight": [2048, 1024],
                     "layers.0.self_attn.k_proj.weight": [1024, 1024],
                     "layers.0.self_attn.q_norm.weight": [128]},
    "vae": {"encoder.conv1.weight": [96, 3, 3, 3, 3],
            "decoder.conv1.weight": [384, 16, 3, 3, 3],
            "decoder.upsamples.3.resample.1.weight": [2, 2],
            "encoder.middle.0.residual.2.weight": [2, 2]},
}
SCHEMAS = {
    "transformer": {"patch_embed.proj.weight": [2048, 68], "proj_out.weight": [64, 2048],
                    "transformer_blocks.0.attn1.norm_q.weight": [128],
                    "transformer_blocks.0.attn1.to_k.weight": [2048, 2048],
                    "transformer_blocks.27.ff.net.0.proj.weight": [8192, 2048],
                    "time_embed.t_embedder.linear_1.weight": [2048, 2048]},
    "text_conditioner": {"embed.weight": [32128, 1024], "blocks.5.self_attn.q_norm.weight": [64]},
    "text_encoder": RAW["text_encoder"],
    "vae": {"encoder.conv_in.weight": [96, 3, 3, 3, 3], "decoder.conv_in.weight": [384, 16, 3, 3, 3],
            "decoder.up_blocks.0.upsamplers.0.resample.1.weight": [2, 2],
            "encoder.mid_block.resnets.0.conv1.weight": [2, 2]},
}


def safetensors(path, shapes, dtype="BF16"):
    header, end = {}, 0
    for name, shape in shapes.items():
        size = module.header_tools.DTYPE_BYTES[dtype]
        for dim in shape:
            size *= dim
        header[name] = dict(shape=shape, dtype=dtype, data_offsets=[end, end + size])
        end += size
    raw = json.dumps(header).encode()
    with path.open("wb") as file:
        file.write(struct.pack("<Q", len(raw)))
        file.write(raw)
        file.truncate(8 + len(raw) + end)


def fixture(root):
    args = dict(profile=module.profile.PROFILE, output_dir=str(root / "converted"), check=False, apply=False)
    for name, shapes in RAW.items():
        path = root / (name + ".safetensors")
        safetensors(path, shapes)
        args[name] = str(path)
    config = root / "transformer.json"
    config.write_text(json.dumps(module.profile.TRANSFORMER))
    args["transformer_config"] = str(config)
    for name in ("qwen_tokenizer", "t5_tokenizer"):
        path = root / name
        path.mkdir()
        (path / "tokenizer_config.json").write_text("{}")
        (path / "tokenizer.json").write_text("{}")
        args[name] = str(path)
    return argparse.Namespace(**args)


class FakeTensor:
    def __init__(self, shape, dtype="bf16"):
        self.shape, self.dtype = shape, dtype
        self.device, self.layout = types.SimpleNamespace(type="cpu"), "strided"
    def is_contiguous(self):
        return True


class FakeModel:
    def __init__(self, name, calls):
        self.name, self.calls = name, calls
    def state_dict(self):
        return {name: FakeTensor(shape) for name, shape in SCHEMAS[self.name].items()}
    def load_state_dict(self, state, strict, assign):
        if not strict or not assign or set(state) != set(SCHEMAS[self.name]):
            raise AssertionError("Strict assignment was not used")
        self.calls.append(("strict_load", self.name))
        self.loaded = state
    def save_pretrained(self, path, safe_serialization, max_shard_size):
        if not safe_serialization or max_shard_size != "2GB":
            raise AssertionError("Unsafe save options")
        folder = Path(path)
        folder.mkdir()
        (folder / "config.json").write_text("{}")
        safetensors(folder / "diffusion_pytorch_model.safetensors", {k: v.shape for k, v in self.loaded.items()})


class FakeTokenizer:
    kind = "tokenizer"
    pad_token_id = 0
    @classmethod
    def from_pretrained(cls, path, local_files_only, trust_remote_code):
        if not local_files_only or trust_remote_code or not Path(path).is_dir():
            raise AssertionError("Tokenizer must stay local")
        return cls()
    def get_vocab(self):
        return ({"<|endoftext|>": 151643, "<|im_start|>": 151644, "<|im_end|>": 151645}
                if self.kind == "tokenizer" else {"<pad>": 0, "</s>": 1, "<unk>": 2, "<extra_id_0>": 32099})
    def __call__(self, texts, **kwargs):
        return {"input_ids": [[151643] if self.kind == "tokenizer" else [1] for _ in texts]}
    def save_pretrained(self, path):
        folder = Path(path)
        folder.mkdir()
        (folder / "tokenizer_config.json").write_text("{}")
        (folder / "tokenizer.json").write_text("{}")
    @property
    def backend_tokenizer(self):
        def save(path):
            for name in ("vocab.json", "merges.txt"):
                (Path(path) / name).write_text("{}")
        return types.SimpleNamespace(model=types.SimpleNamespace(save=save))


class FakeT5(FakeTokenizer):
    kind = "t5_tokenizer"


class FakeScheduler:
    def __init__(self, shift):
        if shift != 3.0:
            raise AssertionError("Wrong scheduler")
    def save_pretrained(self, path):
        Path(path).mkdir()
        (Path(path) / "scheduler_config.json").write_text('{"_class_name":"FlowMatchEulerDiscreteScheduler"}')


def fake_runtime(calls):
    @contextlib.contextmanager
    def safe_open(path, framework, device):
        if framework != "pt" or device != "cpu":
            raise AssertionError("Only CPU safetensors")
        header = module.header_tools.read_header(Path(path))
        def get_tensor(name):
            calls.append(("read_tensor", name))
            return FakeTensor(header[name]["shape"])
        yield types.SimpleNamespace(keys=lambda: list(header), get_tensor=get_tensor)
    runtime = dict(versions={"fixture": "explicit fake, no ML packages"},
                   torch=types.SimpleNamespace(float16="fp16", bfloat16="bf16", float32="fp32", strided="strided"),
                   empty=lambda include_buffers: contextlib.nullcontext(), safe_open=safe_open,
                   tokenizer=FakeTokenizer, t5_tokenizer=FakeT5, scheduler=FakeScheduler)
    for name in module.WEIGHTS:
        runtime[name] = lambda name=name, **kwargs: FakeModel(name, calls)
    return runtime


class ConversionTests(unittest.TestCase):
    def test_plan_cli_is_stdlib_only_and_does_not_create_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            args = fixture(root)
            argv = [sys.executable, "-I", "-S", str(ENTRY)]
            for name, value in vars(args).items():
                if name not in {"check", "apply"}:
                    argv += ["--" + name.replace("_", "-"), value]
            result = subprocess.run(argv, check=True, text=True, capture_output=True)
            report = json.loads(result.stdout)
            self.assertEqual(report["mode"], "plan")
            self.assertFalse(report["tensorDataRead"])
            self.assertFalse(report["architectureVerified"])
            self.assertFalse(Path(args.output_dir).exists())

    def test_check_and_apply_are_explicit_and_result_matches_worker(self):
        with tempfile.TemporaryDirectory() as directory:
            root, calls = Path(directory), []
            args = fixture(root)
            originals = {p: (p.stat().st_size, p.stat().st_mtime_ns) for p in root.glob("*.safetensors")}
            with patch.object(module, "runtime", return_value=fake_runtime(calls)):
                args.check = True
                result = module.convert(args)
                self.assertTrue(result["architectureVerified"])
                self.assertEqual(calls, [])
                self.assertFalse(Path(args.output_dir).exists())
                args.check, args.apply = False, True
                result = module.convert(args)
            self.assertEqual(result["mode"], "converted")
            self.assertTrue(result["savedKeyShapeDtypeVerified"])
            self.assertFalse(result["readyForInference"])
            self.assertEqual(len([c for c in calls if c[0] == "read_tensor"]), sum(map(len, RAW.values())))
            self.assertEqual(len([c for c in calls if c[0] == "strict_load"]), 4)
            worker = module.sibling("conversion_test_worker", ROOT / "tools/inference/worker.py")
            self.assertEqual(worker.validate_model(args.output_dir), Path(args.output_dir))
            for path, stat in originals.items():
                self.assertEqual((path.stat().st_size, path.stat().st_mtime_ns), stat)

    def test_profile_config_shape_dtype_and_unknown_keys_fail_closed(self):
        cases = ("wrong_profile", "wrong_config", "wrong_anchor", "wrong_other_shape", "quantized", "extra_counter", "collision")
        for case in cases:
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                args, calls = fixture(Path(directory)), []
                if case == "wrong_profile":
                    args.profile = "guessed-miaomiao-version"
                elif case == "wrong_config":
                    Path(args.transformer_config).write_text(json.dumps({**module.profile.TRANSFORMER, "rope_scale": [2, 2, 2]}))
                else:
                    raw = dict(RAW["checkpoint"])
                    if case == "wrong_anchor":
                        raw["net.x_embedder.proj.1.weight"] = [3072, 68]
                    elif case == "wrong_other_shape":
                        raw["net.blocks.0.self_attn.k_proj.weight"] = [2047, 2048]
                    elif case == "extra_counter":
                        raw["net.accum_iteration"] = [1]
                    elif case == "collision":
                        raw["net.time_embed.t_embedder.linear_1.weight"] = [2048, 2048]
                    safetensors(Path(args.checkpoint), raw, "F8_E4M3" if case == "quantized" else "BF16")
                args.apply = True
                with patch.object(module, "runtime", return_value=fake_runtime(calls)), self.assertRaises(ValueError):
                    module.convert(args)
                self.assertEqual(calls, [])
                self.assertFalse(Path(args.output_dir).exists())

    def test_companion_tokenizer_and_path_boundaries(self):
        for case in ("model_prefix_mix", "custom_tokenizer", "external_asset", "inside_assets", "existing_output"):
            with self.subTest(case=case), tempfile.TemporaryDirectory() as directory:
                args = fixture(Path(directory))
                if case == "model_prefix_mix":
                    raw = dict(RAW["text_encoder"])
                    raw["model.embed_tokens.weight"] = raw.pop("embed_tokens.weight")
                    safetensors(Path(args.text_encoder), raw)
                elif case in {"custom_tokenizer", "external_asset"}:
                    content = {"auto_map": {}} if case == "custom_tokenizer" else {"tokenizer_file": "https://invalid.example/remote.json"}
                    (Path(args.qwen_tokenizer) / "tokenizer_config.json").write_text(json.dumps(content))
                elif case == "inside_assets":
                    args.output_dir = str(Path(args.qwen_tokenizer) / "converted")
                else:
                    Path(args.output_dir).mkdir()
                    (Path(args.output_dir) / "user-file.txt").write_text("keep")
                with self.assertRaises(ValueError):
                    module.convert(args)
                if case == "existing_output":
                    self.assertEqual((Path(args.output_dir) / "user-file.txt").read_text(), "keep")

    def test_failed_save_and_publish_race_preserve_inputs_and_existing_output(self):
        for race in (False, True):
            with self.subTest(race=race), tempfile.TemporaryDirectory() as directory:
                root, calls = Path(directory), []
                args = fixture(root)
                args.apply = True
                original = module.save_weights
                def save(*values):
                    if not race:
                        raise OSError("simulated save failure")
                    original(*values)
                    Path(args.output_dir).mkdir()
                    (Path(args.output_dir) / "existing.txt").write_text("untouched")
                with patch.object(module, "runtime", return_value=fake_runtime(calls)), patch.object(module, "save_weights", side_effect=save), self.assertRaises(OSError):
                    module.convert(args)
                if race:
                    self.assertEqual(list(Path(args.output_dir).iterdir()), [Path(args.output_dir) / "existing.txt"])
                    self.assertEqual((Path(args.output_dir) / "existing.txt").read_text(), "untouched")
                else:
                    self.assertFalse(Path(args.output_dir).exists())
                self.assertFalse(list(root.glob(".converted.convert-*")))
                self.assertTrue(Path(args.checkpoint).is_file())

    def test_exact_saved_schema_and_local_tokenizer_pairing(self):
        with tempfile.TemporaryDirectory() as directory:
            args, calls = fixture(Path(directory)), []
            args.apply = True
            with patch.object(module, "runtime", return_value=fake_runtime(calls)), patch.object(FakeTokenizer, "get_vocab", return_value={"bad": 999999}), self.assertRaisesRegex(ValueError, "embedding"):
                module.convert(args)
            self.assertEqual(calls, [])
            with patch.object(module, "runtime", return_value=fake_runtime(calls)), patch.object(module, "verify_saved_weights", side_effect=ValueError("saved shape mismatch")), self.assertRaisesRegex(ValueError, "saved shape"):
                module.convert(args)
            self.assertFalse(Path(args.output_dir).exists())


if __name__ == "__main__":
    unittest.main()
