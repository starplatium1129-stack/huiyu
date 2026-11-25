"""Load the pinned QWEN-Manga ConvRot assets into the native Qwen 2.1 pipeline."""
import json
import math

import torch
from torch import nn
from torch.nn import functional as F

from huiyu_worker_lifecycle import load_sibling

contract = load_sibling("adapter_contract")
quant = load_sibling("moss_int8")
_encoder = load_sibling("qwen_manga_encoder")

Projection = _encoder.Projection
EncoderProjection = _encoder.EncoderProjection
EncoderLinear = _encoder.EncoderLinear
EncoderTokenLookup = _encoder.EncoderTokenLookup
EncoderRMSNorm = _encoder.EncoderRMSNorm
upstream_sdpa = _encoder.upstream_sdpa
split_half_rope = _encoder.split_half_rope
text_attention = _encoder.text_attention
text_positions = _encoder.text_positions
vision_attention = _encoder.vision_attention
vision_forward = _encoder.vision_forward
configure_conditioning_encoder = _encoder.configure_conditioning_encoder


class FusedMLP(nn.Module):
    def __init__(self, original, backend):
        super().__init__()
        gate = original.gate_layer
        self.gate_up = Projection(gate.in_features, 2 * gate.out_features, backend)
        self.out = original.out

    def forward(self, value):
        return self.out(self.gate_up(value), activation="swiglu")


class MangaRope(nn.Module):
    """Qwen's frame/row/column positions, including half-token reference offsets."""

    def __init__(self, original):
        super().__init__()
        self.axes = original.axes_dim
        self.theta = original.theta

    def forward(self, img_shapes, image_pad_mask, device):
        target_h, target_w = img_shapes[-1][1:]
        slots = image_pad_mask.tolist()
        positions = []
        cursor = position = 0
        for _, height, width in img_shapes:
            start = slots.index(True, cursor)
            if start > cursor:
                count = start - cursor
                text = torch.arange(position, position + count, device=device)
                positions.append(text[:, None].expand(-1, 3))
                position += count
            rows = torch.arange(height, device=device) - (height - height // 2) + 0.5 * (height % 2 - target_h % 2)
            cols = torch.arange(width, device=device) - (width - width // 2) + 0.5 * (width % 2 - target_w % 2)
            row, col = torch.meshgrid(rows, cols, indexing="ij")
            positions.append(torch.stack((torch.full_like(row, position), row, col), dim=-1).reshape(-1, 3))
            cursor = start + height * width
            position += max(height, width)
        coords = torch.cat(positions).float()
        rotations = []
        for axis, dim in enumerate(self.axes):
            powers = torch.linspace(0, (dim - 2) / dim, dim // 2, device=device, dtype=torch.float64)
            angles = coords[:, axis, None] * (1.0 / self.theta**powers)
            cos, sin = angles.cos(), angles.sin()
            rotations.append(torch.stack((cos, -sin, sin, cos), dim=-1).float().unflatten(-1, (2, 2)))
        # The pipeline slices by token. RMS-RoPE consumes [batch, tokens, 1, pairs, 2, 2].
        return torch.cat(rotations, dim=1).unsqueeze(1)


class MangaTimesteps(nn.Module):
    def __init__(self, original):
        super().__init__()
        self.dim, self.factor = original.timestep_dim, original.time_factor

    def forward(self, timestep):
        half = self.dim // 2
        frequency = torch.exp(-math.log(10000) * torch.arange(half, dtype=torch.float32, device=timestep.device) / half)
        angles = (timestep.float() * self.factor)[:, None] * frequency[None]
        return torch.cat((angles.cos(), angles.sin()), dim=-1)


def modulated_norm(x, scale, eps, kitchen):
    if kitchen:
        import comfy_kitchen
        return comfy_kitchen.adaln(x, scale, torch.zeros_like(scale[:1]), eps)
    return F.layer_norm(x, (x.shape[-1],), eps=eps) * (1 + scale)


class TextRMSNorm(nn.Module):
    def __init__(self, original):
        super().__init__()
        self.weight, self.eps = original.weight, original.eps

    def forward(self, x):
        return F.rms_norm(x.float(), self.weight.shape, self.weight.float() + 1, self.eps).to(x.dtype)


class MangaTextProjection(nn.Module):
    def __init__(self, original):
        super().__init__()
        self.text_norm = TextRMSNorm(original.text_norm)
        self.in_layer, self.out_layer = original.in_layer, original.out_layer
        self.text_indices = None

    def forward(self, hidden_states):
        # Upstream projects only the text. The reference image's slots are
        # filled with VAE latents later. The GEMM shape affects BF16 rounding.
        indices = self.text_indices
        text = hidden_states.index_select(1, indices) if indices is not None else hidden_states
        text = self.out_layer(F.gelu(self.in_layer(self.text_norm(text)), approximate="tanh"))
        if indices is None:
            return text
        joint = text.new_zeros((*hidden_states.shape[:2], text.shape[-1]))
        return joint.index_copy_(1, indices, text)


def rotate_normalized(x, weight, eps, matrix):
    x = F.rms_norm(x, (x.shape[-1],), weight, eps)
    pairs = x.float().unflatten(-1, (-1, 2))
    return (matrix[..., 0] * pairs[..., :1]).addcmul_(
        matrix[..., 1], pairs[..., 1:]).flatten(-2).to(x.dtype)


class MangaAttention:
    def __init__(self, kitchen, int8):
        self.kitchen = kitchen
        self.int8 = int8

    def __call__(self, attn, hidden_states, *, rotation, past=None, capture=None, segments=None, mask=None):
        q, k, v = (proj(hidden_states).unflatten(-1, (attn.heads, -1))
                   for proj in (attn.to_q, attn.to_k, attn.to_v))
        # The two tiny norm scales can be on the host under leaf-level offload.
        q_scale, k_scale = attn.norm_q.weight.to(q), attn.norm_k.weight.to(k)
        matrix = rotation.unsqueeze(0)
        if self.kitchen:
            import comfy_kitchen
            q, k = comfy_kitchen.rms_rope(q, k, matrix, q_scale, k_scale, attn.norm_q.eps)
        else:
            q = rotate_normalized(q, q_scale, attn.norm_q.eps, matrix)
            k = rotate_normalized(k, k_scale, attn.norm_k.eps, matrix)
        if capture is not None:
            capture.extend((k, v))
        if past is not None:
            k, v = torch.cat((past[0], k), dim=1), torch.cat((past[1], v), dim=1)

        q, k, v = (t.transpose(1, 2) for t in (q, k, v))
        if self.int8:
            from comfy_kitchen import int8_attention as attend
        else:
            attend = upstream_sdpa
        if segments is None:
            out = attend(q, k, v, attn_mask=mask)
        else:
            outputs = []
            for start, end, is_text in segments:
                local_mask = None if mask is None else mask[..., :end]
                if is_text:
                    causal = torch.ones(end - start, end, dtype=torch.bool, device=q.device).tril_(start)[None, None]
                    local_mask = causal if local_mask is None else causal & local_mask
                outputs.append(attend(q[:, :, start:end], k[:, :, :end], v[:, :, :end],
                                      attn_mask=local_mask))
            out = torch.cat(outputs, dim=2)
        return attn.to_out[1](attn.to_out[0](out.transpose(1, 2).flatten(2)))


class MangaBlock(nn.Module):
    def __init__(self, original, backend, int8_attention):
        super().__init__()
        self.kitchen = backend == "kitchen"
        self.attn, self.img_norm1, self.img_norm2 = original.attn, original.img_norm1, original.img_norm2
        self.img_mlp = FusedMLP(original.img_mlp, backend)
        self.attn.set_processor(MangaAttention(self.kitchen, int8_attention))

    def lane(self, x, modulation, rotation, **attention):
        scale1, gate1, scale2, gate2 = modulation.unsqueeze(1).chunk(4, dim=-1)
        normalized = modulated_norm(x, scale1, self.img_norm1.eps, self.kitchen)
        x.addcmul_(self.attn(normalized, rotation=rotation, **attention), gate1.tanh())
        normalized = modulated_norm(x, scale2, self.img_norm2.eps, self.kitchen)
        x.addcmul_(self.img_mlp(normalized), gate2.tanh())

    def forward(self, hidden_states, modulation, rotary_emb, attention_mask=None, target_token_mask=None,
                layer_cache=None, kv_cache_mode=None, cache_write_slice=None, segments=None, key_valid=None):
        # Upstream quantizes projections for the prefix and target separately, even on
        # step one. Each later step reads exactly this block's cached post-RoPE K/V.
        prefix = segments[-1][1] if segments else 0
        mask = key_valid[:, None, None, :] if key_valid is not None else attention_mask
        past = None
        if prefix:
            past = []
            self.lane(hidden_states[:, :prefix], modulation[-1:], rotary_emb[:prefix],
                      segments=segments, mask=mask, capture=past)
            if layer_cache is not None:
                layer_cache.store(*past)
        elif kv_cache_mode == "cached":
            past = layer_cache.get()
        self.lane(hidden_states[:, prefix:], modulation[:-1], rotary_emb[prefix:], past=past, mask=mask)
        return hidden_states


class MangaOutputNorm(nn.Module):
    def __init__(self, original, kitchen):
        super().__init__()
        self.linear, self.silu, self.norm = original.linear, original.silu, original.norm
        self.kitchen = kitchen

    def forward(self, hidden_states, conditioning_embedding, target_token_mask=None):
        # The sampler reads the target image only. Discard the zero-time
        # prefix before the output GEMMs to match the upstream matrix shapes.
        prefix = int((~target_token_mask).sum()) if target_token_mask is not None else 0
        scale = self.linear(self.silu(conditioning_embedding[:-1]).to(hidden_states.dtype)).unsqueeze(1)
        return modulated_norm(hidden_states[:, prefix:], scale, self.norm.eps, self.kitchen)


def _load_weights(model, weights, backend, *, encoder):
    expected = {"format": "int8_tensorwise", "convrot": True, "convrot_groupsize": 256}
    if encoder:
        expected.update(orig_dtype="torch.bfloat16", per_row=True)
        weights.pop("lm_head.weight")  # The pipeline reads the final pre-norm hidden state.
        weights = {key.replace("model.", "model.language_model.", 1) if key.startswith("model.")
                   and not key.startswith("model.visual.") else key: value for key, value in weights.items()}
    else:
        use_int8_attention = False
        if backend == "kitchen":
            from comfy_kitchen import int8_attention_is_available
            use_int8_attention = int8_attention_is_available(torch.device("cuda:0"))
        model.pos_embed = MangaRope(model.pos_embed)
        model.time_text_embed.time_proj = MangaTimesteps(model.time_text_embed.time_proj)
        model.txt_in = MangaTextProjection(model.txt_in)
        model.norm_out = MangaOutputNorm(model.norm_out, backend == "kitchen")
        for index, block in enumerate(model.transformer_blocks):
            if index:
                annotation = weights.pop(f"transformer_blocks.{index}.attn.comfy_attention.config")
                if bytes(annotation.tolist()) != b'{"attention": "comfy_kitchen_int8"}':
                    raise contract.AdapterError("MODEL_INVALID", "QWEN-Manga 注意力配置不匹配")
            model.transformer_blocks[index] = MangaBlock(block, backend, bool(index and use_int8_attention))
        model._huiyu_manga_int8_attention = use_int8_attention

    suffix = ".comfy_quant"
    paths = [key.removesuffix(suffix) for key in weights if key.endswith(suffix)]
    if len(paths) != (238 if encoder else 192):
        raise contract.AdapterError("MODEL_INVALID", "QWEN-Manga INT8 投影数量不匹配")
    for path in paths:
        metadata = weights.pop(path + suffix)
        if (metadata.dtype != torch.uint8 or metadata.ndim != 1 or metadata.numel() > 512
                or json.loads(bytes(metadata.tolist())) != expected):
            raise contract.AdapterError("MODEL_INVALID", f"QWEN-Manga INT8 格式不匹配：{path}")
        leaf = model.get_submodule(path)
        weight, scale = weights[path + ".weight"], weights[path + ".weight_scale"]
        if (not isinstance(leaf, nn.Linear) or leaf.bias is not None or weight.dtype != torch.int8
                or tuple(weight.shape) != (leaf.out_features, leaf.in_features) or scale.dtype != torch.float32
                or tuple(scale.shape) != (leaf.out_features, 1) or leaf.in_features % 256):
            raise contract.AdapterError("MODEL_INVALID", f"QWEN-Manga INT8 权重形状不匹配：{path}")
        if not isinstance(leaf, Projection):
            parent, name = path.rsplit(".", 1)
            projection = EncoderProjection if encoder else Projection
            setattr(model.get_submodule(parent), name, projection(leaf.in_features, leaf.out_features, backend))

    # Shapes/key sets are enforced by strict assignment, and integer buffers retain their dtype.
    model.load_state_dict(weights, strict=True, assign=True)
    return model.eval().requires_grad_(False)


def load(root, control):
    from accelerate import init_empty_weights
    from diffusers import QwenImage21Transformer2DModel
    from transformers import Qwen3VLConfig, Qwen3VLForConditionalGeneration

    backend = quant.require_backend(contract)
    with init_empty_weights():
        config = Qwen3VLConfig.from_pretrained(str(root / "text_encoder"), local_files_only=True)
        encoder = Qwen3VLForConditionalGeneration(config)
        encoder.lm_head = nn.Identity()
        transformer = QwenImage21Transformer2DModel.from_config(
            contract.config(root, root / "transformer/config.json"))
    control.check()
    _load_weights(encoder, quant.read_weights(root / "text_encoder/packed.safetensors"), backend, encoder=True)
    configure_conditioning_encoder(encoder)
    control.check()
    _load_weights(transformer, quant.read_weights(root / "transformer/packed.safetensors"), backend, encoder=False)
    return encoder, transformer
