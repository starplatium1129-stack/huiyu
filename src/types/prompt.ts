export type PromptFamily = 'sd' | 'anima' | 'krea2'

export interface PromptSceneContext {
  compositionIntent?: import('./sceneBlueprint').BlueprintCompositionIntent
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
  /** Authored Anima caption for the visible moment, atmosphere and spatial/prop relationships. */
  animaCaption?: string
  /** Explicit appearance variant for this scene; replaces the default identity anchors. */
  identityTokensOverride?: string[]
  identityProseOverride?: string
}

export interface PromptPlan {
  /** Free-subject inputs must not invent a woman, a solo count or an empty scene. */
  freeSubject?: boolean
  quality: string[]; rating: string[]; identity: string[]; exactControls: string[]
  /** Name/alias classification only; appearance and outfit tokens stay in ordinary tags. */
  characterTokens: string[]
  /** Separate work tags, emitted after character names for Anima. */
  copyrightTokens: string[]
  /** 模型原生画师标签：WAI 原始 Danbooru tag / Anima @artist。 */
  artists: string[]
  preserveTokens: string[]
  sceneVisualFragments: string[]; emotion: string[]; camera: string[]; lighting: string[]; palette: string[]
  /** Source lighting metadata distinguishes unchanged defaults from a director override. */
  authoredLighting?: string
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
  /** 工作室场景的显式正文、外貌变体与导演上下文。 */
  scene: PromptSceneContext | null
  /** Krea 的自然语言画师风格短语。 */
  artistProse: string
}
