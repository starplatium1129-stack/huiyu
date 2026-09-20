import { CHECKPOINT, SAMPLERS, OUTPUT_PREFIX } from './constants';
import type { GenerationInput } from './types';
export function buildWorkflow(input: GenerationInput) {
    let model = '1';
    let clip = '1';
    let vae = '1';
    let graph: Record<string, {
        class_type: string;
        inputs: Record<string, unknown>;
    }> = { '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: CHECKPOINT } } };
    input.loras.forEach(function (lora, index) {
        let id = String(2 + index);
        graph[id] = { class_type: 'LoraLoader', inputs: { model: [model, 0], clip: [clip, 1], lora_name: lora.file, strength_model: lora.strength, strength_clip: lora.strength } };
        model = id;
        clip = id;
    });
    let positive = '4';
    let negative = '5';
    let latent = '6';
    let sample = '7';
    let decoded = '8';
    let output = '10';
    graph[positive] = { class_type: 'CLIPTextEncode', inputs: { clip: [clip, 1], text: input.cleanPrompt || input.prompt.replace(/<lora:[^>]+>/gi, '').trim() } };
    graph[negative] = { class_type: 'CLIPTextEncode', inputs: { clip: [clip, 1], text: input.negative.replace(/<lora:[^>]+>/gi, '').trim() } };
    graph[latent] = { class_type: 'EmptyLatentImage', inputs: { width: input.width, height: input.height, batch_size: 1 } };
    graph[sample] = { class_type: 'KSampler', inputs: { model: [model, 0], positive: [positive, 0], negative: [negative, 0], latent_image: [latent, 0], seed: input.seed, steps: input.steps, cfg: input.cfg, sampler_name: SAMPLERS[input.sampler].sampler, scheduler: input.scheduler, denoise: 1 } };
    let finalSamples = [sample, 0];
    if (input.hiresFix && input.comfyHires) {
        // 2026-08-18 真 super-res 链路：ESRGAN（Remacri）像素级放大 + 缩到目标尺寸
        // + VAE 编码 + 低 denoise 二阶段精修；替代潜空间 nearest-exact 二阶段
        // （动漫线条/脸部更锐利，无块状伪影）。
        if (input.superResModel) {
            let targetW = Math.round(input.width * input.hiresScale / 8) * 8;
            let targetH = Math.round(input.height * input.hiresScale / 8) * 8;
            graph['11'] = { class_type: 'UpscaleModelLoader', inputs: { model_name: input.superResModel } };
            graph['12'] = { class_type: 'VAEDecode', inputs: { samples: finalSamples, vae: [vae, 2] } };
            graph['13'] = { class_type: 'ImageUpscaleWithModel', inputs: { upscale_model: ['11', 0], image: ['12', 0] } };
            graph['14'] = { class_type: 'ImageScale', inputs: { image: ['13', 0], upscale_method: 'lanczos', width: targetW, height: targetH, crop: 'disabled' } };
            graph['15'] = { class_type: 'VAEEncode', inputs: { pixels: ['14', 0], vae: [vae, 2] } };
            graph['16'] = { class_type: 'KSampler', inputs: { model: [model, 0], positive: [positive, 0], negative: [negative, 0], latent_image: ['15', 0], seed: input.seed, steps: input.hiresSteps, cfg: input.cfg, sampler_name: SAMPLERS[input.sampler].sampler, scheduler: input.scheduler, denoise: input.denoisingStrength } };
            finalSamples = ['16', 0];
        }
        else {
            graph['11'] = { class_type: 'LatentUpscaleBy', inputs: { samples: finalSamples, upscale_method: 'nearest-exact', scale_by: input.hiresScale } };
            graph['12'] = { class_type: 'KSampler', inputs: { model: [model, 0], positive: [positive, 0], negative: [negative, 0], latent_image: ['11', 0], seed: input.seed, steps: input.hiresSteps, cfg: input.cfg, sampler_name: SAMPLERS[input.sampler].sampler, scheduler: input.scheduler, denoise: input.denoisingStrength } };
            finalSamples = ['12', 0];
        }
    }
    graph[decoded] = { class_type: 'VAEDecode', inputs: { samples: finalSamples, vae: [vae, 2] } };
    graph[output] = { class_type: 'SaveImage', inputs: { images: [decoded, 0], filename_prefix: OUTPUT_PREFIX } };
    return graph;
}
