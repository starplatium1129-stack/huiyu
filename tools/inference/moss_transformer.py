# Copyright 2026 OpenMOSS. Apache-2.0; see MOSS-LICENSE.
# Source: OpenMOSS-Team/MOSS-Image-Base@85975793d8b3d432f1b6e27f352abaa4c2a4c0d3/pipeline_moss_image.py
# Changes: optional task-local Spectrum image-feature forecasting in the DiT;
# loading, cache lifecycle and progress live in moss_adapter.py.
"""MOSSImage DiT transformer modules and attention/RoPE building blocks."""
from __future__ import annotations

import torch
from torch import nn
from torch.nn import functional as F
from diffusers.configuration_utils import ConfigMixin, register_to_config
from diffusers.models.modeling_utils import ModelMixin
from diffusers.models.modeling_outputs import Transformer2DModelOutput


class _RMSNorm(nn.Module):
    def __init__(self, dim):
        super().__init__()
        self.weight = nn.Parameter(torch.ones(dim))

    def forward(self, x):
        return F.rms_norm(x, (x.shape[-1],), self.weight, 1e-6)


def _situ(hidden, gate):
    return (4.0 * torch.tanh(gate / 4.0) * torch.sigmoid(gate)) * (25.0 * torch.tanh(hidden / 25.0))


def _validate_skip_layers(layers, depth, name='skip_layers'):
    layers = () if layers is None else tuple(layers)
    if any(type(index) is not int or not 0 <= index < depth for index in layers):
        raise ValueError(f'{name} must contain integer block indices in [0, {depth}).')
    return frozenset(layers)


def _rotate(x, rope):
    sin, cos = rope.chunk(2, -1)
    a, b = x.chunk(2, -1)
    return x * cos + torch.cat((-b, a), -1) * sin


def _attention(q, k, v, rope, heads):
    shape = (*q.shape[:2], heads, q.shape[-1] // heads)
    q = _rotate(q.reshape(shape), rope).transpose(1, 2)
    k = _rotate(k.reshape(shape), rope).transpose(1, 2)
    v = v.reshape(shape).transpose(1, 2)
    return F.scaled_dot_product_attention(q.to(v.dtype), k.to(v.dtype), v).transpose(1, 2).flatten(2)


class _TextBlock(nn.Module):
    def __init__(self, dim, ffn_dim, heads):
        super().__init__()
        self.heads = heads
        self.norm1, self.norm2 = _RMSNorm(dim), _RMSNorm(dim)
        self.q_norm, self.k_norm = _RMSNorm(dim // heads), _RMSNorm(dim // heads)
        self.qkv = nn.Linear(dim, 3 * dim)
        self.proj = nn.Linear(dim, dim)
        self.ffn_gate, self.ffn_up = nn.Linear(dim, ffn_dim), nn.Linear(dim, ffn_dim)
        self.ffn_down = nn.Linear(ffn_dim, dim)

    def forward(self, x, rope):
        q, k, v = self.qkv(self.norm1(x)).chunk(3, -1)
        q = self.q_norm(q.unflatten(-1, (self.heads, -1))).flatten(2)
        k = self.k_norm(k.unflatten(-1, (self.heads, -1))).flatten(2)
        x = x + self.proj(_attention(q, k, v, rope, self.heads))
        y = self.norm2(x)
        return x + self.ffn_down(_situ(self.ffn_up(y), self.ffn_gate(y)))


class _TextProjection(nn.Module):
    def __init__(self, text_dim, dim, ffn_dim, heads):
        super().__init__()
        self.proj = nn.Linear(text_dim, dim)
        self.blocks = nn.ModuleList([_TextBlock(dim, ffn_dim, heads) for _ in range(2)])

    def forward(self, x, rope):
        x = self.proj(x.to(self.proj.weight.dtype))
        for block in self.blocks:
            x = block(x, rope)
        return x


class _Block(nn.Module):
    def __init__(self, dim, ffn_dim, heads):
        super().__init__()
        self.heads = heads
        self.norm1, self.norm2 = _RMSNorm(dim), _RMSNorm(dim)
        self.q_norm, self.k_norm = _RMSNorm(dim // heads), _RMSNorm(dim // heads)
        self.proj = nn.ModuleDict({
            name: nn.Linear(dim, dim, bias=False) for name in ('q', 'k', 'v', 'o')
        })
        self.proj['ffn_up_gate'] = nn.Linear(dim, 2 * ffn_dim, bias=False)
        self.proj['ffn_down'] = nn.Linear(ffn_dim, dim, bias=False)

    def forward(self, x, rope, modulation):
        shift_a, factor_a, gate_a, shift_f, factor_f, gate_f = modulation
        y = self.norm1(x) * factor_a + shift_a
        fused = 'qkv' in self.proj
        projection = self.proj['qkv' if fused else 'q']
        dtype = getattr(projection, 'compute_dtype', projection.weight.dtype)
        y = y.to(dtype)
        q, k, v = self.proj['qkv'](y).chunk(3, -1) if fused else (
            self.proj['q'](y), self.proj['k'](y), self.proj['v'](y))
        q = self.q_norm(q.unflatten(-1, (self.heads, -1))).flatten(2)
        k = self.k_norm(k.unflatten(-1, (self.heads, -1))).flatten(2)
        x = x + self.proj['o'](_attention(q, k, v, rope, self.heads)) * gate_a
        y = self.norm2(x) * factor_f + shift_f
        hidden, gate = self.proj['ffn_up_gate'](y.to(dtype)).chunk(2, -1)
        return x + self.proj['ffn_down'](_situ(hidden, gate)) * gate_f


class _RoPE(nn.Module):
    def __init__(self, head_dim, base):
        super().__init__()
        self.num_bands = head_dim // 8
        self.base = base
        self.register_buffer('bands', self._default_bands(torch.device('cpu')))

    def _default_bands(self, device):
        # Match training's CPU fp32 construction, including under meta init.
        exponent = torch.arange(self.num_bands, device='cpu', dtype=torch.float32) / self.num_bands
        return (1 / (self.base ** exponent)).to(device)

    def _apply(self, fn, recurse=True):
        super()._apply(fn, recurse=recurse)
        # .float() cannot recover frequencies already rounded by .to(bf16).
        self.bands = self._default_bands(self.bands.device)
        return self

    def _load_from_state_dict(self, *args, **kwargs):
        super()._load_from_state_dict(*args, **kwargs)
        # Frequencies are derived constants; retain the key for checkpoint compatibility.
        self.bands = self._default_bands(self.bands.device)

    def forward(self, height, width, text_length, device):
        # Diffusers/Accelerate can install tensors directly, bypassing load hooks.
        if self.bands.dtype != torch.float32:
            self.bands = self._default_bands(device)
        # Coordinates: (r, f, h, w); sequence order is image followed by text.
        h, w = torch.meshgrid(torch.arange(height, device=device), torch.arange(width, device=device), indexing='ij')
        image = torch.stack((torch.zeros_like(h), torch.full_like(h, text_length), h, w), -1).flatten(0, 1).float()
        image[:, 2] -= (height - 1) / 2
        image[:, 3] -= (width - 1) / 2
        text = torch.zeros(text_length, 4, device=device, dtype=torch.float32)
        text[:, 1] = torch.arange(text_length, device=device)
        phase = torch.cat((image, text), 0).unsqueeze(-1) * self.bands
        return torch.cat((phase.sin(), phase.cos()), -2).flatten(-2).unsqueeze(0)


class MOSSImageTransformer(ModelMixin, ConfigMixin):
    """MOSSImage DiT with training-compatible state-dict names and SDPA attention.

    Each sample is evaluated at its true text length, including text refinement;
    padded tokens cannot influence either text or joint attention.
    """
    @register_to_config
    def __init__(self, dim=3072, ffn_dim=8192, num_heads=24, num_layers=42,
                 text_dim=4096, freq_dim=256, latent_channels=128, rope_base=10000.0):
        super().__init__()
        if dim % num_heads or (dim // num_heads) % 8 or freq_dim % 2:
            raise ValueError('Require dim divisible by heads, head_dim divisible by 8, and even freq_dim.')
        self.video_embedder = nn.Linear(latent_channels, dim)
        self.text_embedder = _TextProjection(text_dim, dim, ffn_dim, num_heads)
        self.rope = _RoPE(dim // num_heads, rope_base)
        self.time_embedding = nn.Sequential(nn.Linear(freq_dim, dim), nn.SiLU(), nn.Linear(dim, dim))
        self.shared_block_modulation = nn.Linear(dim, 6 * dim)
        self.layers = nn.ModuleList([_Block(dim, ffn_dim, num_heads) for _ in range(num_layers)])
        self.final_norm_video = _RMSNorm(dim)
        self.final_linear_video = nn.Linear(dim, latent_channels, bias=False)
        self.video_head_modulation = nn.Linear(dim, 2 * dim)

    def load_training_state_dict(self, state_dict, *, prefix=''):
        """Load a consolidated raw/EMA model mapping, strictly; no silent key drops."""
        if prefix:
            if any(not key.startswith(prefix) for key in state_dict):
                raise ValueError('All keys must start with the explicit prefix.')
            state_dict = {key[len(prefix):]: value for key, value in state_dict.items()}
        return self.load_state_dict(state_dict, strict=True)

    def _modulation(self, timestep, batch, device):
        times = torch.as_tensor(timestep, device=device, dtype=torch.float32).reshape(-1)
        times = times.expand(batch)
        # Training computes the sinusoid in float64 and feeds float32 into its MLP.
        half = self.config.freq_dim // 2
        freq = 10000 ** (-torch.arange(half, device=times.device, dtype=torch.float64) / half)
        phase = times.double()[:, None] * freq
        embedding = torch.cat((phase.cos(), phase.sin()), -1).float()
        time = self.time_embedding(embedding.to(self.time_embedding[0].weight.dtype)).float()
        mod = self.shared_block_modulation(time.to(self.shared_block_modulation.weight.dtype)).view(batch, 6, -1)
        head = self.video_head_modulation(time.to(self.video_head_modulation.weight.dtype)).view(batch, 2, -1)
        # Every block and CFG branch at this timestep uses the same factors.
        # Keep the original dtype and [B, 1, D] broadcasting for each sample.
        shift_a, scale_a, gate_a, shift_f, scale_f, gate_f = mod.split(1, dim=1)
        return (shift_a, 1 + scale_a, gate_a, shift_f, 1 + scale_f, gate_f), head

    def _context(self, embeds, mask, index, height, width, device, dtype):
        if mask is None:
            context = embeds[index:index + 1]
        else:
            if mask.shape != embeds.shape[:2] or not torch.all((mask == 0) | (mask == 1)):
                raise ValueError('encoder_attention_mask must be a binary [B, S] mask.')
            context = embeds[index:index + 1, mask[index].bool()]
        if context.shape[1] == 0:
            raise ValueError('Each sample needs at least one valid text token.')
        # Share the broadcast-ready bands across Q/K and every attention block.
        # The task-local context cache accounts for the expanded tensor's bytes.
        sin, cos = self.rope(height, width, context.shape[1], device).to(dtype).chunk(2, -1)
        rope = torch.cat((sin, sin, cos, cos), -1).unsqueeze(-2)
        return rope, self.text_embedder(context, rope[:, height * width:])

    def forward(self, hidden_states, timestep, encoder_hidden_states,
                encoder_attention_mask=None, return_dict=True, skip_layers=None, spectrum_branch="positive"):
        skip_layers = _validate_skip_layers(skip_layers, len(self.layers))
        if hidden_states.ndim != 4 or hidden_states.shape[1] != self.config.latent_channels:
            raise ValueError('hidden_states must be [B, latent_channels, H, W].')
        batch, _, height, width = hidden_states.shape
        if encoder_hidden_states.ndim != 3 or encoder_hidden_states.shape[0] != batch:
            raise ValueError('encoder_hidden_states must be [B, S, text_dim].')
        mask = encoder_attention_mask
        execution = getattr(self, '_huiyu_execution', None)
        build_time = lambda: self._modulation(timestep, batch, hidden_states.device)
        mod, head = execution.modulation(timestep, batch, build_time) if execution is not None else build_time()
        outputs = []
        for index in range(batch):
            cache = getattr(self, "_huiyu_spectrum", None)
            predicted = None
            if cache is not None:
                key = (spectrum_branch, index, skip_layers)
                shape = (height, width, self.video_embedder.weight.dtype, hidden_states.device)
                predicted = cache.predict(key, shape)
            if predicted is None:
                video = hidden_states[index:index + 1].flatten(2).transpose(1, 2)
                video = self.video_embedder(video.to(self.video_embedder.weight.dtype).contiguous())
                if cache is not None:
                    cache.check_budget(video)
                build_context = lambda: self._context(encoder_hidden_states, mask, index,
                    height, width, hidden_states.device, video.dtype)
                context_key = (id(encoder_hidden_states), id(mask), index, height, width, video.dtype)
                rope, text = (execution.context(context_key, encoder_hidden_states, mask, build_context)
                              if execution is not None else build_context())
                x = torch.cat((video, text), 1)
                sample_mod = mod if batch == 1 else tuple(value[index:index + 1] for value in mod)
                for layer_index, layer in enumerate(self.layers):
                    if execution is not None:
                        execution.control.check()
                    if layer_index not in skip_layers:
                        x = layer(x, rope, sample_mod)
                if cache is not None:
                    cache.update(key, x[:, :height * width])
            else:
                x = predicted
            x = self.final_norm_video(x[:, :height * width].to(self.final_norm_video.weight.dtype))
            x = x * (1 + head[index:index + 1, 1, None]) + head[index:index + 1, 0, None]
            x = self.final_linear_video(x.to(self.final_linear_video.weight.dtype))
            outputs.append(x.transpose(1, 2).reshape(1, -1, height, width))
        sample = outputs[0] if len(outputs) == 1 else torch.cat(outputs)
        return Transformer2DModelOutput(sample=sample) if return_dict else (sample,)
