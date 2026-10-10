"""Targeted standard-library tests for offline single-file preparation reporting."""
import argparse
import importlib.util
import json
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "maintenance/inspect-anima-checkpoint.py"
spec = importlib.util.spec_from_file_location("inspect_anima", SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def checkpoint(path, shapes):
    # Sparse payload: testing header inspection does not allocate model weights.
    header, offset = {}, 0
    for name, shape in shapes.items():
        size = 2
        for dimension in shape:
            size *= dimension
        header[name] = {"shape": shape, "dtype": "BF16", "data_offsets": [offset, offset + size]}
        offset += size
    raw = json.dumps(header).encode()
    with path.open("wb") as output:
        output.write(struct.pack("<Q", len(raw)))
        output.write(raw)
        output.truncate(8 + len(raw) + offset)


def shapes(width=2048):
    result = {f"net.blocks.{i}.fixture": [1] for i in range(28)}
    result.update({f"net.llm_adapter.blocks.{i}.fixture": [1] for i in range(6)})
    result.update({"net.blocks.0.self_attn.q_proj.weight": [width, width],
                   "net.blocks.0.self_attn.q_norm.weight": [128],
                   "net.blocks.0.cross_attn.k_proj.weight": [width, 1024],
                   "net.blocks.0.mlp.layer1.weight": [8192, width],
                   "net.x_embedder.proj.1.weight": [width, 68],
                   "net.final_layer.linear.weight": [64, width],
                   "net.llm_adapter.blocks.0.self_attn.q_proj.weight": [1024, 1024],
                   "net.llm_adapter.blocks.0.self_attn.q_norm.weight": [64],
                   "net.llm_adapter.blocks.0.cross_attn.k_proj.weight": [1024, 1024],
                   "net.llm_adapter.embed.weight": [32128, 1024]})
    return result


def arguments(path, **overrides):
    values = dict(checkpoint=str(path), transformer_config=None, text_encoder=None, vae=None,
                  qwen_tokenizer=None, t5_tokenizer=None, diffusers_source=None, output_dir=None)
    values.update(overrides)
    return argparse.Namespace(**values)


class CheckpointPreparationTests(unittest.TestCase):
    def test_raw_header_reports_dimensions_and_missing_companions(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "miaomiaoHarem_anima16.safetensors"
            checkpoint(path, shapes())
            result = module.inspect(arguments(path))
            self.assertEqual(result["architecture"]["layout"], "raw-anima")
            self.assertEqual(result["architecture"]["transformer"]["hidden_size"], 2048)
            self.assertEqual(result["architecture"]["text_conditioner"]["num_attention_heads"], 16)
            self.assertTrue(any("--text-encoder" in error for error in result["blockers"]))
            self.assertFalse(result["readyForInference"])
            self.assertIsNone(result["conversionPlan"]["commandArgv"])

    def test_variant_dimensions_block_fixed_upstream_converter(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "variant.safetensors"
            checkpoint(path, shapes(3072))
            result = module.inspect(arguments(path))
            self.assertTrue(any("hidden_size=2048, checkpoint has 3072" in error for error in result["blockers"]))
            self.assertIsNone(result["conversionPlan"]["commandArgv"])

    def test_bounded_header_and_truncated_payload_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "broken.safetensors"
            path.write_bytes(struct.pack("<Q", module.MAX_HEADER + 1))
            with self.assertRaisesRegex(ValueError, "bounded range"):
                module.read_header(path)
            checkpoint(path, {"x": [2]})
            with path.open("r+b") as output:
                output.truncate(path.stat().st_size - 1)
            with self.assertRaisesRegex(ValueError, "truncated tensor"):
                module.read_header(path)

    def test_complete_local_plan_still_requires_strict_weight_verification(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            model, encoder, vae = [root / name for name in ("model.safetensors", "encoder.safetensors", "vae.safetensors")]
            checkpoint(model, shapes())
            checkpoint(encoder, {"embed_tokens.weight": [32, 1024]})
            checkpoint(vae, {"encoder.conv1.weight": [1], "decoder.conv1.weight": [1]})
            for folder in ("qwen", "t5"):
                (root / folder).mkdir()
                (root / folder / "tokenizer_config.json").write_text("{}")
                (root / folder / "tokenizer.json").write_text("{}")
            (root / "source/scripts").mkdir(parents=True)
            for name in ("convert_anima_to_diffusers.py", "convert_cosmos_to_diffusers.py"):
                (root / "source/scripts" / name).write_text("# Presence fixture, never executed\n")
            config = root / "transformer.json"
            config.write_text(json.dumps(dict(in_channels=16, out_channels=16, num_attention_heads=16,
                attention_head_dim=128, num_layers=28, mlp_ratio=4.0, text_embed_dim=1024,
                adaln_lora_dim=256, max_size=[128, 240, 240], patch_size=[1, 2, 2],
                rope_scale=[1.0, 4.0, 4.0], concat_padding_mask=True, extra_pos_embed_type=None)))
            result = module.inspect(arguments(model, text_encoder=str(encoder), vae=str(vae),
                                    qwen_tokenizer=str(root / "qwen"), t5_tokenizer=str(root / "t5"),
                                    diffusers_source=str(root / "source"), output_dir=str(root / "converted"),
                                    transformer_config=str(config)))
            self.assertEqual(result["blockers"], [])
            self.assertEqual(result["preparationStatus"], "candidate-for-strict-offline-conversion")
            self.assertFalse(result["readyForInference"])
            self.assertIn("--check", result["conversionPlan"]["commandArgv"])
            self.assertIn("anima-cosmos2b-v041", result["conversionPlan"]["commandArgv"])
            self.assertTrue(result["conversionPlan"]["commandArgv"][2].endswith("convert-anima-checkpoint.py"))
            self.assertNotIn(str(root / "source"), " ".join(result["conversionPlan"]["commandArgv"]))
            # The upstream checkout is no longer a prerequisite or executed code.
            without_source = module.inspect(arguments(model, text_encoder=str(encoder), vae=str(vae),
                qwen_tokenizer=str(root / "qwen"), t5_tokenizer=str(root / "t5"),
                output_dir=str(root / "converted"), transformer_config=str(config)))
            self.assertEqual(without_source["blockers"], [])
            self.assertFalse((root / "converted").exists())
            # The real CLI also runs without site packages (no torch/safetensors imports).
            cli = subprocess.run([sys.executable, "-S", str(SCRIPT), "--checkpoint", str(model)],
                                 check=True, text=True, capture_output=True)
            self.assertFalse(json.loads(cli.stdout)["tensorDataRead"])


if __name__ == "__main__":
    unittest.main()
