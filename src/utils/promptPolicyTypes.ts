

export interface PromptPart {
  cls?: 'q' | 'c' | 't' | 'l' | 'n' | 'p'
  text: string
  [key: string]: unknown
}


export type PromptEngine = 'sd' | 'anima' | 'krea2'


/**
 * 引擎/底模能力表：把“这个引擎能不能做 X”从散落硬编码收敛成数据驱动。
 * 后端 AnimaOption.capabilities 是运行时模型白名单；这里作为前端统一视图，
 * 由引擎默认值 + data/presets.json 的 profile.capabilities + 后端模型能力合并。
 */
export interface DrawCapabilities {
  /** 是否支持/接受负向 Prompt（Krea2 恒 false） */
  negative: boolean
  /** 是否支持角色/通用 LoRA */
  lora: boolean
  /** 是否支持无 LoRA 直出模式 */
  noLora: boolean
  /** 是否支持角色身份锁定（character 字段 / 角色 LoRA） */
  characterIdentity: boolean
  /** 是否支持双人（triad）身份构图 */
  dualCharacter: boolean
  /** 是否支持 hires 高清放大 */
  hires: boolean
  /** 是否支持 TeaCache 加速（Anima 专有） */
  teaCache: boolean
  /** 是否支持权重语法 (tag:1.2) / BREAK 标签流 */
  weightSyntax: boolean
  /** Prompt 最终下发格式 */
  promptFormat: 'danbooru' | 'anima-tags' | 'natural-language'
  /** 实验性标记（UI 展示 / 默认门控） */
  experimental: boolean
}


export interface ModelProfile {
  id?: string
  name?: string
  engine?: PromptEngine
  model_id?: string
  tag_style?: 'underscore' | 'space'
  lora_in_prompt?: boolean
  lora_id?: string
  lora_name?: string
  lora_strength?: number
  exact_tokens?: string[]
  exact_prefixes?: string[]
  match?: string[]
  quality_prefix?: string
  negative_prefix?: string
  negative_mode?: 'merge' | 'replace'
  negative_replace_scope?: 'boilerplate' | 'all'
  /** prompt: use authored rating tokens; do not derive positive or negative tags from scene metadata. */
  rating_mode?: 'scene' | 'prompt'
  rating_all?: string
  rating_r15?: string
  rating_r18?: string
  sampler?: string
  scheduler?: string
  steps?: number
  cfg?: number
  size?: string
  hires_fix?: boolean
  hires_steps?: number
  hires_scale?: number
  hires_upscaler?: string
  hires_denoising_strength?: number
  /** Profile 级能力覆盖（未声明时回退引擎默认能力表） */
  capabilities?: Partial<DrawCapabilities>
  [k: string]: unknown
}


export interface LoraMeta {
  name?: string
  strength?: { default?: number; min?: number; max?: number }
  recommended_weight?: { portrait?: number; fullbody?: number; complex_scene?: number }
  [k: string]: unknown
}
