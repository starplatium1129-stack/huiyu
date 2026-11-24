"""Native H3 layer-50 conditioning from the local NVFP4/AWQ Qwen3-VL release."""
import hashlib
import json
import logging
import subprocess
from copy import deepcopy
from contextvars import ContextVar
from types import SimpleNamespace

import torch
from torch import nn
from torch.nn import functional as F
from huiyu_worker_lifecycle import load_sibling

try:
    import triton
    import triton.language as tl
except (ImportError, OSError):
    triton = None


CURRENT = ContextVar("h3_conditioning", default=None)
FP4 = [0., .5, 1., 1.5, 2., 3., 4., 6., -0., -.5, -1., -1.5, -2., -3., -4., -6.]


if triton is not None:
    @triton.jit
    def _unpack(packed, scales, table, output, columns: tl.constexpr, block: tl.constexpr):
        # Input tiles contain complete 128-row cuBLAS scale groups; each
        # supported matrix and the final row tile are multiples of block.
        index = tl.program_id(0) * block + tl.arange(0, block)
        row = index // columns
        column = index % columns
        group = column // 16
        scale_index = (((row // 128 * (columns // 64) + group // 4) * 32 +
                        row % 32) * 4 + row % 128 // 32) * 4 + group % 4
        byte = tl.load(packed + index // 2).to(tl.int32)
        level = tl.where(column % 2 == 0, byte >> 4, byte & 15)
        scale = tl.load(scales + scale_index).to(tl.int32)
        tl.store(output + index, tl.load(table + scale * 16 + level))


class PackedLinear(nn.Module):
    """Expand E2M1 in bounded row tiles; also works on GPUs without native FP4."""
    def __init__(self, tensors, prefix, linear, decoder):
        super().__init__()
        self.in_features, self.out_features = linear.in_features, linear.out_features
        self.decoder = decoder
        def take(suffix):
            return tensors.pop(prefix + suffix)
        scheme = json.loads(bytes(take(".comfy_quant").tolist()))
        if scheme.get("format") != "nvfp4" or linear.bias is not None:
            raise ValueError(f"Unsupported H3 encoder projection: {prefix}")
        self.register_buffer("packed", take(".weight"))
        self.register_buffer("scales", take(".weight_scale"))
        self.register_buffer("global_scale", take(".weight_scale_2"))
        self.register_buffer("input_scale", tensors.pop(prefix + ".pre_quant_scale", None))
        rows, cols = self.out_features, self.in_features
        if (self.packed.dtype != torch.uint8 or self.packed.shape != (rows, cols // 2)
                or self.scales.dtype != torch.float8_e4m3fn or self.scales.shape != (rows, cols // 16)
                or rows % 128 or cols % 64 or self.global_scale.numel() != 1
                or self.input_scale is not None and self.input_scale.shape != (cols,)):
            raise ValueError(f"Invalid NVFP4 scales or matrix dimensions: {prefix}")
        # Encode the two reference BF16 multiplications, including the
        # intermediate rounding, for every block-scale byte and E2M1 nibble.
        scales = torch.arange(256, dtype=torch.uint8).view(torch.float8_e4m3fn).to(torch.bfloat16)
        scales = scales * self.global_scale.to(torch.bfloat16)
        table = scales[:, None] * torch.tensor(FP4, dtype=torch.bfloat16)
        self.register_buffer("decode_table", table, persistent=False)

    def forward(self, hidden):
        if self.input_scale is not None:
            hidden = hidden * self.input_scale.to(hidden.dtype)
        # cuBLAS stores E4M3 block scales in 128-row by 4-column tiles.
        blocks = self.in_features // 16
        tiled = self.scales.view(torch.uint8).reshape(self.out_features // 128, blocks // 4, 32, 4, 4)
        chunk = 1024
        output = hidden.new_empty((*hidden.shape[:-1], self.out_features))
        fused = self.decoder["enabled"] and hidden.is_cuda and hidden.dtype == torch.bfloat16
        task = CURRENT.get()
        pairs = None
        for start in range(0, self.out_features, chunk):
            stop = min(start + chunk, self.out_features)
            if task is not None:
                task.control.check()
            if fused:
                weight = hidden.new_empty((stop - start, self.in_features))
                try:
                    with torch.cuda.device(hidden.device):
                        _unpack[(weight.numel() // 1024,)](
                            self.packed[start:stop], self.scales[start:stop].view(torch.uint8), self.decode_table,
                            weight, self.in_features, 1024)
                except (triton.TritonError, OSError, ImportError, subprocess.SubprocessError, RuntimeError) as exc:
                    # The portable runtime can have Triton without a usable
                    # compiler. Disable this optional path for this model.
                    if isinstance(exc, RuntimeError) and not any(word in str(exc).lower() for word in (
                            "compiler", "ptxas", "cuda.lib", "linker")):
                        raise
                    self.decoder["enabled"] = fused = False
                    del weight
                    logging.getLogger(__name__).warning("H3 NVFP4 kernel unavailable: %s", exc)
            if not fused:
                if pairs is None:
                    values = hidden.new_tensor(FP4)
                    byte = torch.arange(256, device=hidden.device)
                    pairs = torch.stack((values[byte >> 4], values[byte & 15]), dim=1)
                scales = tiled[start // 128:stop // 128].permute(0, 3, 2, 1, 4).reshape(stop-start, blocks)
                scales = scales.view(torch.float8_e4m3fn).to(hidden.dtype) * self.global_scale.to(hidden.dtype)
                weight = F.embedding(self.packed[start:stop].int(), pairs).reshape(stop-start, blocks, 16)
                weight = weight.mul_(scales.unsqueeze(-1)).flatten(1)
            output[..., start:stop] = F.linear(hidden, weight)
            del weight
        if task is not None:
            task.report["nvfp4FusedMatrices" if fused else "nvfp4EagerMatrices"] += 1
        return output


class PackedEmbedding(nn.Module):
    def __init__(self, matrix, scale):
        super().__init__()
        if matrix.dtype != torch.int8 or scale.shape != (matrix.shape[0], 1):
            raise ValueError("Invalid H3 text embedding")
        self.register_buffer("weight", matrix)
        self.register_buffer("scale", scale)

    def forward(self, token_ids):
        return (self.weight[token_ids].float() * self.scale[token_ids]).to(torch.bfloat16)


class ConditionStep:
    """Decorate one leaf of one task's flattened Diffusers block sequence."""
    def __init__(self, block, call):
        self.block, self.call = block, call

    def __getattr__(self, name):
        return getattr(self.block, name)

    def __deepcopy__(self, memo):
        # Diffusers exposes a public copy of the workflow for introspection.
        # Task-local caches and the live cancellation handle belong to the run.
        return deepcopy(self.block, memo)

    def __call__(self, components, state):
        return self.call(self.block, components, state)


class Conditioning:
    def __init__(self, entries, control):
        self.entries, self.control = entries, control
        self.images = {}
        self.vision_frames = ()
        self.report = dict(textHits=0, textMisses=0, visionHits=0, visionMisses=0,
                           keyframeHits=0, keyframeMisses=0, nvfp4FusedMatrices=0, nvfp4EagerMatrices=0)

    def frame_key(self, image):
        identity = id(image)
        if identity not in self.images:
            # The resize block has already chosen stretch or cover-crop and
            # packed the frames in presentation order. Keep PIL refs task-local.
            digest = hashlib.sha256(image.tobytes()).digest()
            self.images[identity] = (image, (image.mode, image.size, digest))
        return self.images[identity][1]

    def cached(self, kind, key, produce):
        self.control.check()
        index = (kind, key)
        if index in self.entries:
            self.report[kind + "Hits"] += 1
            self.entries.move_to_end(index)
            return tuple(t.to(device=device, copy=True) for t, device in self.entries[index][0])
        self.report[kind + "Misses"] += 1
        result = produce()
        self.control.check()
        size = sum(t.numel() * t.element_size() for t in result)
        limit = 64 * 1024**2
        if size <= limit:
            while self.entries and (len(self.entries) >= 12 or
                                    sum(v[1] for v in self.entries.values()) + size > limit):
                self.entries.popitem(last=False)
            # Store actual output devices as well. Qwen emits device features
            # alongside CPU modality tags, while VAE anchors are all CPU FP32.
            self.entries[index] = (tuple((t.detach().to("cpu", copy=True), t.device) for t in result), size)
        return result

    def text(self, block, components, state):
        args = block.get_block_state(state)
        images = getattr(args, "keyframes", None) or ()
        if not isinstance(args.prompt, str) or any(getattr(image, "mode", None) != "RGB" for image in images):
            return block(components, state)
        frames = tuple(self.frame_key(image) for image in images)
        device = components._execution_device
        key = (type(block).__name__, args.prompt, frames, components.text_encoder_layer,
               components.text_encoder.dtype, device)

        def encode():
            self.vision_frames = frames
            context = CURRENT.set(self)
            try:
                _, encoded = block(components, type(state)(values=args.as_dict()))
                return encoded.get("prompt_embeds"), encoded.get("text_token_tags")
            finally:
                CURRENT.reset(context)
                self.vision_frames = ()

        args.prompt_embeds, args.text_token_tags = self.cached("text", key, encode)
        # A cache hit must also restore H3's per-row modality tags. These are
        # distinct from the Qwen vision-token IDs inside the upstream encoder.
        block.set_block_state(state, args)
        return components, state

    def keyframes(self, block, components, state):
        args = block.get_block_state(state)
        if any(getattr(image, "mode", None) != "RGB" for image in args.keyframes):
            return block(components, state)
        recipe = (components._execution_device, components.vae.dtype, components.keyframe_encode_seed,
                  tuple(components.pixel_mean), tuple(components.pixel_std))
        args.condition_latents = []
        for image in args.keyframes:
            key = (self.frame_key(image), recipe)

            def encode():
                # Upstream already runs the VAE once per image, using a fresh,
                # fixed-seed posterior generator each time. Preserve that in a
                # private state. Later anchor noise still uses the job generator.
                single = type(state)(values={"keyframes": [image]})
                _, single = block(components, single)
                return (single.get("condition_latents")[0],)

            latent, = self.cached("keyframe", key, encode)
            args.condition_latents.append(latent)
        block.set_block_state(state, args)
        return components, state


def bind_conditioning(pipeline, entries, control):
    from diffusers.modular_pipelines.minimax_h3.encoders import (
        MiniMaxH3FL2VATextEncoderStep, MiniMaxH3KeyframeVaeEncoderStep, MiniMaxH3TextEncoderStep,
    )
    task = Conditioning(entries, control)
    # ModularPipeline.blocks returns a deepcopy. __call__ invokes _blocks,
    # the flattened per-task workflow selected by the pipeline constructor.
    leaves = pipeline._blocks.sub_blocks
    for name, block in leaves.items():
        if isinstance(block, (MiniMaxH3TextEncoderStep, MiniMaxH3FL2VATextEncoderStep)):
            leaves[name] = ConditionStep(block, task.text)
        elif isinstance(block, MiniMaxH3KeyframeVaeEncoderStep):
            leaves[name] = ConditionStep(block, task.keyframes)
    pipeline._huiyu_h3_conditioning = task.report


def load_encoder(root, control):
    from transformers import Qwen3VLConfig, Qwen3VLForConditionalGeneration
    folder = root / "text_encoder"
    config = Qwen3VLConfig.from_pretrained(str(folder), local_files_only=True)
    # The released conditioner ends immediately after decoder layer 50 and
    # never evaluates the final RMSNorm or a vocabulary projection.
    original_depth = config.text_config.num_hidden_layers
    config.text_config.num_hidden_layers = 50
    # Even a transient full vocabulary projection costs 3 GB of Windows
    # commit. Construct all parameters on meta and rebuild the two small
    # non-persistent rotary tables with the installed Transformers classes.
    with torch.device("meta"):
        encoder = Qwen3VLForConditionalGeneration(config)
    language = encoder.model.language_model
    language.rotary_emb = type(language.rotary_emb)(config.text_config)
    visual = encoder.model.visual
    rope = visual.rotary_pos_emb
    visual.rotary_pos_emb = type(rope)(config.vision_config) if hasattr(rope, "config") else type(rope)(rope.dim, rope.theta)
    encoder.set_attn_implementation("sdpa")
    language.norm = nn.Identity()
    encoder.lm_head = nn.Identity()
    with load_sibling("mapped_weights").ReadOnlyWeights(folder / "comfy.safetensors") as source:
        tensors = {key: source.get_tensor(key) for key in source.keys()}
    embed = "model.embed_tokens"
    if json.loads(bytes(tensors.pop(embed + ".comfy_quant").tolist())).get("format") != "int8_tensorwise":
        raise ValueError("Unsupported H3 embedding quantization")
    language.embed_tokens = PackedEmbedding(tensors.pop(embed + ".weight"), tensors.pop(embed + ".weight_scale"))
    decoder = {"enabled": triton is not None}
    for i, layer in enumerate(language.layers):
        control.check()
        for name, child in list(layer.named_modules()):
            if isinstance(child, nn.Linear):
                layer.set_submodule(name, PackedLinear(tensors, f"model.layers.{i}.{name}", child, decoder))
    for name, parameter in list(encoder.named_parameters()):
        if name.startswith("model.visual."):
            key = name.removeprefix("model.")
        elif name.startswith("model.language_model."):
            key = "model." + name.removeprefix("model.language_model.")
        else:
            raise ValueError(f"Unexpected H3 encoder parameter: {name}")
        value = tensors.pop(key)
        if value.shape != parameter.shape or value.dtype != torch.bfloat16:
            raise ValueError(f"Incompatible H3 text weight: {name}")
        parent, attr = name.rsplit(".", 1)
        setattr(encoder.get_submodule(parent), attr, nn.Parameter(value, requires_grad=False))
    if tensors:
        raise ValueError(f"Unexpected H3 encoder weights: {list(tensors)[:3]}")
    # Diffusers queries hidden_states[50] and checks the original Qwen config.
    # Materialize exactly that unnormalized state, without keeping 50 copies.
    config.text_config.num_hidden_layers = original_depth
    forward = encoder.model.forward
    def condition(*args, **kwargs):
        kwargs.update(output_hidden_states=False, use_cache=False)
        result = forward(*args, **kwargs)
        return SimpleNamespace(hidden_states={50: result.last_hidden_state})
    encoder.model.forward = condition

    original_vision = encoder.model.get_image_features
    def image_features(pixel_values, image_grid_thw, **kwargs):
        task = CURRENT.get()
        if task is None or not task.vision_frames or kwargs.get("return_dict") is not True:
            return original_vision(pixel_values, image_grid_thw, **kwargs)
        key = (task.vision_frames, pixel_values.dtype, pixel_values.device)

        def encode():
            output = original_vision(pixel_values, image_grid_thw, **kwargs)
            return (*output.pooler_output, *output.deepstack_features)

        features = task.cached("vision", key, encode)
        count = len(task.vision_frames)
        # Qwen3VLModel.forward consumes precisely these two fields. Features
        # from intermediate vision layers must accompany the final pooler rows.
        return SimpleNamespace(pooler_output=features[:count], deepstack_features=features[count:])
    encoder.model.get_image_features = image_features
    return encoder.eval()
