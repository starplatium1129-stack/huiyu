"""Comfy's FP32 Euler state and VAE boundaries for the packed QWEN-Manga workflow."""
import torch
from diffusers import FlowMatchEulerDiscreteScheduler, QwenImage21Pipeline
from diffusers.pipelines.qwenimage.pipeline_output import QwenImagePipelineOutput
from diffusers.schedulers.scheduling_flow_match_euler_discrete import FlowMatchEulerDiscreteSchedulerOutput
from transformers import Qwen3VLProcessor


class MangaProcessor(Qwen3VLProcessor):
    def _process_images(self, images, **kwargs):
        # The pipeline already supplies RGB on the workflow's 32-pixel grid.
        # Keep the processor's patch order and image placeholders, but follow
        # the upstream vision tower's two separate FP32 normalization steps.
        kwargs.update(do_resize=False, do_rescale=False, do_normalize=False, return_tensors="pt")
        features, replacements = super()._process_images(images, **kwargs)
        pixels = features["pixel_values"].float().div_(255.0)
        features["pixel_values"] = pixels.sub_(0.5).div_(0.5)
        return features, replacements


class MangaEulerScheduler(FlowMatchEulerDiscreteScheduler):
    def step(self, model_output, timestep, sample, return_dict=True):
        if self.step_index is None:
            self._init_step_index(timestep)
        state = self.sample_fp32.to(sample.device)
        sigma, next_sigma = self.sigmas[self.step_index:self.step_index + 2]
        # Match Comfy CONST.calculate_denoised, to_d and sample_euler in that
        # order. Only the input to the next DiT call is rounded to model dtype.
        denoised = state - model_output.float() * sigma
        derivative = (state - denoised) / sigma
        self.sample_fp32 = state + derivative * (next_sigma - sigma)
        self._step_index += 1
        projected = self.sample_fp32.to(sample.dtype)
        return FlowMatchEulerDiscreteSchedulerOutput(prev_sample=projected) if return_dict else (projected,)


class MangaPipeline(QwenImage21Pipeline):
    def _get_qwen_prompt_embeds(self, prompt, image=None, device=None):
        prompts = [prompt] if isinstance(prompt, str) else prompt
        prompts = [text.replace(r"\(", "(").replace(r"\)", ")") for text in prompts]
        embeds, mask, image_slots = super()._get_qwen_prompt_embeds(prompts, image, device)
        # The text encoder runs in FP32. Comfy casts conditioning to the
        # denoiser's compute dtype on entry, before projection and VAE encoding.
        return embeds.to(self.transformer.img_in.weight.dtype), mask, image_slots

    def encode_prompt(self, *args, **kwargs):
        embeds, mask, image_slots = super().encode_prompt(*args, **kwargs)
        # Rebind the projection indices even when an earlier image/prompt
        # returns from the CPU conditioning cache after another layout ran.
        self.transformer.txt_in.text_indices = (~image_slots[0]).nonzero(as_tuple=True)[0]
        return embeds, mask, image_slots

    def _image_vae(self, tensor, pixels, *, decode):
        memory = getattr(self, "_huiyu_memory", None)
        if hasattr(memory, "prepare_manga_vae"):
            memory.prepare_manga_vae(pixels, decode=decode)
        operation = self.vae.decode if decode else self.vae.encode
        try:
            return operation(tensor)
        except torch.cuda.OutOfMemoryError:
            if not tensor.is_cuda or self.vae.use_tiling:
                raise
        # A different application may acquire VRAM after the budget check.
        # Leave the exception scope before retrying so full-frame buffers drop.
        torch.cuda.empty_cache()
        self.vae.enable_tiling()
        try:
            return operation(tensor)
        finally:
            self.vae.disable_tiling()

    def _latent_stats(self, latent):
        shape = (1, self.latent_channels, 1, 1, 1)
        mean = latent.new_tensor(self.vae.config.latents_mean).view(shape)
        std = latent.new_tensor(self.vae.config.latents_std).view(shape)
        return mean, std

    def _encode_vae_image(self, image, generator):
        # Both implementations use the mode, with no RNG draw. Comfy normalizes
        # the intermediate in FP32 before casting the reference to the DiT dtype.
        latent = self._image_vae(image, image.shape[-2] * image.shape[-1], decode=False).latent_dist.mode().float()
        mean, std = self._latent_stats(latent)
        return ((latent - mean) / std).to(image.dtype)

    @torch.no_grad()
    def __call__(self, *, latents, height, width, output_type="np", return_dict=True, **kwargs):
        if latents.dtype != torch.float32:
            raise ValueError("QWEN-Manga requires the original FP32 noise for Euler sampling")
        # PipelineCache constructs a fresh scheduler for each task. Diffusers
        # still owns prompt encoding, timestep projection, KV reuse and callbacks.
        self.scheduler.sample_fp32 = latents
        try:
            super().__call__(latents=latents, height=height, width=width,
                             output_type="latent", return_dict=False, **kwargs)
            sampled = self.scheduler.sample_fp32
        finally:
            self.scheduler.sample_fp32 = None
            self.transformer.txt_in.text_indices = None

        if output_type == "latent":
            image = sampled
        else:
            spatial = self._unpack_latents(sampled, height, width, self.vae_scale_factor)
            mean, std = self._latent_stats(spatial)
            # Comfy denormalizes the sampler output in FP32 before VAE decode,
            # then converts the decoded channels back to FP32 for postprocessing.
            vae_input = (spatial * std + mean).to(self.vae.dtype)
            decoded = self._image_vae(vae_input, height * width, decode=True).sample[:, :, 0]
            image = self.image_processor.postprocess(decoded.float(), output_type=output_type)
        return QwenImagePipelineOutput(images=image) if return_dict else (image,)
