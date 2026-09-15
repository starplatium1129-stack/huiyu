export type PromptFamily = 'sd' | 'anima' | 'krea2'

export interface PromptSceneContext {
  title?: string
  category?: string
  tags?: string[]
  location?: string
  time?: string
  timeOfDay?: string
  weather?: string
  camera?: string
  lighting?: string
  emotion?: string
  rating?: string
  recommendedSize?: string
  usage?: string[]
  /** Optional one-sentence Anima caption for spatial or prop relationships. */
  animaCaption?: string
}

export interface PromptPlan {
  quality: string[]; rating: string[]; identity: string[]; exactControls: string[]
  /** 模型原生画师标签：WAI 原始 Danbooru tag / Anima @artist。 */
  artists: string[]
  preserveTokens: string[]
  sceneVisualFragments: string[]; emotion: string[]; camera: string[]; lighting: string[]
  composition: string[]; manual: string[]; negative: string[]; visualDescription: string
  /** Krea 风格配方前置短语（lead），渲染时放最前。 */
  style: string[]
  /** 后置媒介词（medium），渲染时放散文段末尾。 */
  medium: string
  /** 主体散文（自然语言渲染器原样织入，避免逗号切碎）。 */
  subjectProse: string
  /** 已选择服装的自然语言描述；热门角色不得被场景覆盖。 */
  outfitProse: string
  /** 环境散文（自然语言渲染器使用 blueprint.promptProse 原样织入）。 */
  sceneProse: string
  /** 工作室场景的结构化上下文，仅供 Krea 自然语言渲染。 */
  scene: PromptSceneContext | null
  /** Krea 的自然语言画师风格短语。 */
  artistProse: string
}
