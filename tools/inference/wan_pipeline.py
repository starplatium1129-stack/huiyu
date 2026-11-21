"""Wan's shared UMT5 vocabulary and padding contract for T2V and I2V."""
from types import MethodType


def text_encoder(root, contract):
    import torch
    from safetensors import safe_open
    from transformers import UMT5Config, UMT5EncoderModel

    folder = root / "text_encoder"
    index = folder / "model.safetensors.index.json"
    if index.exists():
        names = contract.config(root, index)["weight_map"]
    else:
        with safe_open(contract.safe_file(root, folder / "model.safetensors"), framework="pt") as reader:
            names = reader.keys()
    config = UMT5Config.from_pretrained(folder, local_files_only=True)
    if "shared.weight" in names and "encoder.embed_tokens.weight" not in names:
        # The Wan UMT5 encoder snapshots come from Transformers 4, which
        # constructed the encoder with shared.weight regardless of LM-head
        # tying. Transformers 5 otherwise initializes a second, random table.
        config.tie_word_embeddings = True
    encoder, info = UMT5EncoderModel.from_pretrained(folder, config=config, dtype=torch.bfloat16,
        local_files_only=True, use_safetensors=True, output_loading_info=True)
    if any(info.get(key) for key in ("missing_keys", "unexpected_keys", "mismatched_keys", "error_msgs")):
        raise contract.AdapterError("MODEL_INVALID", f"Wan UMT5 权重与模型结构不匹配：{info}")
    return encoder


def encode_prompt(self, prompt=None, num_videos_per_prompt=1, max_sequence_length=226, device=None, dtype=None):
    import torch.nn.functional as F
    from diffusers.pipelines.wan.pipeline_wan import prompt_clean
    from diffusers.utils.torch_utils import get_module_execution_device

    prompt = [prompt] if isinstance(prompt, str) else prompt
    # Upstream drops the padded UMT5 states and gives the DiT literal zeros
    # in their place. Encode only the actual tokens, then restore that shape.
    tokens = self.tokenizer([prompt_clean(text) for text in prompt], padding="longest", truncation=True,
        max_length=max_sequence_length, add_special_tokens=True, return_attention_mask=True, return_tensors="pt")
    model_device = get_module_execution_device(self.text_encoder)
    mask = tokens.attention_mask.to(model_device)
    hidden = self.text_encoder(tokens.input_ids.to(model_device), mask).last_hidden_state
    hidden = hidden.to(device=device or self._execution_device, dtype=dtype or self.text_encoder.dtype)
    hidden = hidden.masked_fill(~mask.to(hidden.device).bool().unsqueeze(-1), 0)
    padded = F.pad(hidden, (0, 0, 0, max_sequence_length - hidden.shape[1]))
    return padded.repeat_interleave(num_videos_per_prompt, dim=0) if num_videos_per_prompt > 1 else padded


def bind(pipeline):
    pipeline._get_t5_prompt_embeds = MethodType(encode_prompt, pipeline)
    return pipeline
