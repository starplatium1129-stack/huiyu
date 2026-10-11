"""Real CPU tokenizer/conditioner contracts; no model downloads or CUDA."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import sentencepiece
import torch
from tokenizers.pre_tokenizers import ByteLevel
from transformers import Qwen2Tokenizer, Qwen3Config, Qwen3Model, T5Tokenizer, T5TokenizerFast
from diffusers import AnimaTextConditioner, ClassifierFreeGuidance
from diffusers.modular_pipelines.anima.before_denoise import AnimaTextConditioningStep
from diffusers.modular_pipelines.anima.modular_blocks_anima import AnimaAutoBlocks
from diffusers.modular_pipelines.modular_pipeline import PipelineState

import anima_prompt_weights as weights
from anima_text_cache import TextCache, apply_text_cache


class PromptWeightTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        root = Path(cls.temp.name)
        corpus = root / "corpus.txt"
        corpus.write_text("red hair blue long literal score_7 BREAK safe portrait\n" * 10, encoding="utf-8")
        sentencepiece.SentencePieceTrainer.train(input=str(corpus), model_prefix=str(root / "spiece"),
            vocab_size=40, model_type="unigram", pad_id=0, eos_id=1, unk_id=2, bos_id=-1,
            hard_vocab_limit=False, minloglevel=2)
        (root / "tokenizer_config.json").write_text(json.dumps({"tokenizer_class": "T5Tokenizer", "extra_ids": 0}))
        cls.sentencepiece = T5Tokenizer.from_pretrained(root, local_files_only=True)
        cls.sentencepiece.save_pretrained(root / "fast")
        cls.fast = T5TokenizerFast.from_pretrained(root / "fast", local_files_only=True)
        vocabulary = {token: index for index, token in enumerate(
            ["<|endoftext|>", *sorted(ByteLevel.alphabet()), "ha", "hai", "hair", "Ġhair"])}
        cls.qwen = Qwen2Tokenizer(vocab=vocabulary, merges=[("h", "a"), ("ha", "i"), ("hai", "r"), ("Ġ", "hair")])
        torch.manual_seed(19)
        cls.components = SimpleNamespace(
            tokenizer=cls.qwen, t5_tokenizer=cls.fast, _execution_device=torch.device("cpu"),
            text_encoder=Qwen3Model(Qwen3Config(vocab_size=len(vocabulary), hidden_size=8,
                intermediate_size=16, num_hidden_layers=1, num_attention_heads=2, num_key_value_heads=1,
                head_dim=4, pad_token_id=0)).eval(),
            text_conditioner=AnimaTextConditioner(source_dim=8, target_dim=4, model_dim=4, num_layers=1,
                num_attention_heads=1, target_vocab_size=len(cls.fast), min_sequence_length=512).eval(),
            transformer=SimpleNamespace(dtype=torch.float32), guider=ClassifierFreeGuidance(guidance_scale=4.))

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def state(self, prompt, negative="blue"):
        return PipelineState(values=dict(prompt=prompt, negative_prompt=negative, max_sequence_length=512))

    def encode(self, blocks, prompt, negative="blue"):
        state = self.state(prompt, negative)
        _, state = blocks.sub_blocks["text_encoder"](self.components, state)
        return state

    def condition(self, blocks, state):
        step = blocks.sub_blocks["denoise"].sub_blocks["text2image"].sub_blocks["text_conditioning"]
        return step(self.components, state)[1]

    def test_round_grammar_and_literal_square_break_contract(self):
        self.assertEqual(weights.parse_prompt("red (long (hair:1.2))")[0],
                         [("red ", 1.), ("long ", 1.1), ("hair", 1.2)])
        self.assertEqual(weights.parse_prompt("((hair))")[0], [("hair", 1.1 * 1.1)])
        self.assertEqual(weights.parse_prompt(r"score_7 \(literal\)")[0], [("score_7 (literal)", 1.)])
        self.assertEqual(weights.parse_prompt("[red hair] BREAK"), ([("[red hair] BREAK", 1.)], False))
        self.assertTrue(weights.uses_syntax("(hair:1)"))
        for prompt in ("(hair", "hair)", "(hair:abc)", "(hair:nan)", "(hair:1e999)"):
            with self.subTest(prompt=prompt), self.assertRaises(ValueError):
                weights.parse_prompt(prompt)

    def test_sentencepiece_and_json_fast_eos_token_weights(self):
        for tokenizer in (self.sentencepiece, self.fast):
            with self.subTest(tokenizer=tokenizer.name_or_path):
                plan = weights.tokenize_prompt("red (hair:1.2)", self.qwen, tokenizer)
                red = tokenizer("red ", add_special_tokens=False)["input_ids"]
                hair = tokenizer("hair", add_special_tokens=False)["input_ids"]
                self.assertEqual(plan["t5_ids"], red + hair + [tokenizer.eos_token_id])
                self.assertEqual(plan["weights"], [1.] * len(red) + [1.2] * len(hair) + [1.])
                self.assertEqual(weights.tokenize_prompt("", self.qwen, tokenizer)["t5_ids"], [1])
                with self.assertRaisesRegex(ValueError, "no Qwen tokens"):
                    weights.tokenize_prompt("()", self.qwen, tokenizer)
        self.assertEqual(weights.tokenize_prompt("(red hair:1.2)", self.qwen, self.sentencepiece)["t5_ids"],
                         weights.tokenize_prompt("(red hair:1.2)", self.qwen, self.fast)["t5_ids"])

    def test_plain_prompts_preserve_original_encoder_and_conditioner_values(self):
        from native_upload import offload_after_encoding
        original, wrapped = AnimaAutoBlocks(), AnimaAutoBlocks()
        cache = TextCache()
        apply_text_cache(wrapped, cache)
        weights.apply_prompt_weights(wrapped, cache=cache)
        offload_after_encoding(wrapped)
        first = self.condition(original, self.encode(original, "red hair [blue] BREAK"))
        second = self.condition(wrapped, self.encode(wrapped, "red hair [blue] BREAK"))
        for name in ("qwen_prompt_embeds", "t5_input_ids", "prompt_embeds", "negative_prompt_embeds"):
            self.assertTrue(torch.equal(first.get(name), second.get(name)), name)
        self.assertFalse(torch.cuda.is_initialized())

    def test_raw_cache_reuses_tokens_but_applies_each_jobs_weights_once_after_conditioner(self):
        blocks, cache = AnimaAutoBlocks(), TextCache()
        apply_text_cache(blocks, cache)
        weights.apply_prompt_weights(blocks, cache=cache)
        first = self.encode(blocks, "red (hair:1.5)", "(blue:0.5)")
        raw = PipelineState(values=dict(first.values))
        _, raw = AnimaTextConditioningStep()(self.components, raw)
        first = self.condition(blocks, first)
        red_count = len(self.fast("red ", add_special_tokens=False)["input_ids"])
        end = first.t5_input_ids.shape[1] - 1
        self.assertTrue(torch.equal(first.prompt_embeds[:, :red_count], raw.prompt_embeds[:, :red_count]))
        self.assertTrue(torch.equal(first.prompt_embeds[:, red_count:end], raw.prompt_embeds[:, red_count:end] * 1.5))
        self.assertTrue(torch.equal(first.prompt_embeds[:, end:], raw.prompt_embeds[:, end:]))
        negative_end = first.negative_t5_input_ids.shape[1] - 1
        self.assertTrue(torch.equal(first.negative_prompt_embeds[:, :negative_end], raw.negative_prompt_embeds[:, :negative_end] * .5))
        self.assertTrue(torch.equal(first.negative_prompt_embeds[:, negative_end:], raw.negative_prompt_embeds[:, negative_end:]))
        with patch.object(self.components.text_encoder, "forward", wraps=self.components.text_encoder.forward) as forward:
            second = self.condition(blocks, self.encode(blocks, "red (hair:0.5)", "(blue:1.5)"))
            forward.assert_not_called()
        self.assertTrue(torch.equal(first.qwen_prompt_embeds, second.qwen_prompt_embeds))
        self.assertTrue(torch.equal(second.prompt_embeds[:, red_count:end], raw.prompt_embeds[:, red_count:end] * .5))
        self.assertEqual(cache.hits, 1)
        # Same cleaned text, different fragment tokenization: cannot share raw cache.
        with patch.object(self.components.text_encoder, "forward", wraps=self.components.text_encoder.forward) as forward:
            self.encode(blocks, "(red hair:0.5)", "(blue:1.5)")
            self.assertGreater(forward.call_count, 0)
        self.assertEqual(cache.misses, 2)

    def test_plain_and_weighted_long_inputs_fail_before_qwen_without_truncation(self):
        blocks = weights.apply_prompt_weights(AnimaAutoBlocks())
        with patch.object(self.components.text_encoder, "forward", wraps=self.components.text_encoder.forward) as forward:
            for prompt in ("hair " * 600, "(" + "hair " * 600 + ":1.2)"):
                with self.assertRaisesRegex(ValueError, r"exceeds 512 tokens: Qwen=\d+, T5=\d+; truncation is disabled"):
                    self.encode(blocks, prompt)
            forward.assert_not_called()

    def test_bf16_weights_use_conditioned_dtype_and_preserve_eos_padding(self):
        previous = self.components.transformer.dtype
        self.components.transformer.dtype = torch.bfloat16
        try:
            blocks = weights.apply_prompt_weights(AnimaAutoBlocks())
            state = self.encode(blocks, "(hair:1.2)")
            raw = PipelineState(values=dict(state.values))
            _, raw = AnimaTextConditioningStep()(self.components, raw)
            result = self.condition(blocks, state)
            end = state.t5_input_ids.shape[1] - 1
            self.assertEqual(result.prompt_embeds.dtype, torch.bfloat16)
            expected = raw.prompt_embeds[:, :end] * torch.tensor(1.2, dtype=torch.bfloat16)
            self.assertTrue(torch.equal(result.prompt_embeds[:, :end], expected))
            self.assertTrue(torch.equal(result.prompt_embeds[:, end:], raw.prompt_embeds[:, end:]))
        finally:
            self.components.transformer.dtype = previous

    def test_hires_without_encoder_or_conditioner_is_not_wrapped_again(self):
        blocks = AnimaAutoBlocks()
        blocks.sub_blocks.pop("text_encoder")
        for name in ("text2image", "img2img"):
            blocks.sub_blocks["denoise"].sub_blocks[name].sub_blocks.pop("text_conditioning")
        self.assertIs(weights.apply_prompt_weights(blocks), blocks)

    def test_scope_helpers_load_under_isolated_python_without_site_packages(self):
        source = """
import importlib.util, sys
spec=importlib.util.spec_from_file_location('weight_scope',sys.argv[1])
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
assert module.weights_scope('[hair] BREAK') is None
assert module.weights_scope('hair','(blue:1)') == module.WEIGHTS_SCOPE
assert module.uses_syntax(r'\\(literal\\)')
assert 'torch' not in sys.modules and 'diffusers' not in sys.modules
"""
        result = subprocess.run([sys.executable, "-I", "-S", "-c", source,
                                 str(Path(weights.__file__))], capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
