"""ConvRot INT8 projections and FP32 conditioning encoder layers for QWEN-Manga."""
from types import MethodType

import torch
from torch import nn
from torch.nn import functional as F
from torch.nn.attention import SDPBackend, sdpa_kernel

from huiyu_worker_lifecycle import load_sibling

quant = load_sibling("moss_int8")


class Projection(nn.Linear):
    def __init__(self, features, outputs, backend):
        nn.Module.__init__(self)
        self.in_features, self.out_features, self.backend = features, outputs, backend
        self.weight = nn.Parameter(torch.empty(outputs, features, device="meta", dtype=torch.int8), False)
        self.register_parameter("bias", None)
        self.register_buffer("weight_scale", torch.empty(outputs, 1, device="meta", dtype=torch.float32))

    def forward(self, value, activation=None):
        if self.backend == "kitchen":
            import comfy_kitchen
            return comfy_kitchen.int8_linear(value.contiguous(), self.weight, self.weight_scale,
                                            out_dtype=value.dtype, convrot=True, input_act=activation)
        if activation == "swiglu":
            gate, up = value.chunk(2, dim=-1)
            value = F.silu(gate) * up
        return quant.torch_int8_linear(value, self.weight, self.weight_scale).to(value.dtype)


class EncoderProjection(Projection):
    """CLIP conditioning dequantizes weights to FP32; it does not quantize activations."""

    def forward(self, value):
        # A pinned encoder matrix has at most 12288 x 4096 entries (192 MiB in
        # FP32). The CUDA kernel needs only that temporary for this projection.
        if self.backend == "kitchen":
            weight = torch.ops.comfy_kitchen.dequantize_int8_convrot_weight_dtype(
                self.weight, self.weight_scale, 256, 0)
            return F.linear(value, weight)

        # The portable inverse rotation needs a second FP32 workspace. Only
        # split output rows, so each output still reduces over the entire input.
        basis = quant.convrot_basis(value.device, torch.float32).T
        row_count = min(self.out_features, (32 * 1024**2) // (4 * self.in_features))
        result = value.new_empty((*value.shape[:-1], self.out_features))
        for start in range(0, self.out_features, row_count):
            end = min(start + row_count, self.out_features)
            scaled = self.weight[start:end].float().mul_(self.weight_scale[start:end])
            weight = (scaled.reshape(-1, 256) @ basis).reshape_as(scaled)
            result[..., start:end] = F.linear(value, weight)
            del weight, scaled
        return result


class EncoderLinear(nn.Linear):
    def __init__(self, original):
        nn.Module.__init__(self)
        self.in_features, self.out_features = original.in_features, original.out_features
        self.weight, self.bias = original.weight, original.bias

    def forward(self, value):
        bias = self.bias.to(value) if self.bias is not None else None
        return F.linear(value, self.weight.to(value), bias)


class EncoderTokenLookup(nn.Module):
    def __init__(self, original):
        super().__init__()
        # Keep the 1.2 GB BF16 vocabulary in its mapped host storage even when
        # the rest of the encoder is resident. Move only the gathered rows.
        self.weight = original.weight.detach()
        self.padding_idx = original.padding_idx

    def forward(self, ids):
        rows = F.embedding(ids.to(self.weight.device), self.weight, self.padding_idx)
        return rows.to(device=ids.device, dtype=torch.float32)


class EncoderRMSNorm(nn.Module):
    def __init__(self, original):
        super().__init__()
        self.weight, self.eps = original.weight, original.variance_epsilon

    def forward(self, value):
        return F.rms_norm(value, self.weight.shape, self.weight.to(value), self.eps)


def upstream_sdpa(q, k, v, attn_mask=None):
    grouped = q.shape[-3] != k.shape[-3]
    if q.device.type != "cuda" or q.numel() < 128 * 1024:
        return F.scaled_dot_product_attention(q, k, v, attn_mask=attn_mask, enable_gqa=grouped)
    priorities = [SDPBackend.FLASH_ATTENTION, SDPBackend.CUDNN_ATTENTION, SDPBackend.EFFICIENT_ATTENTION, SDPBackend.MATH]
    with sdpa_kernel(priorities, set_priority=True):
        if grouped and attn_mask is not None:
            cuda = torch.backends.cuda
            params = cuda.SDPAParams(q, k, v, attn_mask, 0.0, False, True)
            if not (cuda.can_use_flash_attention(params) or cuda.can_use_cudnn_attention(params)
                    or cuda.can_use_efficient_attention(params)):
                groups = q.shape[-3] // k.shape[-3]
                k, v = k.repeat_interleave(groups, dim=-3), v.repeat_interleave(groups, dim=-3)
                grouped = False
        return F.scaled_dot_product_attention(q, k, v, attn_mask=attn_mask, enable_gqa=grouped)


def split_half_rope(q, k, cos, sin):
    # Both FP32 encoder towers use the upstream eager operation order.
    cos_l, cos_r = cos.chunk(2, -1)
    sin_l, neg_sin_r = sin.chunk(2, -1)
    neg_sin_r = -neg_sin_r

    def rotate(x):
        left, right = x.chunk(2, dim=-1)
        return torch.cat(((left * cos_l).addcmul_(right, neg_sin_r),
                          (right * cos_r).addcmul_(left, sin_l)), dim=-1)
    return rotate(q), rotate(k)


def text_attention(self, hidden_states, position_embeddings, attention_mask=None, past_key_values=None, **kwargs):
    shape = (*hidden_states.shape[:2], -1, self.head_dim)
    q = self.q_norm(self.q_proj(hidden_states).view(shape).transpose(1, 2))
    k = self.k_norm(self.k_proj(hidden_states).view(shape).transpose(1, 2))
    v = self.v_proj(hidden_states).view(shape).transpose(1, 2)
    cos, sin = (t.unsqueeze(1) for t in position_embeddings)
    q, k = split_half_rope(q, k, cos, sin)
    if past_key_values is not None:
        k, v = past_key_values.update(k, v, self.layer_idx)
    # Upstream uses an explicit additive causal mask.
    # The normal manga prompt has no padding. Preserve an explicit padding mask
    # as well when the installed processor supplies one.
    forbidden = torch.finfo(q.dtype).min / 4
    if attention_mask is None:
        mask = q.new_full((q.size(2), k.size(2)), forbidden).triu_(1 + k.size(2) - q.size(2))
        mask = mask[None, None]
    else:
        valid = attention_mask if attention_mask.dtype == torch.bool else attention_mask == 0
        mask = torch.zeros_like(valid, dtype=q.dtype).masked_fill_(~valid, forbidden)
    out = upstream_sdpa(q, k, v, attn_mask=mask)
    return self.o_proj(out.transpose(1, 2).reshape_as(hidden_states)), None


def text_positions(self, x, position_ids):
    # The upstream Llama encoder constructs the inverse frequencies on its
    # execution device. A host-built buffer can differ before cos/sin rounding.
    dim = self.config.head_dim
    theta = self.config.rope_parameters["rope_theta"]
    frequencies = 1.0 / (theta ** (torch.arange(0, dim, 2, device=x.device).float() / dim))
    if position_ids.ndim == 2:
        position_ids = position_ids.unsqueeze(0).expand(3, -1, -1)
    angles = (frequencies[None, None, :, None] @ position_ids[:, :, None, :].float()).transpose(-2, -1)
    interleaved = angles[0].clone()
    for axis in (1, 2):
        columns = slice(axis, self.mrope_section[axis] * 3, 3)
        interleaved[..., columns] = angles[axis, ..., columns]
    angles = torch.cat((interleaved, interleaved), dim=-1)
    return angles.cos().to(x.dtype), angles.sin().to(x.dtype)


def vision_attention(self, hidden_states, cu_seqlens, position_embeddings=None, **kwargs):
    seq = hidden_states.shape[0]
    q, k, v = self.qkv(hidden_states).view(seq, 3, self.num_heads, self.head_dim).unbind(1)
    cos, sin = (t[None, :, None, :] for t in position_embeddings)
    q, k = split_half_rope(q.unsqueeze(0), k.unsqueeze(0), cos, sin)
    lengths = cu_seqlens.diff().tolist()
    queries, keys, values = (t.transpose(1, 2).split(lengths, dim=2) for t in (q, k, v.unsqueeze(0)))
    outputs = [upstream_sdpa(a, b, c).transpose(1, 2) for a, b, c in zip(queries, keys, values)]
    return self.proj(torch.cat(outputs, dim=1).reshape(seq, -1))


def vision_forward(self, hidden_states, grid_thw, **kwargs):
    from transformers.models.qwen3_vl.modeling_qwen3_vl import BaseModelOutputWithDeepstackFeatures

    x = self.patch_embed(hidden_states)
    side, merge = self.num_grid_per_side, self.spatial_merge_size
    head_dim = self.blocks[0].attn.head_dim
    rotary_dim = head_dim // 2
    inv_freq = 1 / (10000 ** (torch.arange(0, rotary_dim, 2, dtype=torch.float32) / rotary_dim))
    inv_freq = inv_freq.to(x.device)
    positions, rotary, lengths = [], [], []
    for frames, height, width in grid_thw.tolist():
        # Position weights and the four additions use the embedding table's
        # storage dtype. Reordering from raster to merged patch order happens last.
        # The upstream model builds its index grid beside the host-backed table.
        # CUDA linspace differs at round-to-BF16 boundaries for common grids.
        y = torch.linspace(0, side - 1, height, device="cpu")
        z = torch.linspace(0, side - 1, width, device="cpu")
        lo_y, lo_x = y.long(), z.long()
        hi_y, hi_x = (lo_y + 1).clamp_max(side - 1), (lo_x + 1).clamp_max(side - 1)
        dy, dx = y - lo_y, z - lo_x
        idx = torch.stack([r[:, None] * side + c for r, c in
                           ((lo_y, lo_x), (lo_y, hi_x), (hi_y, lo_x), (hi_y, hi_x))])
        weights = torch.stack([r[:, None] * c for r, c in
                               ((1 - dy, 1 - dx), (1 - dy, dx), (dy, 1 - dx), (dy, dx))])
        values = self.pos_embed(idx.to(x.device)) * weights.to(device=x.device, dtype=self.pos_embed.weight.dtype).unsqueeze(-1)
        position = values[0] + values[1] + values[2] + values[3]
        order = torch.arange(height * width, device=x.device).reshape(height // merge, merge, width // merge, merge)
        order = order.transpose(1, 2).reshape(-1).repeat(frames)
        positions.append(position.flatten(0, 1)[order])
        row, col = order // width, order % width
        freq = torch.cat((row[:, None] * inv_freq, col[:, None] * inv_freq), dim=-1)
        rotary.append(torch.cat((freq, freq), dim=-1))
        lengths.extend([height * width] * frames)

    x = x + torch.cat(positions).to(x)
    angles = torch.cat(rotary)
    rotation = (angles.cos(), angles.sin())
    offsets = torch.tensor([0, *lengths], device=x.device, dtype=torch.int32).cumsum(0, dtype=torch.int32)
    deepstack = []
    for index, block in enumerate(self.blocks):
        x = block(x, cu_seqlens=offsets, max_seqlen=max(lengths), position_embeddings=rotation)
        if index in self.deepstack_visual_indexes:
            deepstack.append(self.deepstack_merger_list[self.deepstack_visual_indexes.index(index)](x))
    return BaseModelOutputWithDeepstackFeatures(
        last_hidden_state=x, pooler_output=self.merger(x), deepstack_features=deepstack)


def configure_conditioning_encoder(encoder):
    from transformers.models.qwen3_vl.modeling_qwen3_vl import Qwen3VLTextRMSNorm

    # Transformers chooses both its visual input and patch dtype from the
    # first convolution. Keep this small tensor and the affine norms in FP32.
    encoder.model.visual.patch_embed.proj.float()
    visual = encoder.model.visual
    visual.forward = MethodType(vision_forward, visual)
    for block in visual.blocks:
        block.attn.forward = MethodType(vision_attention, block.attn)
    language = encoder.model.language_model
    language.embed_tokens = EncoderTokenLookup(language.embed_tokens)
    language.rotary_emb.forward = MethodType(text_positions, language.rotary_emb)
    for layer in language.layers:
        layer.self_attn.forward = MethodType(text_attention, layer.self_attn)
    for path, layer in list(encoder.named_modules()):
        if type(layer) is nn.Linear:
            replacement = EncoderLinear(layer)
        elif isinstance(layer, Qwen3VLTextRMSNorm):
            replacement = EncoderRMSNorm(layer)
        else:
            if isinstance(layer, nn.LayerNorm):
                layer.float()
            continue
        parent, name = path.rsplit(".", 1)
        setattr(encoder.get_submodule(parent), name, replacement)
