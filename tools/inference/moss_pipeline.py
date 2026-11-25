# Copyright 2026 OpenMOSS. Apache-2.0; see MOSS-LICENSE.
# Source: OpenMOSS-Team/MOSS-Image-Base@85975793d8b3d432f1b6e27f352abaa4c2a4c0d3/pipeline_moss_image.py
# Changes: optional task-local Spectrum image-feature forecasting in the DiT;
# loading, cache lifecycle and progress live in moss_adapter.py.
"""MOSSImage modeling and text-to-image pipeline (no Motor/TorchTitan imports).

Dependencies: torch>=2.9, diffusers>=0.38, transformers>=5.3, safetensors,
accelerate, Pillow. Copy this file anywhere and import it normally.

    import torch
    # Import MOSSImagePipeline from this file for component-level loading.
    pipe = MOSSImagePipeline.from_components_pretrained(
        transformer_path="exported_transformer",  # save_pretrained directory
        text_encoder_path="Qwen/Qwen3.5-9B",
        vae_path="black-forest-labs/FLUX.2-klein-4B",
    ).to("cuda")
    pipe("A cat", generator=torch.Generator("cuda").manual_seed(42)).images[0].save("cat.png")

Default guidance uses CFG 3 and skips block 22 only in the negative branch
(zero-based main DiT block indices; two forwards per sampling step):
    pipe("A cat", guidance_scale=3.0, uncond_skip_layers=[22])
    pipe("A cat", uncond_skip_layers=[])  # disable negative-branch skipping
Optional additional positive-branch SLG adds a third forward:
    pipe("A cat", slg_layers=[24], slg_scale=3.0)
The additional SLG layer/scale above illustrates the API, not a quality-tuned setting.

For a consolidated training state dict, create MOSSImageTransformer and
call load_training_state_dict(state), then save_pretrained("exported_transformer").
Select raw or EMA weights explicitly before calling it; distributed checkpoint
shards/optimizer states are not model state dicts. Defaults match the finalized dense MOSSImage model,
not MoE, CFG-distilled, video, or reference-image variants. Prompt strings are
already-rendered captions (dataset-specific quality/domain tags are not added).

First-release defaults: bf16 DiT/text-encoder weights, fp32 RoPE frequencies
and phase/sin/cos calculation, then RoPE cast to the video activation dtype.
Initial Gaussian noise is sampled directly in fp32, including with bf16 weights.
CFG and Euler latent updates use fp32; VAE decoding defaults to fp32. Scheduler
shift defaults to 5.0. Exact numerical parity with the original fp32-master
inference pipeline is not a release requirement.
"""
from __future__ import annotations

import importlib.util
import math
from pathlib import Path
import sys

import torch
from diffusers import AutoencoderKLFlux2, DiffusionPipeline, FlowMatchEulerDiscreteScheduler
from diffusers.schedulers.scheduling_utils import SchedulerMixin  # Required by custom-component discovery.
from diffusers.configuration_utils import register_to_config
from diffusers.image_processor import VaeImageProcessor
from diffusers.pipelines.pipeline_utils import ImagePipelineOutput
from diffusers.utils.torch_utils import randn_tensor
from transformers import AutoModel, AutoTokenizer


def _load_sibling(name):
    lifecycle = sys.modules.get("huiyu_worker_lifecycle")
    if lifecycle is not None:
        return lifecycle.load_sibling(name)
    module_name = f"huiyu_{name}"
    existing = sys.modules.get(module_name)
    if existing is not None:
        return existing
    spec = importlib.util.spec_from_file_location(module_name, Path(__file__).with_name(f"{name}.py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except BaseException:
        sys.modules.pop(module_name, None)
        raise
    return module


_transformer_module = _load_sibling("moss_transformer")
_RMSNorm = _transformer_module._RMSNorm
_situ = _transformer_module._situ
_validate_skip_layers = _transformer_module._validate_skip_layers
_rotate = _transformer_module._rotate
_attention = _transformer_module._attention
_TextBlock = _transformer_module._TextBlock
_TextProjection = _transformer_module._TextProjection
_Block = _transformer_module._Block
_RoPE = _transformer_module._RoPE
MOSSImageTransformer = _transformer_module.MOSSImageTransformer


class MOSSImageScheduler(FlowMatchEulerDiscreteScheduler):
    """Euler integration using the training project's V2, nearest-grid schedule."""
    @register_to_config
    def __init__(self, num_train_timesteps=1000, shift=5.0, training_shift=1.0):
        super().__init__(num_train_timesteps=num_train_timesteps, shift=1.0)
        self.register_to_config(shift=shift, training_shift=training_shift)

    def set_timesteps(self, num_inference_steps=50, device=None):
        if num_inference_steps < 1 or self.config.shift <= 0 or self.config.training_shift <= 0:
            raise ValueError('Steps and shifts must be positive.')
        total = self.config.num_train_timesteps
        def grid(count, shift):
            lower = shift / (total + shift - 1)
            values = torch.linspace(1, lower, count)
            return shift * values / (1 + (shift - 1) * values)
        sigmas = grid(num_inference_steps, self.config.shift)
        training = grid(total, self.config.training_shift).flip(0)
        upper = torch.searchsorted(training, sigmas).clamp(max=total - 1)
        lower = (upper - 1).clamp(min=0)
        nearest = torch.where((sigmas - training[lower]).abs() <= (training[upper] - sigmas).abs(), lower, upper)
        sigmas = torch.unique_consecutive(training[nearest])
        # Our sigmas have already been shifted and snapped. Avoid a second shift.
        self._shift = 1.0
        super().set_timesteps(device=device, sigmas=sigmas.tolist())


class MOSSImagePipeline(DiffusionPipeline):
    model_cpu_offload_seq = 'text_encoder->transformer->vae'
    _optional_components = ['text_encoder', 'tokenizer', 'vae']

    def __init__(self, transformer: MOSSImageTransformer,
                 scheduler: MOSSImageScheduler, text_encoder=None, tokenizer=None, vae=None):
        super().__init__()
        self.register_modules(transformer=transformer, scheduler=scheduler,
                              text_encoder=text_encoder, tokenizer=tokenizer, vae=vae)
        self.image_processor = VaeImageProcessor(vae_scale_factor=16)

    @classmethod
    def from_components_pretrained(cls, transformer_path, text_encoder_path, vae_path,
                                   torch_dtype=torch.bfloat16, vae_dtype=torch.float32,
                                   local_files_only=False):
        common = dict(local_files_only=local_files_only)
        transformer = MOSSImageTransformer.from_pretrained(transformer_path, torch_dtype=torch_dtype, **common)
        tokenizer = AutoTokenizer.from_pretrained(text_encoder_path, **common)
        text_encoder = AutoModel.from_pretrained(text_encoder_path, dtype=torch_dtype, **common).eval()
        subfolder = None if (Path(vae_path) / 'config.json').is_file() else 'vae'
        vae = AutoencoderKLFlux2.from_pretrained(vae_path, subfolder=subfolder, torch_dtype=vae_dtype, **common).eval()
        return cls(transformer.eval(), MOSSImageScheduler(), text_encoder, tokenizer, vae)

    @torch.no_grad()
    def encode_prompt(self, prompt, max_sequence_length=4096):
        if self.text_encoder is None or self.tokenizer is None:
            raise ValueError('Text encoder/tokenizer required for string prompts.')
        prompts = [prompt] if isinstance(prompt, str) else list(prompt)
        if not prompts or not all(isinstance(p, str) for p in prompts):
            raise ValueError('prompt must be a string or a nonempty list of strings.')
        rows = []
        # Unpadded individual forwards also avoid padding effects in Qwen GDN.
        for value in prompts:
            formatted = self.tokenizer.apply_chat_template(
                [{'role': 'user', 'content': value}], tokenize=False,
                add_generation_prompt=True, enable_thinking=True)
            inputs = self.tokenizer(formatted, return_tensors='pt', truncation=True,
                                    max_length=max_sequence_length).to(self._execution_device)
            output = self.text_encoder(**inputs, use_cache=False, return_dict=True)
            rows.append(output.last_hidden_state[0])
        length = max(row.shape[0] for row in rows)
        embeds = rows[0].new_zeros(len(rows), length, rows[0].shape[-1])
        mask = torch.zeros(len(rows), length, device=embeds.device, dtype=torch.bool)
        for index, row in enumerate(rows):
            embeds[index, :row.shape[0]] = row
            mask[index, :row.shape[0]] = True
        return embeds, mask

    @torch.no_grad()
    def __call__(self, prompt=None, *, height=1024, width=1024, num_inference_steps=50,
                 guidance_scale=3.0, negative_prompt='', num_images_per_prompt=1,
                 generator=None, latents=None, prompt_embeds=None, prompt_attention_mask=None,
                 negative_prompt_embeds=None, negative_prompt_attention_mask=None,
                 max_sequence_length=4096, output_type='pil', return_dict=True,
                 uncond_skip_layers=(22,), slg_layers=None, slg_scale=0.0,
                 slg_start=0.0, slg_stop=1.0):
        """Generate images with optional full-block skipping (zero-based indices).

        uncond_skip_layers defaults to (22,) and replaces CFG's negative-prompt
        prediction with a skipped-block prediction, retaining two forwards per
        step. Pass None or an empty sequence to disable skipping. slg_layers
        adds a skipped positive-prompt forward and the fp32 correction
        slg_scale * (cond - cond_skip) to CFG. With guidance_scale=1, active
        SLG uses cond_skip + slg_scale * (cond - cond_skip), matching Diffusers'
        default SkipLayerGuidance formulation, with two forwards and no negative
        branch. Both options can combine. slg_scale=1 then gives normal cond.
        Both uncond skipping and SLG are active where
        slg_start <= step_index / num_steps < slg_stop;
        the interval follows denoising order, from initial noise to final image.
        Outside it, inference uses normal CFG without skipping.
        slg_scale=0 or empty slg_layers disables the additional forward.
        """
        uncond_skip_layers = _validate_skip_layers(
            uncond_skip_layers, len(self.transformer.layers), 'uncond_skip_layers')
        slg_layers = _validate_skip_layers(slg_layers, len(self.transformer.layers), 'slg_layers')
        if not math.isfinite(slg_scale) or slg_scale < 0:
            raise ValueError('slg_scale must be finite and nonnegative.')
        if not 0 <= slg_start <= slg_stop <= 1:
            raise ValueError('Require 0 <= slg_start <= slg_stop <= 1.')
        if height <= 0 or width <= 0 or height % 16 or width % 16:
            raise ValueError('height and width must be positive multiples of 16.')
        if output_type not in {'pil', 'np', 'pt', 'latent'}:
            raise ValueError('output_type must be pil, np, pt or latent.')
        if num_images_per_prompt < 1 or not math.isfinite(guidance_scale) or guidance_scale < 0:
            raise ValueError('Invalid image count or guidance scale.')
        if not 1 <= max_sequence_length <= 4096:
            raise ValueError('max_sequence_length must be between 1 and 4096.')
        if (prompt is None) == (prompt_embeds is None):
            raise ValueError('Provide exactly one of prompt and prompt_embeds.')
        device = self._execution_device
        execution = getattr(self.transformer, '_huiyu_execution', None)
        if execution is not None:
            execution.phase('encoding')
        if prompt_embeds is None:
            prompt_embeds, prompt_attention_mask = self.encode_prompt(prompt, max_sequence_length)
        batch = prompt_embeds.shape[0]
        def prepare(embeds, mask):
            if embeds.ndim != 3 or embeds.shape[0] != batch:
                raise ValueError('Prompt embeddings must be [B, S, C] with matching batch size.')
            if mask is None:
                mask = torch.ones(embeds.shape[:2], dtype=torch.bool, device=embeds.device)
            embeds, mask = embeds.to(device), mask.to(device)
            if num_images_per_prompt == 1:
                return embeds, mask
            return (embeds.repeat_interleave(num_images_per_prompt, 0),
                    mask.repeat_interleave(num_images_per_prompt, 0))
        positive, positive_mask = prepare(prompt_embeds, prompt_attention_mask)
        do_cfg = guidance_scale != 1.0
        if do_cfg:
            if negative_prompt_embeds is None:
                negatives = [negative_prompt] * batch if isinstance(negative_prompt, str) else negative_prompt
                if len(negatives) != batch:
                    raise ValueError('negative_prompt must match prompt batch size.')
                negative_prompt_embeds, negative_prompt_attention_mask = self.encode_prompt(negatives, max_sequence_length)
            negative, negative_mask = prepare(negative_prompt_embeds, negative_prompt_attention_mask)
        shape = (batch * num_images_per_prompt, self.transformer.config.latent_channels, height // 16, width // 16)
        if latents is None:
            # Sample in fp32: promoting bf16 noise afterward cannot restore its precision.
            latents = randn_tensor(shape, generator=generator, device=device, dtype=torch.float32)
        elif tuple(latents.shape) != shape:
            raise ValueError(f'latents must have shape {shape}.')
        else:
            latents = latents.to(device=device, dtype=torch.float32)
        self.scheduler.set_timesteps(num_inference_steps, device=device)
        num_steps = len(self.scheduler.timesteps)
        spectrum = getattr(self.transformer, '_huiyu_spectrum', None)
        negative_branch = {'spectrum_branch': 'negative'} if spectrum is not None else {}
        skipped_branch = {'spectrum_branch': 'positive-skip'} if spectrum is not None else {}
        if execution is not None:
            execution.phase('sampling')
        for step_index, timestep in enumerate(self.progress_bar(self.scheduler.timesteps)):
            if spectrum is not None:
                spectrum.begin_step(step_index, num_steps)
            skip_active = slg_start <= step_index / num_steps < slg_stop
            # CFG must combine fp32 predictions, even when the DiT runs in bf16.
            # Converting only the combined velocity would preserve rounding errors.
            prediction = self.transformer(latents, timestep, positive, positive_mask).sample.float()
            conditional = prediction
            if do_cfg:
                skip_kwargs = {'skip_layers': uncond_skip_layers} if uncond_skip_layers and skip_active else {}
                uncond = self.transformer(latents, timestep, negative, negative_mask, **skip_kwargs, **negative_branch).sample.float()
                prediction = uncond + guidance_scale * (prediction - uncond)
                del uncond
            if slg_layers and slg_scale > 0 and skip_active:
                skipped = self.transformer(
                    latents, timestep, positive, positive_mask, skip_layers=slg_layers, **skipped_branch).sample.float()
                if not do_cfg:
                    prediction = skipped
                prediction = prediction + slg_scale * (conditional - skipped)
                del skipped
            latents = self.scheduler.step(prediction, timestep, latents, return_dict=False)[0]
            del prediction, conditional
        # The decoder needs only the final latents. Return sampling allocations
        # to the allocator before the VAE's placement hook sizes its handoff.
        if spectrum is not None:
            spectrum.clear()
        if execution is not None:
            execution.release_sampling()
        del prompt_embeds, prompt_attention_mask, negative_prompt_embeds, negative_prompt_attention_mask
        del positive, positive_mask
        if do_cfg:
            del negative, negative_mask
        if output_type == 'latent':
            images = latents
        else:
            if execution is not None:
                execution.phase('decoding')
            if self.vae is None:
                raise ValueError('A FLUX.2 VAE is required for decoded output.')
            z = latents.to(dtype=self.vae.dtype)
            bn = self.vae.bn
            eps = self.vae.config.batch_norm_eps
            z = z * (bn.running_var + eps).sqrt().to(z).view(1, -1, 1, 1) + bn.running_mean.to(z).view(1, -1, 1, 1)
            b, c, h, w = z.shape
            z = z.reshape(b, c // 4, 2, 2, h, w).permute(0, 1, 4, 2, 5, 3).reshape(b, c // 4, 2 * h, 2 * w)
            images = self.vae.decode(z, return_dict=False)[0].clamp(-1, 1)
            images = self.image_processor.postprocess(images, output_type=output_type)
        self.maybe_free_model_hooks()
        return ImagePipelineOutput(images=images) if return_dict else (images,)
