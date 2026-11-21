"""Native pruned MiniMax H3 with verified ConvRot and optional Turbo weights."""
import json
from contextlib import contextmanager, nullcontext

import torch
from torch import nn
from torch.nn import functional as F

from huiyu_worker_lifecycle import load_sibling

quant = load_sibling("moss_int8")


@contextmanager
def _reuse_forward(module, counts, name):
    original = module.forward
    previous_override = vars(module).get("forward")
    previous_input = previous_version = result = None
    counts[name + "Hits"] = counts[name + "Misses"] = 0

    def run(value):
        nonlocal previous_input, previous_version, result
        if torch.is_grad_enabled() or module.training:
            return original(value)
        # The native sampler reads the same immutable prompt tensor at every
        # step. Ordinary PyTorch tensors also expose an in-place version.
        version = None if value.is_inference() else value._version
        if value is previous_input and version == previous_version:
            counts[name + "Hits"] += 1
            return result
        counts[name + "Misses"] += 1
        previous_input = result = None
        output = original(value)
        if output.numel() * output.element_size() <= 32 * 1024**2:
            previous_input, previous_version, result = value, version, output
        return output

    module.forward = run
    try:
        yield
    finally:
        if previous_override is None:
            del module.forward
        else:
            module.forward = previous_override


@contextmanager
def refine_context(transformer, counts):
    """Reuse H3's timestep-independent text projection and refiner within one job."""
    # Bind after placement so a hit bypasses the original weight onload hooks.
    # The enclosing transformer only reads these outputs when packing the joint
    # sequence. Keep each in its exact original dtype/device until this job ends.
    counts.update(transformer._huiyu_h3_qkv)
    with _reuse_forward(transformer.context_embedder, counts, "textProjection"), \
            _reuse_forward(transformer.token_refiner, counts, "tokenRefiner"):
        yield


class _Weights:
    def __init__(self, reader, contract, *, fused=False):
        self.reader, self.contract = reader, contract
        self.fused = fused
        self.remaining = set(reader.keys())

    def take(self, key, shape, dtype):
        info = self.reader.header.get(key, {})
        if (key not in self.remaining or tuple(info.get("shape", ())) != tuple(shape)
                or info.get("dtype") != dtype):
            raise self.contract.AdapterError("MODEL_INVALID", f"H3 权重不匹配：{key}, 预期 {dtype} {tuple(shape)}")
        self.remaining.remove(key)
        return self.reader.get_tensor(key)

    def quantization(self, path):
        key = path + ".comfy_quant"
        size = self.reader.header.get(key, {}).get("shape", [])
        if len(size) != 1 or not 0 < size[0] <= 512:
            raise self.contract.AdapterError("MODEL_INVALID", f"H3 缺少量化配置：{path}")
        meta = json.loads(bytes(self.take(key, size, "U8").tolist()))
        expected = {"format": "int8_tensorwise", "convrot": True, "convrot_groupsize": 256}
        if self.fused:
            expected["per_channel"] = True
        if meta != expected:
            raise self.contract.AdapterError("UNSUPPORTED_MODEL", f"H3 量化格式不支持：{path}")

    def complete(self):
        if self.remaining:
            raise self.contract.AdapterError("MODEL_INVALID", f"H3 权重没有对应层：{min(self.remaining)}")


def _compact_qkv(up):
    # Comfy fuses the three rank-128 adapters by padding B with zeros. Check
    # the mapped payload once, including signed zeros, before omitting bytes.
    blocks = up.view(3, up.shape[0] // 3, 3, up.shape[1] // 3)
    words = blocks.view(torch.int16).numpy()
    for group, rows in enumerate(words):
        if rows[:, :group].any() or rows[:, group + 1:].any():
            return up
    # The three live blocks are strided views of the protected checkpoint.
    # Placement transfers only their payload without a permanent host copy.
    return blocks.diagonal(dim1=0, dim2=2).movedim(-1, 0)


class _Projection(nn.Linear):
    """One packed projection, with the LoRA applied to the unrotated input."""
    def __init__(self, path, inputs, outputs, weights, lora, steps, *, rank, backend):
        nn.Module.__init__(self)
        self.in_features, self.out_features = inputs, outputs
        self.backend = backend
        matrix = weights.take(path + ".weight", (outputs, inputs), "I8" if backend else "BF16")
        self.weight = nn.Parameter(matrix, requires_grad=False)
        self.register_parameter("bias", None)
        if backend:
            weights.quantization(path)
            self.register_buffer("weight_scale", weights.take(path + ".weight_scale", (outputs, 1), "F32"))
        if lora is None:
            self.register_buffer("up", None)
            return
        key = "diffusion_model." + path
        self.register_buffer("down", lora.take(key + ".lora_A.weight", (rank, inputs), "BF16"))
        up = lora.take(key + ".lora_B.weight", (outputs, rank), "BF16")
        self.register_buffer("up", _compact_qkv(up) if path.endswith(".attn.qkv_proj") else up)
        self.multiplier = float(lora.take(key + ".alpha", (), "F32")) / rank
        # The Comfy QKV LoRA concatenates A and block-diagonalizes B. Its
        # alpha is multiplied by three to keep the original training scale.
        if self.multiplier != (1.0 if steps == 4 else 0.0625):
            raise lora.contract.AdapterError("MODEL_INVALID", f"H3 {steps} 步 LoRA 的 alpha / rank 不匹配：{key}")

    def forward(self, value):
        if self.backend == "kitchen":
            output = torch.ops.comfy_kitchen.int8_linear(value.contiguous(), self.weight, self.weight_scale,
                                                          None, 2, True, 256)
        elif self.backend == "torch":
            output = quant.torch_int8_linear(value, self.weight, self.weight_scale)
        else:
            output = F.linear(value, self.weight)
        if self.up is None:
            return output
        low = F.linear(value, self.down)
        if self.up.ndim == 3:
            # Read the fused down result directly in Q/K/V batches. The add
            # writes the three batched GEMM results to their original columns
            # without transposing/copying a full sequence of BF16 activations.
            groups, width, rank = self.up.shape
            low = low.view(-1, groups, rank).transpose(0, 1)
            update = torch.bmm(low, self.up.transpose(1, 2))
            output.view(-1, groups, width).transpose(0, 1).add_(update, alpha=self.multiplier)
            return output
        return output.add_(F.linear(low, self.up), alpha=self.multiplier)


class GateFirst(nn.Module):
    def __init__(self, projection):
        super().__init__()
        self.proj = projection

    def forward(self, value):
        # Source checkpoint and LoRA both store [gate, value]. Applying the
        # activation in that order avoids rewriting a multi-GB set of matrices.
        gate, linear = self.proj(value).chunk(2, dim=-1)
        return F.silu(gate).mul_(linear)


class _TimeCurve(nn.Module):
    def __init__(self, table):
        super().__init__()
        self.register_buffer("table", table)

    def forward(self, timestep):
        position = timestep.float().clamp(0, 1) * (self.table.shape[0] - 1)
        lower = position.floor().long().clamp(max=self.table.shape[0] - 2)
        return torch.lerp(self.table[lower], self.table[lower + 1], (position - lower).unsqueeze(-1))


def _curve_linear(source, inputs, outputs, weights):
    layer = nn.Linear(inputs, outputs, device="meta")
    # Both pruned variants evaluate the curve projection in FP32. The fused
    # checkpoint preserves its BF16 weights and FP32 folded biases on disk.
    weight_dtype, bias_dtype = ("BF16", "F32") if weights.fused else ("F16", "F16")
    layer.weight = nn.Parameter(weights.take(source + ".weight", (outputs, inputs), weight_dtype).float(), False)
    layer.bias = nn.Parameter(weights.take(source + ".bias", (outputs,), bias_dtype).float(), False)
    return layer


class _Modulation(nn.Module):
    def __init__(self, linear, hidden):
        super().__init__()
        self.linear, self.hidden = linear, hidden

    def forward(self, temb):
        # The curve already represents the activated time embedding. The
        # reference casts the per-token shifts, scales and gates to stream BF16.
        rows = self.linear(temb).view(-1, 6 * self.hidden).to(torch.bfloat16)
        return rows.chunk(6, dim=-1)


class _OutputNorm(nn.Module):
    def __init__(self, norm, linear):
        super().__init__()
        self.norm, self.linear = norm, linear

    def forward(self, hidden, temb, timestep_indices):
        shift, scale = self.linear(temb).chunk(2, dim=-1)
        return self.norm(hidden) * (1.0 + scale.index_select(0, timestep_indices)) + shift.index_select(0, timestep_indices)


def _assign(module, key, source, weights, dtype):
    parameter = getattr(module, key)
    value = weights.take(source + "." + key, parameter.shape, dtype)
    setattr(module, key, nn.Parameter(value, requires_grad=False))


def _adapt_block(block, path, config, weights, lora, steps, backend):
    hidden, ffn = config["hidden_size"], config["ffn_dim"]
    inner = config["num_attention_heads"] * config["attention_head_dim"]
    def projection(suffix, inputs, outputs, rank=128):
        return _Projection(path + "." + suffix, inputs, outputs, weights, lora, steps, rank=rank, backend=backend)

    # These Comfy weights are already in contiguous Q / K / V row order.
    # Diffusers' fused processor splits them once, after the joint LoRA.
    attn = block.attn
    attn.to_qkv = projection("attn.qkv_proj", hidden, 3 * inner, rank=384)
    del attn.to_q, attn.to_k, attn.to_v
    attn.fused_projections = True
    attn.to_out[0] = projection("attn.out_proj", inner, hidden)
    block.ff.net[0] = GateFirst(projection("mlp.fc1", hidden, 2 * ffn))
    block.ff.net[2] = projection("mlp.fc2", ffn, hidden)
    for module, suffix in ((attn.norm_q, "attn.q_norm"), (attn.norm_k, "attn.k_norm"),
                           (block.norm1, "norm1"), (block.norm2, "norm2")):
        _assign(module, "weight", path + "." + suffix, weights, "BF16")
    if backend:
        linear = _curve_linear(path + ".adaln_proj.linear", config["time_embed_dim"], 18 * hidden, weights)
        block.adaln_proj = _Modulation(linear, hidden)


def load_transformer(root, steps, control, contract, *, sla_path=None, fused_path=None):
    """Load FL2VA Turbo, the trained SLA adapter, or the separate four-step fusion."""
    if steps not in (4, 8):
        raise contract.AdapterError("INVALID_PARAMETER", "本地 H3 Turbo 需要 4 或 8 步")
    if sla_path is not None and steps != 4:
        raise contract.AdapterError("UNSUPPORTED_ACCELERATION", "H3 SLA 权重仅支持 4 步")
    fused = fused_path is not None
    if fused and (steps != 4 or sla_path is not None):
        raise contract.AdapterError("UNSUPPORTED_ACCELERATION", "H3 融合版权重需要独立四步配方")
    from diffusers import MiniMaxH3Transformer3DModel
    config = contract.config(root, root / "transformer/config.json")
    if [config.get(k) for k in ("hidden_size", "num_layers", "num_refiner_layers", "num_attention_heads",
                                "attention_head_dim", "ffn_dim")] != [5376, 50, 2, 56, 128, 14336]:
        raise contract.AdapterError("UNSUPPORTED_MODEL", "本地 H3 压缩权重需要 FL2VA 配置")
    reader = load_sibling("mapped_weights").ReadOnlyWeights
    checkpoint_name = fused_path if fused else "transformer/comfy.safetensors"
    checkpoint = contract.safe_file(root, root / checkpoint_name)
    adapter = None
    if fused:
        # The import verifies the complete published SHA. Match the protected
        # receipt at load time, independent of who supplied this optional path.
        rows = load_sibling("import_h3").prepared_accelerators(root).get("fused", [])
        if len(rows) != 1 or checkpoint.resolve() != (root / rows[0]["path"]).resolve():
            raise contract.AdapterError("MODEL_CHANGED", "H3 融合版权重与已验证的安装记录不符")
    else:
        # The trained SLA adapter replaces regular Turbo in this branch.
        adapter_name = sla_path if sla_path is not None else f"loras/turbo-{steps}.safetensors"
        adapter = contract.safe_file(root, root / adapter_name)
    backend = quant.require_backend(contract)
    with reader(checkpoint) as base, (reader(adapter) if adapter is not None else nullcontext()) as delta:
        weights = _Weights(base, contract, fused=fused)
        lora = _Weights(delta, contract) if delta is not None else None
        table = weights.take("adaln_t_table", (1025, 8), "F32")
        if fused:
            # Exported for projecting additional 2688-wide AdaLN adapters.
            # Native pruned inference uses the stored 8-wide map and biases.
            weights.take("adaln_basis", (8, 2688), "F32")
            weights.take("adaln_mean", (2688,), "F32")
        config = dict(config, time_embed_dim=table.shape[1])
        with torch.device("meta"):
            model = MiniMaxH3Transformer3DModel.from_config(config)
        model.time_proj, model.time_embedder = nn.Identity(), _TimeCurve(table)
        model.rope.inv_freq = weights.take("rope.inv_freq", (config["rope_freq_dim"],), "F32")
        for mod, source, dtype in ((model.proj_in, "video_patch_proj", "F32"),
                                   (model.audio_proj_in, "audio_patch_proj", "F32"),
                                   (model.context_embedder, "condition_proj", "BF16"),
                                   (model.proj_out, "final_layer.video_out", "F32"),
                                   (model.audio_proj_out, "final_layer.audio_out", "F32")):
            _assign(mod, "weight", source, weights, dtype)
            _assign(mod, "bias", source, weights, dtype)
        for modules, prefix, quantized in ((model.token_refiner.refiner_blocks, "token_refiner.blocks", None),
                                            (model.transformer_blocks, "blocks", backend)):
            for index, block in enumerate(modules):
                control.check()
                _adapt_block(block, f"{prefix}.{index}", config, weights, lora, steps, quantized)
        _assign(model.token_refiner.final_norm, "weight", "token_refiner.final_norm", weights, "BF16")
        _assign(model.norm_out.norm, "weight", "final_layer.norm", weights, "BF16")
        final = _curve_linear("final_layer.adaln_proj.linear", config["time_embed_dim"],
                              2 * config["hidden_size"], weights)
        model.norm_out = _OutputNorm(model.norm_out.norm, final)
        weights.complete()
        if lora is not None:
            lora.complete()
    diagonal_bytes = [layer.up.numel() * layer.up.element_size() for layer in model.modules()
                      if isinstance(layer, _Projection) and layer.up is not None and layer.up.ndim == 3]
    model._huiyu_h3_qkv = dict(qkvLoraGroupedMatrices=len(diagonal_bytes),
                               qkvLoraOmittedZeroBytes=2 * sum(diagonal_bytes))
    model._huiyu_h3_sla = sla_path is not None
    model._huiyu_h3_fused = fused
    load_sibling("h3_modulation").install(model)
    return model.eval().requires_grad_(False)
