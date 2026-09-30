import type { SDGenerateParams, Txt2ImgPayload } from './sdRequest'

/** The gateway projection used by both desktop and Web SD submission. */
export function buildRuntimeSdInput(params: SDGenerateParams, payload: Txt2ImgPayload, local: boolean) {
  const names = params.lora ? (Array.isArray(params.lora) ? params.lora : String(params.lora).split(',')) : []
  const loras = names.map(raw => {
    const match = String(raw).replace(/^<lora:/i, '').replace(/>$/, '').split(':')
    const name = match[0].trim()
    const id = name === 'ayachi_nene_v18_wd14' ? 'L_NENE_V18_WD14' : name === 'shiki_natsume_v18_wd14' ? 'L_NAT_V18_WD14' : ''
    const strength = match[1]?.trim() ? Number(match[1]) : params.lora_weight
    return id ? { id, strength: typeof strength === 'number' && Number.isFinite(strength) ? strength : 0.8 } : null
  }).filter((value): value is { id: string; strength: number } => Boolean(value))
  const modelId = String(params.model || '').includes('waiIllustriousSDXL_v170') ? 'waiIllustriousSDXL_v170' : undefined
  return { prompt: payload.prompt, negative: payload.negative_prompt, profile: '', ...(modelId ? { modelId } : {}),
    character: params.char || '', loras, width: payload.width, height: payload.height,
    steps: payload.steps, cfg: payload.cfg_scale, seed: payload.seed,
    sampler: payload.sampler_name, scheduler: String(payload.scheduler || params.scheduler || ''),
    hiresFix: Boolean(params.hr_fix), hiresScale: params.hr_scale, hiresUpscaler: params.hr_upscaler,
    hiresSteps: params.hr_second_pass_steps, denoisingStrength: params.denoising_strength,
    faceDetailer: Boolean(params.alwayson_scripts?.ADetailer), ...(local ? { adultEnabled: true } : {}) }
}
