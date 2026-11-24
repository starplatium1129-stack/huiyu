"""Native H3 audio and video VAEs from the packed local component files."""
import torch
from torch import nn
from torch.nn import functional as F

from huiyu_worker_lifecycle import load_sibling


class _HeadProjection(nn.Linear):
    """Use one Q, K or V view of the source's per-head interleaved projection."""
    def __init__(self, layer, heads, head_dim):
        nn.Module.__init__(self)
        self.in_features, self.out_features = layer.in_features, layer.out_features
        # Keep the head dimension in the source view on CPU. Moving this
        # strided slice to the accelerator produces a contiguous projection.
        self.weight = nn.Parameter(layer.weight.reshape(heads, head_dim, self.in_features), False)
        self.bias = nn.Parameter(layer.bias.reshape(heads, head_dim), False)

    def forward(self, values):
        return F.linear(values, self.weight.flatten(0, 1), self.bias.flatten())


def _video_shell(model, config):
    heads, head_dim = config["decoder_num_attention_heads"], config["decoder_attention_head_dim"]
    gate_first = load_sibling("h3_packed").GateFirst
    for block in model.decoder.transformer_blocks:
        block.ff.net[0] = gate_first(block.ff.net[0].proj)
        for name in ("to_q", "to_k", "to_v"):
            setattr(block.attn, name, _HeadProjection(getattr(block.attn, name), heads, head_dim))


def _batch_light_tiles(vae):
    original = vae._decode_clip

    def decode(z):
        if not vae.use_tiling or z.device.type != "cuda" or z.shape[0] != 1:
            return original(z)
        ratio = vae.spatial_compression_ratio
        ys, hs, y_overlap = vae._split_tiles(z.shape[-2] * ratio, vae.tile_sample_min_height, vae.tile_sample_min_overlap_height)
        xs, ws, x_overlap = vae._split_tiles(z.shape[-1] * ratio, vae.tile_sample_min_width, vae.tile_sample_min_overlap_width)
        if len(xs) * len(ys) == 1 or len(set(hs)) > 1 or len(set(ws)) > 1:
            return original(z)
        # Every tile keeps the upstream coordinates, rotary origin, and overlap.
        # Only independent examples are batched. The final stitch and temporal
        # cross-fade still run in their original order.
        tiles = [z[..., y // ratio:(y + h) // ratio, x // ratio:(x + w) // ratio]
                 for y, h in zip(ys, hs) for x, w in zip(xs, ws)]
        free = torch.cuda.mem_get_info(z.device)[0]
        batch = min(4, max(1, (free - (1 << 30)) // (512 << 20)))
        result = []
        offset = 0
        while offset < len(tiles):
            count = min(batch, len(tiles) - offset)
            try:
                group = tiles[offset] if count == 1 else torch.cat(tiles[offset:offset + count])
                frames = vae.decoder(vae.post_quant_conv(group))
            except torch.OutOfMemoryError:
                if count == 1:
                    raise
                batch = max(1, count // 2)
            else:
                result.extend(frames.split(1))
                offset += count
                continue
            # Release exception-local activations before retrying smaller tiles.
            torch.cuda.empty_cache()
        return vae._stitch_tiles([result[i:i + len(xs)] for i in range(0, len(result), len(xs))],
                                 y_overlap, x_overlap)

    vae._decode_clip = decode


def _video_tensors(name, tensor, config):
    if ".attn.to_qkv." in name:
        left, right = name.split(".attn.to_qkv.")
        heads, dim = config["decoder_num_attention_heads"], config["decoder_attention_head_dim"]
        qkv = tensor.unflatten(0, (heads, 3, dim))
        for index, target in enumerate(("to_q", "to_k", "to_v")):
            yield f"{left}.attn.{target}.{right}", qkv.select(1, index)
        return
    if name.startswith("encoder.down."):
        level, rest = name.removeprefix("encoder.down.").split(".", 1)
        rest = rest.replace("block.", "resnets.", 1).replace("nin_shortcut.", "conv_shortcut.", 1)
        name = f"encoder.down_blocks.{level}." + rest.replace("downsample.", "downsamplers.0.", 1)
    name = name.replace("decoder.x_embedder.", "decoder.proj_in.").replace(".attn.to_out.", ".attn.to_out.0.")
    yield name.replace(".ff.w1.", ".ff.net.0.proj.").replace(".ff.w2.", ".ff.net.2."), tensor


def load_vae(root, name, control, contract, *, lightvae=False, encoder_only=False):
    from accelerate import init_empty_weights
    from diffusers import AutoencoderKLMiniMaxH3, AutoencoderKLMiniMaxH3Audio
    video = name == "vae"
    if name not in ("vae", "audio_vae"):
        raise contract.AdapterError("UNSUPPORTED_MODEL", f"Unknown H3 VAE: {name}")
    config = contract.config(root, root / name / "config.json")
    path = contract.safe_file(root, root / name / "comfy.safetensors")
    cls = AutoencoderKLMiniMaxH3 if video else AutoencoderKLMiniMaxH3Audio
    lite_path = None
    if video and lightvae:
        resources = load_sibling("import_h3")
        if "lightvae" not in resources.prepared_accelerators(root):
            raise contract.AdapterError("MODEL_INCOMPLETE", "H3 LightVAE 缺少已校验的 12 层解码权重")
        lite_path = contract.safe_file(root, root / resources.LIGHT_DECODER)
        config = {**config, "decoder_num_layers": 12}
    with init_empty_weights(include_buffers=False):
        model = cls.from_config(config)
        if encoder_only:
            # Drop the meta decoder before enumerating tensors. Keyframes only
            # enter encode(), which uses the encoder and quant_conv.
            model.decoder = model.post_quant_conv = None
        elif video and lite_path is None:
            _video_shell(model, config)
        elif not video:
            # Comfy's audio pack contains final convolution weights, while
            # original H3 stores the weight-norm parametrization. Retire its
            # pre-hooks before installing the author's materialized matrices.
            for layer in model.modules():
                if hasattr(layer, "weight_g") and hasattr(layer, "weight_v"):
                    nn.utils.remove_weight_norm(layer)

    expected = model.state_dict()
    state = {}
    normals = {}
    source_dtype = torch.float16 if video else torch.float32
    with load_sibling("mapped_weights").ReadOnlyWeights(path) as reader:
        for source in reader.keys():
            control.check()
            if (lite_path or encoder_only) and source.startswith(("decoder.", "post_quant_conv.")):
                continue
            tensor = reader.get_tensor(source)
            if tensor.dtype != source_dtype:
                raise contract.AdapterError("MODEL_INVALID", f"H3 {name} 权重精度不符：{source}")
            if source in ("latents_mean", "latents_std"):
                if (tensor.shape != (config["latent_channels"],) or not torch.isfinite(tensor).all()
                        or source == "latents_std" and (tensor <= 0).any()):
                    raise contract.AdapterError("MODEL_INVALID", f"H3 {name} 潜变量归一化数据异常：{source}")
                normals[source] = tensor.float().tolist()
                continue
            if video and source == "decoder.mask_token":
                if tensor.shape != (1, 1, config["decoder_num_attention_heads"] * config["decoder_attention_head_dim"]):
                    raise contract.AdapterError("MODEL_INVALID", "H3 视频 VAE 训练用 mask token 尺寸不符")
                continue
            outputs = _video_tensors(source, tensor, config) if video else ((source, tensor),)
            for target, value in outputs:
                if target in state or target not in expected or expected[target].shape != value.shape:
                    raise contract.AdapterError("MODEL_INVALID", f"H3 {name} 权重不匹配：{source} → {target}")
                # Match Diffusers' exact FP32 module list. The large decoder
                # matrices remain file-backed FP16, and audio stays FP32.
                if video and set(target.split(".")).intersection(model._keep_in_fp32_modules):
                    value = value.float()
                state[target] = value
    if set(normals) != {"latents_mean", "latents_std"}:
        raise contract.AdapterError("MODEL_INVALID", f"H3 {name} 缺少潜变量归一化数据")
    if lite_path:
        # LightVAE's floating checkpoint already uses Diffusers' separate Q/K/V
        # and SwiGLU layout. Keep the original encoder, quant_conv and norms.
        with load_sibling("mapped_weights").ReadOnlyWeights(lite_path) as reader:
            for key in reader.keys():
                control.check()
                value = reader.get_tensor(key)
                if key in normals:
                    if value.shape != (config["latent_channels"],) or value.half().float().tolist() != normals[key]:
                        raise contract.AdapterError("MODEL_INVALID", f"LightVAE 潜变量归一化不匹配：{key}")
                    continue
                dtype = torch.float32 if set(key.split(".")).intersection(model._keep_in_fp32_modules) else torch.float16
                if (not key.startswith(("decoder.", "post_quant_conv.")) or key in state or key not in expected
                        or expected[key].shape != value.shape or value.dtype != dtype):
                    raise contract.AdapterError("MODEL_INVALID", f"LightVAE 解码器权重不匹配：{key}")
                state[key] = value
    model.load_state_dict(state, strict=True, assign=True)
    model.register_to_config(**normals)
    if video:
        model._huiyu_video_decoder = "lightvae-lite-fp16" if lite_path else "original"
        if lite_path:
            _batch_light_tiles(model)
    return model.eval().requires_grad_(False)
