export type AdultEligibility = 'adult' | 'unknown' | 'underage'

export interface PopularOutfit {
  id: string
  name: string
  prose: string
  tokens: string[]
  default?: boolean
}

export interface PopularCharacter {
  id: string
  displayName: string
  originalName: string
  franchise: string
  aliases: string[]
  identityProse: string
  identityTokens: string[]
  exactTokens: string[]
  exactPrefixes: string[]
  recommendedEngine: string
  supportedEngines: string[]
  adultEligibility: AdultEligibility
  outfits: PopularOutfit[]
  /** 角色专属官方原画师或精选推荐画师风格 ID 列表。 */
  curatedArtistStyles?: string[]
  /**
   * Character DNA 锁（2026-09-06 v2 升级落地）：三分类视觉基因契约。
   * must：角色不可丢失的核心特征（预留策展层，编译器不强制）；
   * flexible：允许随场景变化的元素（预留策展层）；
   * avoid：禁止作为常驻身份锚定的元素（编译器从 identity 标签流过滤，
   * 防止 C.C. 印记/花火面具/式和服类死绑回归；场景蓝图按需使用不受限）。
   */
  dnaLock?: { must: string[]; flexible: string[]; avoid: string[] }
}

export interface CharacterIdentity {
  role?: string
  age?: string
  occupation?: string
  faction?: string
}

export interface CharacterPortrait {
  image?: string
  alt?: string
}

export interface CharacterLora {
  name?: string
  trigger_words?: string[]
  recommended_scene?: string[]
}

export interface CharacterProfile {
  id: string
  name: string
  icon: string
  source: string
  alias: string[]
  /** heroine（站内角色，进角色空间）/ popular（热门出图角色，仅档案）。 */
  type?: string
  voice: string
  tags: string[]
  bg_story: string
  personality: string[]
  likes: string[]
  identity?: CharacterIdentity
  portrait?: CharacterPortrait
  lora?: CharacterLora
}

export interface CharacterScene {
  id: string
  title: string
  story: string
  char: string
}
