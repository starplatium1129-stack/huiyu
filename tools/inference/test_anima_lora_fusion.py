"""Real CPU BF16 PEFT weights; lifecycle shell is small, no GPU/model assets."""
import copy
from contextlib import contextmanager
import json
from pathlib import Path
import tempfile
import unittest
import weakref
from unittest.mock import patch

import torch
from peft import LoraConfig, inject_adapter_in_model
from peft.tuners.lora.layer import Linear
from diffusers.utils.peft_utils import recurse_remove_peft_layers
from safetensors.torch import save_file

from anima_lora_fusion import LoraFusionState
from resident_anima import PipelineCache


class TinyModel(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.proj = torch.nn.Linear(8, 8, bias=False, dtype=torch.bfloat16)
        with torch.no_grad():
            self.proj.weight.fill_(1)


class FusionTests(unittest.TestCase):
    @contextmanager
    def source_fixture(self):
        _, load, load_loras, _ = self.fixture()
        pipeline = load()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for component in ("transformer", "text_conditioner"):
                folder = root / component
                folder.mkdir()
                weight = pipeline.components[component].proj.weight.detach().clone()
                if component == "transformer":
                    save_file({"proj.weight": weight}, folder / "part.safetensors")
                    (folder / "diffusion_pytorch_model.safetensors.index.json").write_text(
                        json.dumps({"weight_map": {"proj.weight": "part.safetensors"}}))
                else:
                    # Match the loader's CPU cast to the resident BF16 dtype.
                    save_file({"proj.weight": weight.float()}, folder / "diffusion_pytorch_model.safetensors")
            load_loras(pipeline, [{"sha256": "a", "strength": 0.75}])
            fusion = pipeline.components["transformer"]._huiyu_lora_fusion
            lease = {"valid": True}
            fusion.bind_source(root, "a" * 64, lambda: lease["valid"])
            try:
                yield root, pipeline, fusion, lease
            finally:
                fusion.clear()

    def fixture(self):
        test = self
        created = []

        class Pipeline:
            def __init__(self, blocks=None):
                self.components = {name: None for name in ("text_encoder", "vae", "tokenizer", "t5_tokenizer")}
                self.components.update(transformer=TinyModel(), text_conditioner=TinyModel())
                self.components["transformer"]._huiyu_lora_fusion = LoraFusionState()
                self.scheduler = type("Scheduler", (), {"config": {}})()

            def update_components(self, **components):
                self.components = components
                self.scheduler = components["scheduler"]

            def set_progress_bar_config(self, **kwargs):
                pass

            def assert_restored(self):
                for name in ("transformer", "text_conditioner"):
                    layer = self.components[name].proj
                    if isinstance(layer, Linear):
                        test.assertFalse(layer.merged)
                        layer = layer.get_base_layer()
                    test.assertTrue(torch.equal(layer.weight.view(torch.int16), torch.ones_like(layer.weight).view(torch.int16)))

            def set_adapters(self, names, adapter_weights):
                self.assert_restored()
                for component in ("transformer", "text_conditioner"):
                    layer = self.components[component].proj
                    layer.set_adapter(names)
                    for name, strength in zip(names, adapter_weights):
                        layer.set_scale(name, strength)

            def unload_lora_weights(self):
                self.assert_restored()
                for name in ("transformer", "text_conditioner"):
                    model = self.components[name]
                    recurse_remove_peft_layers(model)
                    del model.peft_config

        def load(*args, **kwargs):
            pipeline = Pipeline()
            created.append(pipeline)
            return pipeline

        def load_loras(pipeline, rows):
            pipeline.assert_restored()
            if not rows:
                return
            for index, row in enumerate(rows):
                adapter = f"huiyu_{index}"
                for name in ("transformer", "text_conditioner"):
                    model = pipeline.components[name]
                    config = LoraConfig(r=2, lora_alpha=2, target_modules=["proj"], init_lora_weights=False)
                    inject_adapter_in_model(config, model, adapter_name=adapter)
                    with torch.no_grad():
                        model.proj.lora_A[adapter].weight.fill_(0.1)
                        model.proj.lora_B[adapter].weight.fill_(0.015 if row["sha256"] == "a" else 0.035)
                    model.eval()
            pipeline.set_adapters([f"huiyu_{i}" for i in range(len(rows))], [row["strength"] for row in rows])

        return Pipeline, load, load_loras, created

    def test_exact_restore_before_strength_group_and_empty_transitions(self):
        pipeline_type, load, load_loras, created = self.fixture()
        from native_upload import try_packed_upload
        original_load, addresses = load, {}
        def load(*args, **kwargs):
            pipeline = original_load(*args, **kwargs)
            self.assertTrue(try_packed_upload([pipeline.components[name] for name in
                ("transformer", "text_conditioner")], target_device="cpu"))
            addresses.update({name: pipeline.components[name].proj.weight.data_ptr()
                              for name in ("transformer", "text_conditioner")})
            return pipeline
        resident = PipelineCache()
        with patch("diffusers.AnimaModularPipeline", pipeline_type):
            previous_fusion = None
            for rows in ([{"sha256": "a", "strength": 0.75}],
                         [{"sha256": "a", "strength": -0.5}],
                         [{"sha256": "b", "strength": 0.6}], []):
                identity = {"modelSha256": "base", "loras": copy.deepcopy(rows)}
                pipeline, _ = resident.acquire(identity, None, 4, None, rows, load, load_loras)
                fusion = resident.fusion
                for name, address in addresses.items():
                    self.assertEqual(pipeline.components[name].proj.weight.data_ptr(), address)
                self.assertEqual(fusion.bytes, 2 * 8 * 8 * 2 if rows else 0)
                if previous_fusion is not None:
                    self.assertIs(fusion, previous_fusion)
                previous_fusion = fusion
                if rows:
                    for name in ("transformer", "text_conditioner"):
                        layer = pipeline.components[name].proj
                        self.assertTrue(layer.merged)
                        self.assertEqual(layer.lora_A["huiyu_0"].weight.dtype, torch.bfloat16)
                        self.assertEqual(layer.scaling["huiyu_0"], rows[0]["strength"])
                        self.assertTrue(torch.isfinite(layer(torch.ones(1, 8, dtype=torch.bfloat16))).all())
                    # Same-identity jobs must not recapture or merge the base again.
                    with patch.object(fusion, "fuse", wraps=fusion.fuse) as fuse:
                        _, reused = resident.acquire(identity, None, 4, None, rows, load, load_loras)
                        self.assertTrue(reused)
                        fuse.assert_not_called()
                else:
                    pipeline.assert_restored()
                    self.assertEqual(fusion._merged, [])
            self.assertEqual(len(created), 1)
            resident.clear()
            self.assertEqual(previous_fusion.bytes, 0)
            self.assertEqual(previous_fusion._originals, {})
            self.assertIsNone(resident.fusion)
            self.assertIsNone(resident.components)

    def test_partial_merge_failure_restores_bytes_and_discards_resident(self):
        pipeline_type, load, load_loras, created = self.fixture()
        resident = PipelineCache()
        original = Linear.merge
        calls = 0

        def failing_merge(layer, *args, **kwargs):
            nonlocal calls
            original(layer, *args, **kwargs)
            calls += 1
            if calls == 2:
                raise RuntimeError("injected after second real PEFT merge")

        rows = [{"sha256": "a", "strength": 0.75}]
        with patch("diffusers.AnimaModularPipeline", pipeline_type), patch.object(Linear, "merge", failing_merge):
            with self.assertRaisesRegex(RuntimeError, "second real"):
                resident.acquire({"modelSha256": "base", "loras": rows}, None, 4, None, rows, load, load_loras)
        created[0].assert_restored()
        self.assertEqual(created[0].components["transformer"]._huiyu_lora_fusion.bytes, 0)
        self.assertIsNone(resident.components)
        self.assertIsNone(resident.identity)
        self.assertIsNone(resident.fusion)
        self.assertFalse(torch.cuda.is_initialized())

    def test_source_restores_sharded_and_cast_weights_with_bounded_buffers(self):
        with self.source_fixture() as (root, pipeline, fusion, lease), \
                patch("anima_lora_fusion.MAX_BUFFER_BYTES", 64):
            fusion.fuse(pipeline.components)
            self.assertEqual(fusion.bytes, 0)
            self.assertEqual(fusion._originals, {})
            self.assertEqual(fusion.source_bytes, 128 + 256)
            with self.assertRaisesRegex(ValueError, "changing its source identity"):
                fusion.bind_source(root, "b" * 64, lambda: lease["valid"])
            original_empty = torch.empty
            buffers = []

            def capture_buffer(*args, **kwargs):
                result = original_empty(*args, **kwargs)
                if kwargs.get("dtype") == torch.uint8:
                    self.assertFalse(kwargs["pin_memory"])
                    buffers.append(weakref.ref(result))
                return result

            with patch.object(torch, "empty", capture_buffer):
                fusion.restore()
            pipeline.assert_restored()
            self.assertEqual(fusion.restored_source_bytes, 384)
            self.assertLessEqual(fusion.buffer_peak_bytes, 64)
            self.assertGreater(fusion.buffer_peak_bytes, 0)
            # BF16 and FP32 source groups allocate once each, not once per row.
            self.assertEqual(len(buffers), 2)
            self.assertTrue(all(reference() is None for reference in buffers))
            fusion.bind_source(root, "b" * 64, lambda: lease["valid"])
            self.assertEqual(fusion._sources, {})
            self.assertEqual(fusion.source_bytes, 0)
            self.assertFalse(torch.cuda.is_initialized())

    def test_source_preflight_rejects_changed_tensor_before_any_restore(self):
        with self.source_fixture() as (root, pipeline, fusion, _):
            fusion.fuse(pipeline.components)
            before = {name: pipeline.components[name].proj.weight.detach().clone()
                      for name in ("transformer", "text_conditioner")}
            # A lying test lease lets us exercise the metadata check separately.
            save_file({"proj.weight": torch.ones(7, 8)},
                      root / "text_conditioner/diffusion_pytorch_model.safetensors")
            with self.assertRaisesRegex(ValueError, "description changed"):
                fusion.restore()
            for name, expected in before.items():
                layer = pipeline.components[name].proj
                self.assertTrue(layer.merged)
                self.assertTrue(torch.equal(layer.weight.view(torch.int16), expected.view(torch.int16)))

    def test_lost_lease_blocks_reads_and_does_not_mark_partial_restore_complete(self):
        with self.source_fixture() as (_, pipeline, fusion, lease):
            fusion.fuse(pipeline.components)
            lease["valid"] = False
            with patch("safetensors.safe_open", side_effect=AssertionError("must not read an unprotected base")):
                with self.assertRaisesRegex(ValueError, "lease"):
                    fusion.restore()
            self.assertTrue(all(layer.merged for layer in fusion._merged))
            lease["valid"] = True
            original_copy = torch.Tensor.copy_

            def lose_lease_after_copy(target, source, **kwargs):
                result = original_copy(target, source, **kwargs)
                lease["valid"] = False
                return result

            with patch.object(torch.Tensor, "copy_", lose_lease_after_copy):
                with self.assertRaisesRegex(ValueError, "lease"):
                    fusion.restore()
            self.assertTrue(all(layer.merged for layer in fusion._merged))

    def test_base_mutating_peft_initializer_keeps_snapshot_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            model = TinyModel()
            config = LoraConfig(r=2, lora_alpha=2, target_modules=["proj"], init_lora_weights="pissa")
            inject_adapter_in_model(config, model, adapter_name="adapter")
            original = model.proj.weight.detach().clone()
            self.assertFalse(torch.equal(original, torch.ones_like(original)))
            fusion = LoraFusionState()
            # No source files are needed for this path, even with a valid binding.
            fusion.bind_source(directory, "a" * 64, lambda: True)
            fusion.fuse({"transformer": model, "text_conditioner": torch.nn.Identity()})
            self.assertEqual(fusion.source_bytes, 0)
            self.assertEqual(fusion.bytes, 128)
            fusion.restore()
            self.assertTrue(torch.equal(model.proj.weight.view(torch.int16), original.view(torch.int16)))
            fusion.clear()

    def test_bounded_header_is_checked_before_restoring_any_tensor(self):
        with self.source_fixture() as (_, pipeline, fusion, _):
            fusion.fuse(pipeline.components)
            before = {name: pipeline.components[name].proj.weight.detach().clone()
                      for name in ("transformer", "text_conditioner")}
            # safetensors accepts this real file, but our raw-offset reader must
            # honor its own smaller header budget before using any offsets.
            with patch("anima_lora_fusion.MAX_HEADER_BYTES", 1):
                with self.assertRaisesRegex(ValueError, "header exceeds"):
                    fusion.restore()
            for name, expected in before.items():
                layer = pipeline.components[name].proj
                self.assertTrue(layer.merged)
                self.assertTrue(torch.equal(layer.weight.view(torch.int16), expected.view(torch.int16)))


if __name__ == "__main__":
    unittest.main()
