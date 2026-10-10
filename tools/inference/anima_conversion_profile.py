"""One explicit raw Anima architecture; mappings adapted from Diffusers 0.41.0.

Upstream: huggingface/diffusers scripts/convert_{anima,cosmos}_to_diffusers.py.
Apache-2.0: https://github.com/huggingface/diffusers/blob/v0.41.0/LICENSE
Changes: fixed profile, collision errors, no dropped keys or arbitrary config/code.
Model/checkpoint licenses are separate; this module grants no rights to weights.
"""
from __future__ import annotations

PROFILE = "anima-cosmos2b-v041"
SOURCES = ["https://github.com/huggingface/diffusers/blob/v0.41.0/scripts/" + name
           for name in ("convert_anima_to_diffusers.py", "convert_cosmos_to_diffusers.py")]
SOURCE_BLOBS = {"convert_anima_to_diffusers.py": "bf8e006ad266fa33f5395a5d8ffb8e0ba69d175f",
                "convert_cosmos_to_diffusers.py": "b6f321b5b2fbaaebe2028c99627f20ca20ea6b61"}
TRANSFORMER = dict(in_channels=16, out_channels=16, num_attention_heads=16,
                   attention_head_dim=128, num_layers=28, mlp_ratio=4.0,
                   text_embed_dim=1024, adaln_lora_dim=256, max_size=[128, 240, 240],
                   patch_size=[1, 2, 2], rope_scale=[1.0, 4.0, 4.0],
                   concat_padding_mask=True, extra_pos_embed_type=None)
TRANSFORMER_DEFAULTS = dict(use_crossattn_projection=False, crossattn_proj_in_channels=1024,
                           encoder_hidden_states_channels=1024, controlnet_block_every_n=None,
                           img_context_dim_in=None, img_context_num_tokens=256, img_context_dim_out=2048)
CONDITIONER = dict(source_dim=1024, target_dim=1024, model_dim=1024, num_layers=6,
                   num_attention_heads=16, mlp_ratio=4.0, target_vocab_size=32128,
                   use_self_attention=True, use_layer_norm=False, min_sequence_length=512)
QWEN = dict(vocab_size=151936, hidden_size=1024, intermediate_size=3072,
            num_hidden_layers=28, num_attention_heads=16, num_key_value_heads=8,
            head_dim=128, max_position_embeddings=32768, rms_norm_eps=1e-6,
            rope_theta=1000000.0, attention_bias=False, tie_word_embeddings=False)
VAE = dict(base_dim=96, z_dim=16, dim_mult=[1, 2, 4, 4], num_res_blocks=2,
           attn_scales=[], temperal_downsample=[False, True, True], dropout=0.0,
           input_channels=3,
           latents_mean=[-0.7571, -0.7089, -0.9113, 0.1075, -0.1745, 0.9653, -0.1517, 1.5508,
                         0.4134, -0.0715, 0.5517, -0.3632, -0.1922, -0.9497, 0.2503, -0.2921],
           latents_std=[2.8184, 1.4541, 2.3275, 2.6558, 1.2196, 1.7708, 2.6052, 2.0743,
                        3.2687, 2.1526, 2.8652, 1.5579, 1.6382, 1.1253, 2.8251, 1.9160])

# Order follows the Apache-licensed Cosmos 2.0 converter. These are name-only
# rewrites, not reshape/transposition guesses. Exact meta-model schemas below
# are the authority; training counters/position buffers are deliberately rejected.
TRANSFORMER_RENAMES = {
    "t_embedder.1": "time_embed.t_embedder", "t_embedding_norm": "time_embed.norm",
    "blocks": "transformer_blocks",
    "adaln_modulation_self_attn.1": "norm1.linear_1", "adaln_modulation_self_attn.2": "norm1.linear_2",
    "adaln_modulation_cross_attn.1": "norm2.linear_1", "adaln_modulation_cross_attn.2": "norm2.linear_2",
    "adaln_modulation_mlp.1": "norm3.linear_1", "adaln_modulation_mlp.2": "norm3.linear_2",
    "self_attn": "attn1", "cross_attn": "attn2", "q_proj": "to_q", "k_proj": "to_k",
    "v_proj": "to_v", "output_proj": "to_out.0", "q_norm": "norm_q", "k_norm": "norm_k",
    "mlp.layer1": "ff.net.0.proj", "mlp.layer2": "ff.net.2",
    "x_embedder.proj.1": "patch_embed.proj",
    "final_layer.adaln_modulation.1": "norm_out.linear_1",
    "final_layer.adaln_modulation.2": "norm_out.linear_2", "final_layer.linear": "proj_out",
}


def replace(key, replacements):
    for old, new in replacements.items():
        key = key.replace(old, new)
    return key


def vae_key(key):
    for old, new in {"conv1.": "quant_conv.", "conv2.": "post_quant_conv.",
                     "encoder.conv1.": "encoder.conv_in.", "decoder.conv1.": "decoder.conv_in.",
                     "encoder.downsamples.": "encoder.down_blocks.",
                     "encoder.head.0.": "encoder.norm_out.", "encoder.head.2.": "encoder.conv_out.",
                     "decoder.head.0.": "decoder.norm_out.", "decoder.head.2.": "decoder.conv_out."}.items():
        if key.startswith(old):
            key = new + key.removeprefix(old)
            break
    if key.startswith("decoder.upsamples."):
        index, rest = key.removeprefix("decoder.upsamples.").split(".", 1)
        index = int(index)
        if index in (3, 7, 11):
            key = f"decoder.up_blocks.{(index - 3) // 4}.upsamplers.0.{rest}"
        else:
            key = f"decoder.up_blocks.{index // 4}.resnets.{index % 4}.{rest}"
    return replace(key, {".middle.0.": ".mid_block.resnets.0.", ".middle.1.": ".mid_block.attentions.0.",
                         ".middle.2.": ".mid_block.resnets.1.", ".residual.0.": ".norm1.",
                         ".residual.2.": ".conv1.", ".residual.3.": ".norm2.",
                         ".residual.6.": ".conv2.", ".shortcut.": ".conv_shortcut."})


def map_headers(headers):
    """Return destination -> original names. Every tensor has exactly one owner."""
    result = {name: {} for name in ("transformer", "text_conditioner", "text_encoder", "vae")}
    encoder = headers["text_encoder"]
    prefixed = [key.startswith("model.") for key in encoder]
    if any(prefixed) and not all(prefixed):
        raise ValueError("Mixed Qwen model. prefixes are unsupported")
    for source, tensors in headers.items():
        for old, tensor in tensors.items():
            if tensor["dtype"] not in {"F16", "BF16", "F32"}:
                raise ValueError(f"Unsupported weight dtype {tensor['dtype']}: {old}; no quantized conversion")
            if source == "checkpoint":
                if not old.startswith("net."):
                    raise ValueError(f"Expected uniform raw net. prefix: {old}")
                component = "text_conditioner" if old.startswith("net.llm_adapter.") else "transformer"
                new = (old.removeprefix("net.llm_adapter.") if component == "text_conditioner" else
                       replace(old.removeprefix("net."), TRANSFORMER_RENAMES))
            else:
                component = source
                new = old.removeprefix("model.") if source == "text_encoder" else vae_key(old)
            if new in result[component]:
                raise ValueError(f"Converted key collision: {component}.{new}")
            result[component][new] = old
    return result


def validate_config(config):
    allowed = {**TRANSFORMER, **TRANSFORMER_DEFAULTS}
    metadata = {"_class_name", "_diffusers_version", "_name_or_path"}
    if set(config) - set(allowed) - metadata:
        raise ValueError("Unknown/unsafe transformer config fields: " + ", ".join(sorted(set(config) - set(allowed) - metadata)))
    if config.get("_class_name", "CosmosTransformer3DModel") != "CosmosTransformer3DModel":
        raise ValueError("Transformer config must describe CosmosTransformer3DModel")
    for name, expected in allowed.items():
        if name not in config and name in TRANSFORMER:
            raise ValueError(f"Transformer config requires explicit {name}={expected!r}")
        actual = config.get(name, expected)
        if actual != expected or isinstance(actual, bool) != isinstance(expected, bool):
            raise ValueError(f"Unsupported transformer config {name}={actual!r}; profile requires {expected!r}")


def validate_anchors(headers):
    anchors = {
        "checkpoint": {"net.x_embedder.proj.1.weight": [2048, 68],
                       "net.final_layer.linear.weight": [64, 2048],
                       "net.blocks.0.self_attn.q_norm.weight": [128],
                       "net.blocks.27.mlp.layer1.weight": [8192, 2048],
                       "net.llm_adapter.embed.weight": [32128, 1024],
                       "net.llm_adapter.blocks.5.self_attn.q_norm.weight": [64]},
        "text_encoder": {"embed_tokens.weight": [151936, 1024],
                         "layers.27.mlp.gate_proj.weight": [3072, 1024],
                         "layers.0.self_attn.q_proj.weight": [2048, 1024],
                         "layers.0.self_attn.k_proj.weight": [1024, 1024],
                         "layers.0.self_attn.q_norm.weight": [128]},
        "vae": {"encoder.conv1.weight": [96, 3, 3, 3, 3], "decoder.conv1.weight": [384, 16, 3, 3, 3]},
    }
    for component, expected in anchors.items():
        actual = headers[component]
        if component == "text_encoder":
            actual = {name.removeprefix("model."): value for name, value in actual.items()}
        for name, shape in expected.items():
            if actual.get(name, {}).get("shape") != shape:
                raise ValueError(f"Unsupported {PROFILE} shape: {component}.{name}; expected {shape}")
