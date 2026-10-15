"""Independent Anima round-bracket weighting over Apache-2.0 Diffusers blocks.

Contract: (text) inherits weight * 1.1; (text:number) overrides inherited
weight. Nested groups preserve fragment boundaries even at weight 1. Escaped
parentheses are literal. Square brackets and BREAK are literal, never A1111
de-emphasis or chunk separators. No Comfy implementation is imported/copied.
Qwen uses fragment token IDs without weights; T5 weights multiply the resulting
conditioner output. Appended EOS and zero padding have unit weight.
Official block/tokenizer APIs:
https://github.com/huggingface/diffusers/tree/v0.41.0/src/diffusers/modular_pipelines/anima
https://huggingface.co/docs/transformers/model_doc/t5
"""
import math

WEIGHTS_SCOPE = "anima-round-t5-v1"
MAX_TOKENS = 512


def uses_syntax(prompt):
    """Stdlib-only profile flag; [] and BREAK do not activate weighting."""
    return isinstance(prompt, str) and ("(" in prompt or ")" in prompt)


def weights_scope(prompt, negative_prompt=None):
    return WEIGHTS_SCOPE if uses_syntax(prompt) or uses_syntax(negative_prompt) else None


def parse_prompt(prompt):
    """Return ordered (text, weight) fragments and whether syntax was present.

    Unbalanced parentheses and invalid/nonfinite explicit weights are errors.
    Within a group a final colon introduces its explicit numeric weight.
    """
    if not isinstance(prompt, str):
        raise ValueError("Anima weighting accepts a single prompt string")
    if not uses_syntax(prompt):
        return [(prompt, 1.0)], False
    frames = [[]]
    text = []

    def flush():
        if text:
            frames[-1].append("".join(text))
            text.clear()

    index = 0
    while index < len(prompt):
        char = prompt[index]
        if char == "\\" and index + 1 < len(prompt) and prompt[index + 1] in "()":
            text.append(prompt[index + 1])
            index += 2
            continue
        if char == "(":
            flush()
            frames.append([])
        elif char == ")":
            if len(frames) == 1:
                raise ValueError("Unmatched closing parenthesis in Anima prompt; escape literal parentheses")
            flush()
            children = frames.pop()
            explicit = None
            if children and isinstance(children[-1], str) and ":" in children[-1]:
                body, number = children[-1].rsplit(":", 1)
                try:
                    explicit = float(number)
                except ValueError as exc:
                    raise ValueError("Anima prompt has an invalid explicit weight") from exc
                if not math.isfinite(explicit):
                    raise ValueError("Anima prompt weight must be finite")
                children[-1] = body
            frames[-1].append((children, explicit))
        else:
            text.append(char)
        index += 1
    flush()
    if len(frames) != 1:
        raise ValueError("Unclosed parenthesis in Anima prompt; escape literal parentheses")
    output, pending = [], [(node, 1.0) for node in reversed(frames[0])]
    while pending:
        node, inherited = pending.pop()
        if isinstance(node, str):
            if node:
                output.append((node, inherited))
        else:
            children, explicit = node
            weight = inherited * 1.1 if explicit is None else explicit
            if not math.isfinite(weight):
                raise ValueError("Nested Anima prompt weight overflowed")
            pending.extend((child, weight) for child in reversed(children))
    return output, True


def tokenize_prompt(prompt, qwen_tokenizer, t5_tokenizer, *, limit=MAX_TOKENS):
    """Use real tokenizer IDs, never characters or estimated token counts."""
    fragments, active = parse_prompt(prompt)
    if active:
        qwen_ids, t5_ids, weights = [], [], []
        for fragment, weight in fragments:
            qwen_ids.extend(qwen_tokenizer(fragment, add_special_tokens=False, truncation=False)["input_ids"])
            ids = t5_tokenizer(fragment, add_special_tokens=False, truncation=False)["input_ids"]
            t5_ids.extend(ids)
            weights.extend([weight] * len(ids))
        eos = t5_tokenizer.eos_token_id
        if eos is None:
            raise ValueError("Anima weighting requires a T5 EOS token")
        t5_ids.append(eos)
        weights.append(1.0)
    else:
        qwen_ids = qwen_tokenizer(prompt, truncation=False)["input_ids"]
        t5_ids = t5_tokenizer(prompt, truncation=False)["input_ids"]
        weights = [1.0] * len(t5_ids)
    counts = (len(qwen_ids), len(t5_ids))
    if max(counts) > limit:
        raise ValueError(f"Anima prompt exceeds {limit} tokens: Qwen={counts[0]}, T5={counts[1]}; truncation is disabled")
    qwen_mask = [1] * len(qwen_ids)
    if not qwen_ids:
        if active:
            raise ValueError("Anima weighted prompt contains no Qwen tokens; use an ordinary empty negative prompt instead")
        # Match the pinned encoder's empty-Qwen placeholder and zero attention.
        qwen_ids, qwen_mask = [0], [0]
    return dict(active=active, qwen_ids=qwen_ids, qwen_mask=qwen_mask,
                t5_ids=t5_ids, weights=weights, counts=counts,
                key=(tuple(qwen_ids), tuple(qwen_mask), tuple(t5_ids)))


def apply_prompt_weights(blocks, *, cache=None):
    """Wrap fresh first-pass blocks AFTER apply_text_cache(blocks, cache).

    Plain prompts delegate to the original encoder after a length preflight.
    Weighted raw states use the same bounded TextCache with actual token keys;
    changing only weights can reuse Qwen/T5, never conditioned embeddings.
    Hires blocks with both encoding and conditioning removed remain untouched.
    """
    import torch
    from diffusers.modular_pipelines.anima.encoders import AnimaTextEncoderStep
    if blocks is None:
        from diffusers.modular_pipelines.anima.modular_blocks_anima import AnimaAutoBlocks
        blocks = AnimaAutoBlocks()

    routes = [blocks.sub_blocks["denoise"].sub_blocks[name] for name in ("text2image", "img2img")]
    conditioners = [route for route in routes if "text_conditioning" in route.sub_blocks]
    if "text_encoder" not in blocks.sub_blocks and not conditioners:
        return blocks
    if "text_encoder" not in blocks.sub_blocks or len(conditioners) != 2:
        raise ValueError("Anima weighting requires complete first-pass encoder/conditioner blocks")
    original_encoder = blocks.sub_blocks["text_encoder"]
    if getattr(original_encoder, "_huiyu_prompt_weights", False):
        raise ValueError("Anima prompt weighting is already installed on these blocks")
    plans = {}

    class WeightedEncoder(type(original_encoder)):
        _huiyu_prompt_weights = True

        @staticmethod
        def _get_qwen_prompt_embeds(components, prompt, max_sequence_length, device, dtype):
            item = plans[prompt[0]]
            if not item["active"]:
                return AnimaTextEncoderStep._get_qwen_prompt_embeds(
                    components, prompt, max_sequence_length, device, dtype)
            ids = torch.tensor([item["qwen_ids"]], dtype=torch.long, device=device)
            mask = torch.tensor([item["qwen_mask"]], dtype=torch.long, device=device)
            encoded = components.text_encoder(input_ids=ids, attention_mask=mask,
                                              output_hidden_states=False).last_hidden_state.to(device=device, dtype=dtype)
            return encoded * mask.to(encoded).unsqueeze(-1), mask

        @staticmethod
        def _get_t5_prompt_ids(components, prompt, max_sequence_length, device):
            item = plans[prompt[0]]
            if not item["active"]:
                return AnimaTextEncoderStep._get_t5_prompt_ids(components, prompt, max_sequence_length, device)
            ids = torch.tensor([item["t5_ids"]], dtype=torch.long, device=device)
            return ids, torch.ones_like(ids)

        @torch.no_grad()
        def __call__(self, components, state):
            plans.clear()
            block = self.get_block_state(state)
            self.check_inputs(block)
            if not isinstance(block.prompt, str) or not isinstance(block.negative_prompt, (str, type(None))):
                raise ValueError("Anima weighting supports one positive and negative string, not prompt batches")
            limit = min(block.max_sequence_length or MAX_TOKENS, MAX_TOKENS)
            branches = [block.prompt]
            if components.guider.num_conditions > 1:
                branches.append(block.negative_prompt or "")
            for prompt in branches:
                plans[prompt] = tokenize_prompt(prompt, components.tokenizer, components.t5_tokenizer, limit=limit)
            if not any(item["active"] for item in plans.values()):
                return original_encoder(components, state)
            device = components._execution_device
            key = ((WEIGHTS_SCOPE, plans[branches[0]]["key"]),
                   (WEIGHTS_SCOPE, plans[branches[1]]["key"]) if len(branches) > 1 else None,
                   limit, len(branches) > 1, str(components.text_encoder.dtype), str(device))
            values = cache.get(key, device) if cache is not None else None
            missed = values is None
            if values is None:
                negative = cache.get_negative(key, device) if cache is not None and key[3] else None
                if negative is None:
                    components, state = AnimaTextEncoderStep.__call__(self, components, state)
                    if cache is not None:
                        cache.put(key, {output.name: state.get(output.name) for output in self.intermediate_outputs})
                    return components, state
                # Keep classmethod dispatch on this encoder so positive token
                # overrides remain active while reusing only raw negative states.
                values = self.encode_prompt(
                    components=components, prompt=block.prompt, prepare_unconditional_embeds=False,
                    max_sequence_length=block.max_sequence_length, device=device, dtype=components.text_encoder.dtype)
                values.update(negative)
            for name, value in values.items():
                setattr(block, name, value)
            self.set_block_state(state, block)
            if missed:
                cache.put(key, values, reuse_negative=True)
            return components, state

    def wrap_conditioner(original):
        class WeightedConditioner(type(original)):
            @torch.no_grad()
            def __call__(self, components, state):
                components, state = original(components, state)
                prompts = (state.get("prompt"), state.get("negative_prompt") or "")
                for prompt, name in zip(prompts, ("prompt_embeds", "negative_prompt_embeds")):
                    item, value = plans.get(prompt), state.get(name)
                    if item is None or not item["active"] or value is None:
                        continue
                    if value.shape[0] != 1 or value.shape[1] < len(item["weights"]):
                        raise ValueError("Anima conditioned token shape does not match its prompt weights")
                    if any(abs(weight) > torch.finfo(value.dtype).max for weight in item["weights"]):
                        raise ValueError("Anima prompt weight exceeds the conditioned tensor dtype")
                    # The official conditioner already zero-pads to at least 512.
                    # Unit padding preserves that result exactly; no mean rescale.
                    weights = item["weights"] + [1.0] * (value.shape[1] - len(item["weights"]))
                    scale = torch.tensor(weights, dtype=value.dtype, device=value.device)[None, :, None]
                    state.set(name, value * scale)
                return components, state
        return WeightedConditioner()

    blocks.sub_blocks["text_encoder"] = WeightedEncoder()
    for route in conditioners:
        route.sub_blocks["text_conditioning"] = wrap_conditioner(route.sub_blocks["text_conditioning"])
    return blocks
