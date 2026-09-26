export const DEFAULT_SD_NEGATIVE = [
  'worst quality', 'low quality', 'normal quality', 'lowres', 'blurry',
  'photorealistic', 'realistic skin', '3d render', 'bad anatomy',
  'bad hands', 'cropped', 'duplicate',
].join(', ')

export const DUAL_SAFETY_NEGATIVE = [
  'extra person', '3girls', '1boy', 'male', 'duplicate person', 'cloned face',
  'identical twins', 'merged bodies', 'fused limbs', 'swapped hair',
  'swapped eye color', 'wrong character clothing',
].join(', ')

export interface DualEnhancement {
  regional?: boolean
  ratios?: string
  baseRatio?: string
  generationMode?: 'Attention' | 'Latent'
  controlModel?: string
  controlImage?: string
  controlWeight?: number
  controlEnd?: number
  resizeMode?: string
  adetailer?: boolean
  adModel?: string
}

export interface SDGenerateParams {
  prompt: string
  negative_prompt?: string
  width?: number
  height?: number
  cfg_scale?: number
  steps?: number
  sampler_name?: string
  scheduler?: string
  hr_fix?: boolean
  hr_scale?: number
  hr_upscaler?: string
  hr_second_pass_steps?: number
  denoising_strength?: number
  seed?: number
  model?: string
  alwayson_scripts?: Record<string, unknown>
  char?: string
  lora?: string | string[]
  lora_weight?: number
  dual_enhancement?: DualEnhancement
  runtimeContext?: Record<string, unknown>
}

export interface Txt2ImgPayload extends Record<string, unknown> {
  prompt: string
  negative_prompt: string
  width: number
  height: number
  cfg_scale: number
  steps: number
  sampler_name: string
  seed: number
  batch_size: number
  n_iter: number
  send_images: boolean
  save_images: boolean
  alwayson_scripts?: Record<string, unknown>
}

export interface SDEnhancementState {
  regional: boolean
  controlNet: boolean
  adetailer: boolean
}

export interface BuiltTxt2ImgRequest {
  payload: Txt2ImgPayload
  enhancements: SDEnhancementState
}

export interface ParsedTxt2ImgResponse {
  image: string
  images: string[]
  seed: number | null
  seeds: number[]
  infotexts: string[]
  info: Record<string, unknown>
  parameters: Record<string, unknown>
}

function splitRegionalSections(prompt: string): string[] {
  return String(prompt || '')
    .replace(/\s*,?\s*\bBREAK\b\s*,?\s*/gi, '\u001e')
    .split('\u001e')
    .map(section => section.trim().replace(/^,\s*|,\s*$/g, ''))
    .filter(Boolean)
}

function buildRegionalPrompt(prompt: string): { prompt: string; enabled: boolean } {
  const sections = splitRegionalSections(prompt)
  if (sections.length < 2) return { prompt, enabled: false }
  const first = sections.shift() || ''
  const leftStart = first.lastIndexOf('(')
  if (leftStart < 0) return { prompt, enabled: false }
  const base = first.slice(0, leftStart).replace(/,\s*$/, '').trim()
  const left = first.slice(leftStart).trim()
  const right = sections.join(', ').trim()
  if (!base || !left || !right) return { prompt, enabled: false }
  return { prompt: [base, left, right].join(' BREAK '), enabled: true }
}

function parseLora(raw: string): { name: string; weight: number | null } {
  const value = String(raw || '').trim().replace(/^<lora:/i, '').replace(/>$/, '')
  const [name = '', rawWeight] = value.split(':')
  const weight = Number(rawWeight)
  return { name: name.trim(), weight: Number.isFinite(weight) ? weight : null }
}

function appendLoraToBase(prompt: string, loraTags: string[]): string {
  if (!loraTags.length) return prompt
  const sections = splitRegionalSections(prompt)
  if (sections.length < 2) return [prompt, ...loraTags].filter(Boolean).join(', ')
  sections[0] = [sections[0], ...loraTags].filter(Boolean).join(', ')
  return sections.join(' BREAK ')
}

function appendLorasToRegions(prompt: string, loraTags: string[]): string {
  if (!loraTags.length) return prompt
  const sections = splitRegionalSections(prompt)
  if (sections.length < 3) return appendLoraToBase(prompt, loraTags)
  const unresolved: string[] = []
  loraTags.forEach(tag => {
    let target = -1
    if (/ayachi[_ -]?nene/i.test(tag)) {
      target = sections.findIndex((section, index) => index > 0 && /ayachi[_ -]?nene/i.test(section))
    } else if (/shiki[_ -]?natsume/i.test(tag)) {
      target = sections.findIndex((section, index) => index > 0 && /shiki[_ -]?natsume/i.test(section))
    }
    if (target > 0) sections[target] = `${sections[target]}, ${tag}`
    else unresolved.push(tag)
  })
  if (unresolved.length) sections[0] = [sections[0], ...unresolved].join(', ')
  return sections.join(' BREAK ')
}

function regionalPrompterArgs(options: DualEnhancement): unknown[] {
  return [
    true, false, 'Matrix', 'Columns', 'Mask', 'Prompt',
    options.ratios || '1,1',
    options.baseRatio || '0.2',
    true, false, false, options.generationMode || 'Attention', [],
    '0', '0', '0.4', null, '0', '0', false,
  ]
}

function makeControlNetUnit(enhancement: DualEnhancement): Record<string, unknown> {
  return {
    input_mode: 'simple',
    enabled: true,
    module: 'None',
    model: enhancement.controlModel,
    weight: enhancement.controlWeight ?? 0.78,
    image: String(enhancement.controlImage || '').replace(/^data:image\/[a-z0-9.+-]+;base64,/i, ''),
    resize_mode: enhancement.resizeMode || 'Resize and Fill',
    processor_res: 1024,
    threshold_a: -1,
    threshold_b: -1,
    guidance_start: 0,
    guidance_end: enhancement.controlEnd ?? 0.82,
    pixel_perfect: false,
    control_mode: 'Balanced',
    hr_option: 'Both',
    save_detected_map: false,
  }
}

function makeADetailerArgs(enhancement: DualEnhancement): unknown[] {
  return [
    true,
    false,
    {
      ad_model: enhancement.adModel || 'face_yolov8s.pt',
      ad_model_classes: '',
      ad_tab_enable: true,
      ad_prompt: 'detailed eyes, clean face, character-accurate facial features',
      ad_negative_prompt: 'deformed face, asymmetrical eyes, cross-eyed',
      ad_confidence: 0.35,
      ad_mask_filter_method: 'Area',
      ad_mask_k: 2,
      ad_mask_min_ratio: 0,
      ad_mask_max_ratio: 0.18,
      ad_dilate_erode: 4,
      ad_x_offset: 0,
      ad_y_offset: 0,
      ad_mask_merge_invert: 'None',
      ad_mask_blur: 4,
      ad_denoising_strength: 0.22,
      ad_inpaint_only_masked: true,
      ad_inpaint_only_masked_padding: 32,
      ad_use_inpaint_width_height: true,
      ad_inpaint_width: 768,
      ad_inpaint_height: 768,
      ad_use_steps: false,
      ad_steps: 20,
      ad_use_cfg_scale: false,
      ad_cfg_scale: 5.5,
      ad_use_checkpoint: false,
      ad_checkpoint: 'Use same checkpoint',
      ad_use_vae: false,
      ad_vae: 'Use same VAE',
      ad_use_sampler: false,
      ad_sampler: 'DPM++ 2M',
      ad_scheduler: 'Use same scheduler',
      ad_use_noise_multiplier: false,
      ad_noise_multiplier: 1,
      ad_use_clip_skip: false,
      ad_clip_skip: 1,
      ad_restore_face: false,
      ad_controlnet_model: 'None',
      ad_controlnet_module: 'None',
      ad_controlnet_weight: 1,
      ad_controlnet_guidance_start: 0,
      ad_controlnet_guidance_end: 1,
      is_api: true,
    },
  ]
}

export function buildTxt2ImgRequest(params: SDGenerateParams): BuiltTxt2ImgRequest {
  let prompt = String(params.prompt || '')
  const loras = params.lora
    ? (Array.isArray(params.lora) ? params.lora : String(params.lora).split(','))
    : []
  const parsedLoras = loras.map(parseLora).filter(item => item.name)
  const dual = params.char === 'triad' || parsedLoras.length > 1
    || (prompt.includes('ayachi_nene') && prompt.includes('shiki_natsume'))
  const fallbackWeight = dual ? 0.62 : (params.lora_weight ?? 0.8)
  const loraTags = parsedLoras
    .filter(item => !prompt.includes(`<lora:${item.name}`))
    .map(item => `<lora:${item.name}:${item.weight ?? fallbackWeight}>`)
  const enhancement = dual ? params.dual_enhancement : undefined
  const regional = enhancement?.regional ? buildRegionalPrompt(prompt) : { prompt, enabled: false }
  prompt = regional.enabled && enhancement?.generationMode === 'Latent'
    ? appendLorasToRegions(regional.prompt, loraTags)
    : appendLoraToBase(regional.prompt, loraTags)

  let negative = typeof params.negative_prompt === 'string'
    ? params.negative_prompt.trim()
    : DEFAULT_SD_NEGATIVE
  if (dual && !negative.includes('merged bodies')) {
    negative = [negative, DUAL_SAFETY_NEGATIVE].filter(Boolean).join(', ')
  }

  const payload: Txt2ImgPayload = {
    prompt,
    negative_prompt: negative,
    width: params.width ?? 832,
    height: params.height ?? 1216,
    cfg_scale: params.cfg_scale ?? 5.5,
    steps: params.steps ?? 28,
    sampler_name: params.sampler_name || 'DPM++ 2M',
    seed: params.seed ?? -1,
    batch_size: 1,
    n_iter: 1,
    send_images: true,
    save_images: false,
  }
  if (params.scheduler) payload.scheduler = params.scheduler
  if (params.hr_fix) {
    payload.enable_hr = true
    payload.hr_scale = params.hr_scale ?? 1.5
    payload.hr_upscaler = params.hr_upscaler || 'Latent'
    payload.hr_second_pass_steps = params.hr_second_pass_steps
      ?? Math.max(10, Math.round((params.steps ?? 28) * 0.5))
    payload.denoising_strength = params.denoising_strength ?? 0.35
  }
  if (params.model) {
    payload.override_settings = { sd_model_checkpoint: params.model }
    payload.override_settings_restore_afterwards = true
  }

  const scripts = { ...(params.alwayson_scripts || {}) }
  if (regional.enabled && enhancement) {
    scripts['Regional Prompter'] = { args: regionalPrompterArgs(enhancement) }
  }
  if (enhancement?.adetailer) scripts.ADetailer = { args: makeADetailerArgs(enhancement) }
  if (enhancement?.controlModel && enhancement.controlImage) {
    scripts.ControlNet = { args: [makeControlNetUnit(enhancement)] }
  }
  if (Object.keys(scripts).length) payload.alwayson_scripts = scripts

  return {
    payload,
    enhancements: {
      regional: regional.enabled,
      controlNet: Boolean(scripts.ControlNet),
      adetailer: Boolean(scripts.ADetailer),
    },
  }
}

function dataUrl(image: unknown): string {
  const value = String(image || '')
  return /^data:image\//i.test(value) ? value : `data:image/png;base64,${value}`
}

export function parseTxt2ImgResponse(raw: unknown): ParsedTxt2ImgResponse {
  const response = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const images = Array.isArray(response.images) ? response.images.map(dataUrl).filter(Boolean) : []
  if (!images.length) throw new Error('SD WebUI 返回数据中没有图片')
  let info: Record<string, unknown> = {}
  if (typeof response.info === 'string') {
    try { info = JSON.parse(response.info || '{}') as Record<string, unknown> } catch {}
  } else if (response.info && typeof response.info === 'object') {
    info = response.info as Record<string, unknown>
  }
  const seeds = Array.isArray(info.all_seeds)
    ? info.all_seeds.map(Number).filter(Number.isFinite)
    : []
  const seedValue = info.seed ?? seeds[0]
    ?? (response.parameters && typeof response.parameters === 'object'
      ? (response.parameters as Record<string, unknown>).seed : undefined)
  return {
    image: images[0],
    images,
    seed: Number.isFinite(Number(seedValue)) ? Number(seedValue) : null,
    seeds,
    infotexts: Array.isArray(info.infotexts) ? info.infotexts.map(String) : [],
    info,
    parameters: response.parameters && typeof response.parameters === 'object'
      ? response.parameters as Record<string, unknown> : {},
  }
}
