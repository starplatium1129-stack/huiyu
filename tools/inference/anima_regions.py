"""Regional positive conditioning and task-owned cross-attention processors.

Routing adapted from InvokeAI v6.14.2 AnimaRegionalPromptingExtension
and AnimaDenoiseInvocation._run_llm_adapter_for_regions (Apache-2.0):
https://github.com/invoke-ai/InvokeAI/blob/v6.14.2/invokeai/backend/anima/regional_prompting.py
Copyright InvokeAI contributors. Apache License 2.0, distributed AS IS:
https://www.apache.org/licenses/LICENSE-2.0
Changes: normalized rectangles, explicit CFG lane, pinned Diffusers components,
current HUIYU token weights and no base model/attention-forward replacement.
"""
import torch


def encode(components, regions, tools, check):
    from diffusers.modular_pipelines.anima.before_denoise import AnimaTextConditioningStep
    plans, encoded = [], []
    weighting = tools("anima_prompt_weights")
    device, dtype = components._execution_device, components.text_encoder.dtype
    for region in regions:
        check()
        plan = weighting.tokenize_prompt(region["prompt"], components.tokenizer, components.t5_tokenizer)
        qids = torch.tensor([plan["qwen_ids"]], dtype=torch.long, device=device)
        qmask = torch.tensor([plan["qwen_mask"]], dtype=torch.long, device=device)
        qwen = components.text_encoder(input_ids=qids, attention_mask=qmask,
            output_hidden_states=False).last_hidden_state.to(device=device, dtype=dtype)
        encoded.append((qwen * qmask.to(qwen).unsqueeze(-1), qmask,
            torch.tensor([plan["t5_ids"]], dtype=torch.long, device=device)))
        plans.append(plan)
    results = []
    for plan, (qwen, qmask, tids) in zip(plans, encoded):
        check()
        context = AnimaTextConditioningStep._condition_prompt_embeds(components, qwen, qmask,
            tids, torch.ones_like(tids), device, components.text_conditioner.dtype, components.transformer.dtype)
        if plan["active"]:
            if context.shape[1] < len(plan["weights"]) or any(abs(n) > torch.finfo(context.dtype).max for n in plan["weights"]):
                raise ValueError("Regional token weights do not fit the conditioned tensor")
            weights = plan["weights"] + [1.0] * (context.shape[1] - len(plan["weights"]))
            context = context * torch.tensor(weights, dtype=context.dtype, device=context.device)[None, :, None]
        results.append(context)
    return results


class RegionalProcessor:
    def __init__(self, original, owner):
        self.original, self.owner = original, owner

    def __call__(self, attn, hidden_states, encoder_hidden_states=None, attention_mask=None, image_rotary_emb=None):
        mask = self.owner.mask if self.owner.positive else None
        if mask is not None:
            if hidden_states.shape[1] != mask.shape[-2] or encoder_hidden_states is None or encoder_hidden_states.shape[1] != mask.shape[-1]:
                raise ValueError("Regional attention token grid does not match the active conditioning")
            if attention_mask is not None:
                raise ValueError("Regional composition does not accept an additional attention mask")
            attention_mask = mask
        return self.original(attn, hidden_states, encoder_hidden_states=encoder_hidden_states,
            attention_mask=attention_mask, image_rotary_emb=image_rotary_emb)


class Regions:
    def __init__(self, regions):
        self.regions, self.originals = regions, []
        self.mask, self.positive = None, False
        self.lengths = None

    def bind(self, transformer):
        try:
            for index, block in enumerate(transformer.transformer_blocks):
                if index % 2 == 0:
                    self.originals.append((block.attn2, block.attn2.processor))
                    block.attn2.set_processor(RegionalProcessor(block.attn2.processor, self))
        except BaseException:
            self.close()
            raise

    def context(self, global_context, contexts):
        self.lengths = [global_context.shape[1], *(context.shape[1] for context in contexts)]
        return torch.cat([global_context, *contexts], dim=1)

    def prepare_mask(self, latents):
        if self.mask is not None:
            return
        if self.lengths is None or latents.shape[2] != 1:
            raise ValueError("Regional composition requires prepared single-image text conditioning")
        height, width = (latents.shape[-2] + 1) // 2, (latents.shape[-1] + 1) // 2
        yy = (torch.arange(height, device=latents.device) + .5) / height
        xx = (torch.arange(width, device=latents.device) + .5) / width
        masks = []
        for region in self.regions:
            area = ((yy[:, None] >= region["y"]) & (yy[:, None] < min(1., region["y"] + region["height"]))
                & (xx[None, :] >= region["x"]) & (xx[None, :] < min(1., region["x"] + region["width"]))).flatten()
            if not bool(area.any()):
                raise ValueError("A regional rectangle covers no image tokens; enlarge it before generating")
            masks.append(area)
        background = ~torch.stack(masks).any(dim=0)
        self.mask = torch.cat([area[:, None].expand(-1, length)
            for area, length in zip([background, *masks], self.lengths)], dim=1)[None, None]

    def close(self):
        for attention, original in reversed(self.originals):
            attention.set_processor(original)
        self.originals.clear()
        self.mask, self.lengths, self.positive = None, None, False
