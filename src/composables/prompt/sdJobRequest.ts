import type { SDQueueJob } from '@/composables/generation/useSDQueue'
import type { SDGenerateParams } from '@/utils/sdRequest'

function singleDetailerScripts(): Record<string, unknown> {
  const passes: Array<[string, string, string, number, number]> = [
    ['face_yolov8s.pt', 'detailed eyes, clean face, character-accurate facial features', 'deformed face, asymmetrical eyes, cross-eyed', 0.35, 0.18],
    ['hand_yolov8n.pt', 'detailed hands, five fingers, natural fingers', 'extra fingers, missing fingers, fused fingers, malformed hands', 0.3, 0.16],
  ]
  return { ADetailer: { args: [true, false, ...passes.map(([model, prompt, negative, confidence, denoise]) => ({
    ad_model: model, ad_prompt: prompt, ad_negative_prompt: negative, ad_confidence: confidence, ad_denoising_strength: denoise,
    ad_inpaint_only_masked: true, ad_inpaint_only_masked_padding: 32, ad_use_inpaint_width_height: true,
    ad_inpaint_width: 768, ad_inpaint_height: 768, is_api: true,
  }))] } }
}

/** Submission and recipe preview share the same frozen job projection and detailer rule. */
export function sdJobRequest(job: Omit<SDQueueJob, 'id'>): SDGenerateParams {
  const [width, height] = String(job.size).split('x').map(Number)
  const directHighResolution = !job.hiresFix && (width || 832) * (height || 1216) > 1_500_000
  return { prompt: job.prompt, negative_prompt: job.negative, width: width || 832, height: height || 1216,
    cfg_scale: job.cfg, steps: job.steps, sampler_name: job.sampler, scheduler: job.scheduler || undefined,
    hr_fix: job.hiresFix, hr_scale: job.hiresScale, hr_upscaler: job.hiresUpscaler, hr_second_pass_steps: job.hiresSteps,
    denoising_strength: job.denoisingStrength, seed: job.seed, model: job.checkpoint || undefined, lora: job.lora,
    alwayson_scripts: job.faceDetailer && job.char !== 'triad' && directHighResolution ? singleDetailerScripts() : undefined }
}
