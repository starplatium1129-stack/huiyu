// Shared scene contract: keep independent of frontend runtime modules.
export type BlueprintCompositionIntent = 'single' | 'group' | 'triptych'

export interface SceneBlueprint {
  compositionIntent?: BlueprintCompositionIntent
  id: string
  title: string
  category: string
  description: string
  /** 归属角色：全部蓝图必须携带（2026-08-15 通用蓝图已删除）。 */
  characterId?: string
  location: string
  action: string
  timeOfDay: string
  lighting: string
  camera: string
  mood: string
  sceneTags: string[]
  promptProse: string
  promptTokens: string[]
  negativeTokens: string[]
  recommendedSize: string
  adult: boolean
  /** 可选：Krea 2 风格配方 id 或自由风格短语（缺省按引擎取默认配方）。 */
  kreaStyleHint?: string
  /** 可选：Anima 风格配方 id 或自由风格短语。 */
  animaStyleHint?: string
  /** 可选：成人蓝图专属画师提示（如 @anmi, @kousaki 等）；双引擎自动映射。 */
  adultArtistHint?: string
  /** 可选：样张视觉定级（2026-08-15 用户裁定，R18/R15/All）。
   *  只决定样张展示（模糊/徽章），生成门禁仍由 adult 控制。 */
  sampleRating?: string
  /** 可选：成人蓝图专属 NSFW 内容标签；只在 adult 角色 + adultEnabled 同时放行时注入。 */
  nsfwTokens?: string[]
  /** 可选：成人蓝图专属 NSFW 内容散文（Krea 与 Anima caption 使用）；fail-closed 同标签。 */
  nsfwProse?: string
  /** 可选：本场景应使用的角色服装 id（角色 outfits 之一）；缺省时用 defaultOutfit。 */
  outfitId?: string
  /** 可选：验收覆盖标注（2026-08-23 场景库二次优化）：
   *  iconic=名场面 / daily=日常生活 / special_nsfw=特殊NSFW。
   *  契约测试保证每角色 ≥1 iconic + ≥1 daily，成人侧 ≥1 special_nsfw。 */
  coverageTags?: string[]
}
