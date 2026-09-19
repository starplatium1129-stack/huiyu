export type CharKey = 'nene' | 'natsume' | 'triad'
export type DrawEngine = 'sd' | 'anima' | 'krea2'

export type HistoryEntry = {
  id: string | number; timestamp: number; character: string
  scene: string | null; sceneTitle: string | null
  story: string; visualDescription?: string; prompt: string; negative: string; seed: number
  emotion: string[]; shot: string | null; lighting: string | null
  composition: string | null; colorMood: string | null
  manual_tags: string[]; lora: string | null
  cfg: number | string; steps: number | string; sampler: string
  scheduler: string; checkpoint: string; size: string
  engine?: DrawEngine; profile?: string; model?: string
  provider?: 'comfy' | 'webui'
  loraId?: string | null; loraStrength?: number | null
  loras?: ReadonlyArray<{ id: string; strength: number }>
  preview?: boolean
  /** 成片真实像素；size 只是保存时下拉框的值，作品册排版以这两个为准 */
  width: number | null; height: number | null
  rating: Record<string, number>; favorite: boolean; notes: string
  image_id: string; image_url: string; version: number
  parent_id: string | number | null; project: string
  /** 热门角色无 LoRA 创作模式（旧历史缺省 studio，向后兼容）。 */
  subject?: 'studio' | 'popular'
  characterId?: string
  outfitId?: string
  blueprintId?: string | null
  noLora?: boolean
  /** 生成时实际使用的 Krea Style LoRA id；旧历史缺省无 Style LoRA。 */
  styleLoraId?: string | null
  /** 专家模式选中的模型原生画师风格 id，最多两位。 */
  artistStyleIds?: string[]
  /** 2026-08-29 修复：高清修复（SD hires）与脸部修复等生成参数此前未保存，
   *  作品册无法回显「开了 hires」；旧条目缺省 undefined（展示为「—」）。 */
  hiresFix?: boolean
  hiresScale?: number
  hiresUpscaler?: string
  hiresSteps?: number
  hiresDenoise?: number
  faceDetailer?: boolean
}

export interface Selections {
  emotion: string[]; shot: string | null
  lighting: string | null; composition: string | null
}

