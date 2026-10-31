// Shared scene contract: keep independent of frontend runtime modules.
export type BlueprintCompositionIntent = 'single' | 'group' | 'triptych'

export interface SceneBlueprint {
  generatedRecipe?: import('./generatedRecipe').GeneratedRecipe
  compositionIntent?: BlueprintCompositionIntent
  /** SFW scenes with an intentional mirror image or illusory echo. */
  allowRepeatedSubject?: boolean
  /** Explicit SFW timeline appearance; does not change the character ID. */
  identityTokensOverride?: string[]
  identityProseOverride?: string
  /** Names of additional people already present in this scene's tags; classification only. */
  characterTokens?: string[]
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
  /** Optional Anima-only supplement; an empty string explicitly omits the caption. */
  animaCaption?: string
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
   *  只决定缩略图模糊与分级徽章，不参与生成门禁。 */
  sampleRating?: string
  /** 可选：成人蓝图专属内容标签，按蓝图分级注入。 */
  nsfwTokens?: string[]
  /** 可选：成人蓝图专属内容散文（Krea 与 Anima caption 使用），按蓝图分级注入。 */
  nsfwProse?: string
  /** 可选：本场景应使用的角色服装 id（角色 outfits 之一）；缺省时用 defaultOutfit。 */
  outfitId?: string
  /** 可选：场景覆盖元数据：
   *  iconic=名场面 / daily=日常生活 / special_nsfw=特殊NSFW。
   *  不作为可选场景、衣装绑定的类别配额。 */
  coverageTags?: string[]
}
