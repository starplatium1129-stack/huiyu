"""Real CPU BF16 Diffusers/PEFT hotswap; tiny models, temporary safetensors, no GPU."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import torch
from diffusers import AnimaModularPipeline, AnimaTextConditioner, CosmosTransformer3DModel
from safetensors.torch import save_file

import anima_lora as helper


TARGETS = {"transformer": "transformer_blocks.0.attn2.to_k",
           "text_conditioner": "blocks.0.cross_attn.k_proj"}
RAW = {"transformer": "blocks.0.cross_attn.k_proj",
       "text_conditioner": "llm_adapter.blocks.0.cross_attn.k_proj"}


def pipeline(num_layers=1):
    transformer = CosmosTransformer3DModel(num_layers=num_layers, num_attention_heads=1, attention_head_dim=24,
        text_embed_dim=8, encoder_hidden_states_channels=8, adaln_lora_dim=4).to(dtype=torch.bfloat16)
    conditioner = AnimaTextConditioner(source_dim=4, target_dim=4, model_dim=4, num_layers=1,
        num_attention_heads=1, target_vocab_size=16).to(dtype=torch.bfloat16)
    result = AnimaModularPipeline()
    result.update_components(transformer=transformer, text_conditioner=conditioner)
    return result


def weights(pipe, path, value, *, layout="kohya", rank=2, targets=TARGETS):
    state = {}
    for component, target in targets.items():
        layer = getattr(pipe, component).get_submodule(target)
        base = layer.get_base_layer() if hasattr(layer, "get_base_layer") else layer
        down = torch.full((rank, base.in_features), .25, dtype=torch.bfloat16)
        up = torch.full((base.out_features, rank), value, dtype=torch.bfloat16)
        if layout == "kohya":
            alias = "lora_unet_" + RAW[component].replace(".", "_")
            state.update({alias + ".lora_down.weight": down, alias + ".lora_up.weight": up,
                          alias + ".alpha": torch.tensor(rank / 2, dtype=torch.float32)})
        else:
            prefix = f"{component}.{target}" if layout == "native" else "diffusion_model." + RAW[component]
            state.update({prefix + ".lora_A.weight": down, prefix + ".lora_B.weight": up})
    save_file(state, str(path))
    return state


def layers(pipe):
    return [getattr(pipe, component).get_submodule(target) for component, target in TARGETS.items()]


class HotswapTests(unittest.TestCase):
    def test_from_pretrained_many_targets_use_actual_paths_after_peft_suffix_compression(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = pipeline(num_layers=28)
            components = {}
            for name in TARGETS:
                component = getattr(original, name)
                component.save_pretrained(root / name)
                components[name] = type(component).from_pretrained(str(root / name),
                    torch_dtype=torch.bfloat16, local_files_only=True)
            pipe = AnimaModularPipeline()
            pipe.update_components(**components)
            self.assertEqual(pipe.transformer.config._name_or_path, str(root / "transformer"))
            state = {}
            for alias, (target, inputs, outputs) in helper._targets(pipe).items():
                if not ((target.startswith("transformer.transformer_blocks.") and (".attn" in target or ".ff." in target))
                        or target == "text_conditioner." + TARGETS["text_conditioner"]):
                    continue
                state[alias + ".lora_down.weight"] = torch.full((2, inputs), .25, dtype=torch.bfloat16)
                state[alias + ".lora_up.weight"] = torch.full((outputs, 2), .125, dtype=torch.bfloat16)
                state[alias + ".alpha"] = torch.tensor(1.)
            first, second = root / "first.safetensors", root / "second.safetensors"
            save_file(state, str(first))
            helper.load_loras(pipe, [{"path": str(first), "strength": .5}])
            # Real 280-target role adapters trigger PEFT's >=20-target rewrite;
            # the old one-target fixture and loading provenance alone do not.
            self.assertLess(len(pipe.transformer.peft_config["huiyu_0"].target_modules), 280)
            retained = {component: {name: layer for name, layer in model.named_modules()
                                   if hasattr(layer, "lora_A") and "huiyu_0" in layer.lora_A}
                        for component, model in components.items()}
            self.assertEqual(len(retained["transformer"]), 280)
            for key, tensor in state.items():
                if key.endswith(".lora_up.weight"):
                    tensor.fill_(.25)
            save_file(state, str(second))
            self.assertTrue(helper.try_hotswap(pipe, [{"path": str(second), "strength": -.5}]))
            for component, modules in retained.items():
                for name, layer in modules.items():
                    self.assertIs(getattr(pipe, component).get_submodule(name), layer)
                    self.assertEqual(layer.lora_B["huiyu_0"].weight.dtype, torch.bfloat16)
                    self.assertTrue(torch.equal(layer.lora_B["huiyu_0"].weight,
                                                torch.full_like(layer.lora_B["huiyu_0"].weight, .125)))
                    self.assertEqual(layer.scaling["huiyu_0"], -.5)
            # A truly different target set remains inapplicable despite the
            # equivalent suffix spellings; no earlier component is changed.
            removed = next(key.removesuffix(".alpha") for key in state if key.endswith(".alpha"))
            reduced = {key: value for key, value in state.items() if not key.startswith(removed + ".")}
            save_file(reduced, str(second))
            with patch.object(pipe, "load_lora_weights", wraps=pipe.load_lora_weights) as calls:
                self.assertFalse(helper.try_hotswap(pipe, [{"path": str(second), "strength": .8}]))
                calls.assert_not_called()
            self.assertFalse(torch.cuda.is_initialized())

    def test_kohya_hotswap_preserves_modules_bf16_and_signed_strengths(self):
        pipe = pipeline()
        with tempfile.TemporaryDirectory() as directory:
            first, second = [Path(directory) / f"{name}.safetensors" for name in ("first", "second")]
            weights(pipe, first, .125)
            weights(pipe, second, .25)
            helper.load_loras(pipe, [{"path": str(first), "strength": .5}])
            retained = layers(pipe)
            bases = [layer.get_base_layer().weight.detach().clone() for layer in retained]
            for strength in (-.5, .75, 0):
                with patch.object(pipe, "load_lora_weights", wraps=pipe.load_lora_weights) as calls:
                    self.assertTrue(helper.try_hotswap(pipe, [{"path": str(second), "strength": strength}]))
                self.assertTrue(calls.call_args.kwargs["hotswap"])
                for layer, old, base in zip(layers(pipe), retained, bases):
                    self.assertIs(layer, old)
                    self.assertEqual(layer.lora_A["huiyu_0"].weight.dtype, torch.bfloat16)
                    self.assertEqual(layer.lora_B["huiyu_0"].weight.dtype, torch.bfloat16)
                    self.assertEqual(layer.scaling["huiyu_0"], strength)
                    self.assertTrue(torch.equal(layer.get_base_layer().weight, base))
                    x = torch.ones(1, layer.in_features, dtype=torch.bfloat16)
                    # Alpha=rank/2 is folded into B; PEFT then applies user strength.
                    delta = torch.full_like(layer(x), layer.in_features * .25 * 2 * .25 * .5)
                    torch.testing.assert_close(layer(x), layer.get_base_layer()(x) + delta * strength,
                                               rtol=0, atol=0)
            self.assertFalse(torch.cuda.is_initialized())

    def test_native_and_raw_groups_use_official_hotswap_without_replacing_layers(self):
        pipe = pipeline()
        with tempfile.TemporaryDirectory() as directory:
            files = [Path(directory) / f"{index}.safetensors" for index in range(4)]
            for path, value, layout in zip(files, (.125, .25, .375, .5), ("native", "raw", "raw", "native")):
                weights(pipe, path, value, layout=layout)
            helper.load_loras(pipe, [{"path": str(files[0]), "strength": .5}, {"path": str(files[1]), "strength": .25}])
            retained = layers(pipe)
            rows = [{"path": str(files[2]), "strength": -.5}, {"path": str(files[3]), "strength": .75}]
            self.assertTrue(helper.try_hotswap(pipe, rows))
            for layer, old in zip(layers(pipe), retained):
                self.assertIs(layer, old)
                self.assertEqual(layer.scaling, {"huiyu_0": -.5, "huiyu_1": .75})
                self.assertTrue(torch.equal(layer.lora_B["huiyu_0"].weight, torch.full_like(layer.lora_B["huiyu_0"].weight, .375)))
                self.assertTrue(torch.equal(layer.lora_B["huiyu_1"].weight, torch.full_like(layer.lora_B["huiyu_1"].weight, .5)))

    def test_incompatible_later_adapter_and_invalid_weights_do_not_change_any_old_state(self):
        pipe = pipeline()
        with tempfile.TemporaryDirectory() as directory:
            files = [Path(directory) / f"{index}.safetensors" for index in range(4)]
            weights(pipe, files[0], .125)
            weights(pipe, files[1], .25)
            weights(pipe, files[2], .5)
            weights(pipe, files[3], .5, rank=3)
            rows = [{"path": str(files[index]), "strength": .5} for index in (0, 1)]
            helper.load_loras(pipe, rows)
            def snapshot():
                return {component: {k: v.detach().clone() for k, v in getattr(pipe, component).state_dict().items()}
                        for component in TARGETS}
            old = snapshot()
            candidate = [{"path": str(files[index]), "strength": -.5} for index in (2, 3)]
            with patch.object(pipe, "load_lora_weights", wraps=pipe.load_lora_weights) as calls:
                self.assertFalse(helper.try_hotswap(pipe, candidate))
                calls.assert_not_called()
                self.assertFalse(helper.try_hotswap(pipe, candidate[:1]))
                self.assertFalse(helper.try_hotswap(pipe, []))
            for component, state in snapshot().items():
                for key, value in state.items():
                    self.assertTrue(torch.equal(value, old[component][key]))
            valid = weights(pipe, files[3], .5, layout="native")
            bad = {key: value.float() for key, value in valid.items()}
            bad[next(iter(bad))].fill_(float("nan"))
            save_file(bad, str(files[3]))
            with patch.object(pipe, "load_lora_weights", wraps=pipe.load_lora_weights) as calls:
                with self.assertRaisesRegex(helper.UnsupportedLora, "finite"):
                    helper.try_hotswap(pipe, candidate)
                calls.assert_not_called()
            for component, state in snapshot().items():
                for key, value in state.items():
                    self.assertTrue(torch.equal(value, old[component][key]))

    def test_advanced_config_is_inapplicable_and_execution_errors_propagate(self):
        pipe = pipeline()
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "adapter.safetensors"
            weights(pipe, file, .125)
            rows = [{"path": str(file), "strength": .5}]
            helper.load_loras(pipe, rows)
            old = pipe.transformer.peft_config["huiyu_0"].init_lora_weights
            pipe.transformer.peft_config["huiyu_0"].init_lora_weights = "pissa"
            with patch.object(pipe, "load_lora_weights", wraps=pipe.load_lora_weights) as calls:
                self.assertFalse(helper.try_hotswap(pipe, rows))
                calls.assert_not_called()
            pipe.transformer.peft_config["huiyu_0"].init_lora_weights = old
            original = pipe.load_lora_weights
            def fail_after_mutation(*args, **kwargs):
                original(*args, **kwargs)
                raise RuntimeError("injected post-hotswap failure")
            with patch.object(pipe, "load_lora_weights", side_effect=fail_after_mutation) as calls:
                with self.assertRaisesRegex(RuntimeError, "post-hotswap"):
                    helper.try_hotswap(pipe, rows)
                self.assertEqual(calls.call_count, 1)


if __name__ == "__main__":
    unittest.main()
