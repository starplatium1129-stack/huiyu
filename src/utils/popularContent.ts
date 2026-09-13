// 热门角色无 LoRA 创作模式 —— 数据解析、资格门控与结构化输入构建。
// 纯 TS 无 DOM：数据经 sceneStore 单例加载后传入，本模块只做派生与门控。
// 命名遵循 src/utils/ 既有风格（promptPolicy / sceneInference）。

import type { SceneBlueprint } from '../types/sceneBlueprint'
export type { SceneBlueprint } from '../types/sceneBlueprint'

import { createPromptPlan, renderPromptPlan, type PromptPlan } from './promptCompiler.ts'
import {
  assembleNegative,
  isManualR18Tags,
  mutualGroupWithCategory,
  profileRatingTag,
  type ModelProfile,
} from './promptPolicy.ts'
import {
  isRecord,
  negativeStringList,
  requiredString,
  requiredStringList,
  stringList,
  stringValue,
} from './popularParseGuards.ts'
import type { ResolvedStyle } from '@/config/kreaStyleRecipes.ts'
import { normalizeProseKey } from './promptPhraseTables.ts'
import { inferBlueprintLighting, existingBlueprintDecisions } from './blueprintLighting.ts'
import { blueprintNegative, compositionTokens, parseCompositionIntent } from './blueprintComposition.ts'

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

export type DrawSubject =
  | { kind: 'studio' }
  | { kind: 'popular'; characterId: string; outfitId: string; blueprintId: string | null }

export interface PopularBlueprintDecision {
  shot: string | null
  lighting: string | null
  composition: string | null
  colorMood: string | null
  size: string
  /** 情绪摄影语法（v2）：按蓝图 mood 匹配的镜头语言（Anima 附加标签 + Krea 散文）。 */
  moodGrammar?: { tokens: string[]; prose: string }
}

// ── 严格解析 ───────────────────────────────────────────────────────────────
// 解析守卫已收敛至 ./popularParseGuards.ts（2026-09-05 单体拆分）。

function parseAdultEligibility(value: unknown): AdultEligibility {
  if (value === 'adult' || value === 'unknown' || value === 'underage') return value
  throw new Error('popular data: adultEligibility must be one of adult/unknown/underage')
}

function parseOutfit(value: unknown): PopularOutfit | null {
  if (!isRecord(value)) return null
  const id = requiredString(value, 'id')
  const tokens = stringList(value.tokens)
  if (!tokens.length) throw new Error(`popular data: outfit ${id} requires tokens`)
  return {
    id,
    name: requiredString(value, 'name'),
    prose: requiredString(value, 'prose'),
    tokens,
    default: value.default === true,
  }
}

export function parsePopularCharacter(value: unknown): PopularCharacter | null {
  if (!isRecord(value)) return null
  const id = requiredString(value, 'id')
  const identityTokens = requiredStringList(value, 'identityTokens')
  const exactTokens = stringList(value.exactTokens)
  const exactPrefixes = stringList(value.exactPrefixes)
  const outfits = (Array.isArray(value.outfits) ? value.outfits : [])
    .map(parseOutfit)
    .filter((outfit): outfit is PopularOutfit => outfit !== null)
  if (!outfits.length) throw new Error(`popular data: ${id} requires at least one outfit`)
  const adultEligibility = parseAdultEligibility(value.adultEligibility)
  // Character DNA 锁（可选策展层）：must/flexible/avoid 三分类，缺省为空契约。
  const dnaRaw = isRecord(value.dnaLock) ? value.dnaLock : null
  const dnaLock = dnaRaw
    ? { must: stringList(dnaRaw.must), flexible: stringList(dnaRaw.flexible), avoid: stringList(dnaRaw.avoid) }
    : undefined
  return {
    id,
    displayName: requiredString(value, 'displayName'),
    originalName: requiredString(value, 'originalName'),
    franchise: requiredString(value, 'franchise'),
    aliases: stringList(value.aliases),
    identityProse: requiredString(value, 'identityProse'),
    identityTokens,
    exactTokens,
    exactPrefixes,
    recommendedEngine: requiredString(value, 'recommendedEngine'),
    supportedEngines: stringList(value.supportedEngines),
    adultEligibility,
    outfits,
    curatedArtistStyles: stringList(value.curatedArtistStyles),
    dnaLock,
  }
}

/**
 * 逐条解析并隔离坏数据：单条字段缺失/非法只跳过该条并告警，不再让整份
 * 角色/蓝图解析整体抛错（2026-08-16 审计：fail-hard 会因一条录入错误
 * 丢掉全部数据）。重复 id 等跨条目完整性检查仍由调用方保留（真数据 bug 必须报错）。
 */
function parsePopularList<T>(source: unknown[], parseOne: (item: unknown) => T | null, label: string): T[] {
  const list: T[] = []
  for (const item of source) {
    try {
      const parsed = parseOne(item)
      if (parsed !== null) list.push(parsed)
    } catch (error) {
      console.warn(`[popular-data] 跳过无效${label}条目：`, error instanceof Error ? error.message : String(error))
    }
  }
  return list
}

export function parsePopularCharacters(value: unknown): PopularCharacter[] {
  const source = isRecord(value) && Array.isArray(value.characters)
    ? value.characters
    : Array.isArray(value) ? value : []
  const list = parsePopularList(source, parsePopularCharacter, '角色')
  const seen = new Set<string>()
  for (const character of list) {
    if (seen.has(character.id)) throw new Error(`popular data: duplicated character id ${character.id}`)
    seen.add(character.id)
    const outfitIds = new Set<string>()
    for (const outfit of character.outfits) {
      if (outfitIds.has(outfit.id)) throw new Error(`popular data: ${character.id} has duplicated outfit id ${outfit.id}`)
      outfitIds.add(outfit.id)
    }
  }
  return list
}

export function parseSceneBlueprint(value: unknown): SceneBlueprint | null {
  if (!isRecord(value)) return null
  const id = requiredString(value, 'id')
  return {
    id,
    title: requiredString(value, 'title'),
    category: requiredString(value, 'category'),
    description: requiredString(value, 'description'),
    characterId: stringValue(value.characterId) || undefined,
    location: requiredString(value, 'location'),
    action: requiredString(value, 'action'),
    timeOfDay: requiredString(value, 'timeOfDay'),
    lighting: requiredString(value, 'lighting'),
    camera: requiredString(value, 'camera'),
    mood: requiredString(value, 'mood'),
    sceneTags: stringList(value.sceneTags),
    promptProse: requiredString(value, 'promptProse'),
    promptTokens: requiredStringList(value, 'promptTokens'),
    negativeTokens: negativeStringList(value.negativeTokens),
    recommendedSize: requiredString(value, 'recommendedSize'),
    adult: value.adult === true,
    compositionIntent: parseCompositionIntent(value.compositionIntent),
    kreaStyleHint: stringValue(value.kreaStyleHint),
    animaStyleHint: stringValue(value.animaStyleHint),
    adultArtistHint: stringValue(value.adultArtistHint),
    sampleRating: stringValue(value.sampleRating),
    // 2026-08-16 审计：nsfwTokens 与 negativeTokens 同属「标签清单」字段，此前用
    // stringList（字符串→[] 静默丢词），与 negativeStringList 不一致；统一走
    // negativeStringList，历史「逗号串」形态不再丢词。
    nsfwTokens: negativeStringList(value.nsfwTokens),
    nsfwProse: stringValue(value.nsfwProse),
    outfitId: stringValue(value.outfitId),
    // 2026-08-23 场景库二次优化：验收覆盖标注（iconic/daily/special_nsfw）。
    coverageTags: stringList(value.coverageTags),
  }
}

export function parseSceneBlueprints(value: unknown): SceneBlueprint[] {
  const source = isRecord(value) && Array.isArray(value.blueprints)
    ? value.blueprints
    : Array.isArray(value) ? value : []
  const list = parsePopularList(source, parseSceneBlueprint, '场景蓝图')
  const seen = new Set<string>()
  for (const blueprint of list) {
    if (seen.has(blueprint.id)) throw new Error(`blueprints: duplicated blueprint id ${blueprint.id}`)
    seen.add(blueprint.id)
  }
  return list
}

// ── 查询 ──────────────────────────────────────────────────────────────────

export function findCharacter(characters: PopularCharacter[], id: string): PopularCharacter | null {
  return characters.find(character => character.id === id) ?? null
}

export function findOutfit(character: PopularCharacter, outfitId: string): PopularOutfit | null {
  return character.outfits.find(outfit => outfit.id === outfitId) ?? null
}

export function defaultOutfit(character: PopularCharacter): PopularOutfit {
  return character.outfits.find(outfit => outfit.default) ?? character.outfits[0]
}

export function findBlueprint(blueprints: SceneBlueprint[], id: string): SceneBlueprint | null {
  return blueprints.find(blueprint => blueprint.id === id) ?? null
}

// ── 成人资格门控（fail closed） ────────────────────────────────────────────

/** 蓝图是否对指定角色可见：成人蓝图只能被 adult 角色 + 成熟内容开关同时放行。 */
export function blueprintEligible(
  blueprint: SceneBlueprint,
  character: PopularCharacter | null,
  opts: { adultEnabled?: boolean } = {},
): boolean {
  if (!blueprint.adult) return true
  if (opts.adultEnabled !== true) return false
  return character?.adultEligibility === 'adult'
}

export function eligibleBlueprints(
  blueprints: SceneBlueprint[],
  character: PopularCharacter | null,
  opts: { adultEnabled?: boolean; category?: string } = {},
): SceneBlueprint[] {
  return blueprints.filter(blueprint =>
    blueprintEligible(blueprint, character, opts)
    && (character == null || blueprint.characterId === character.id)
    && (!opts.category || opts.category === 'all' || blueprint.category === opts.category),
  )
}

export function blueprintCategories(blueprints: SceneBlueprint[]): string[] {
  return [...new Set(blueprints.map(blueprint => blueprint.category))].sort((a, b) => a.localeCompare(b, 'zh'))
}

// ── 确定性轮换 ─────────────────────────────────────────────────────────────

export { recommendBlueprints } from './blueprintRecommendations.ts'

// ── 蓝图 → 导演决策推断 ────────────────────────────────────────────────────

const CAMERA_TO_SHOT: Record<string, string> = {
  closeup: 'close', 'close-up': 'close', close_up: 'close', close: 'close',
  'medium shot': 'medium', half_body: 'medium', medium: 'medium',
  'cowboy shot': 'medium', cowboy_shot: 'medium', cowboy: 'medium',
  'wide shot': 'wide', wide_shot: 'wide', full_body: 'wide', wide: 'wide',
  pov: 'pov', 'high angle': 'high', from_above: 'high', 'low angle': 'low',
  from_below: 'low', 'side view': 'side', looking_back: 'turn',
}
/** 蓝图 camera 字段漏网短语补映射（2026-08-24 全量审计：23 例 shot=null）。 */
const EXTRA_CAMERA_TO_SHOT: ReadonlyArray<readonly [RegExp, string]> = [
  [/cowboy (?:shot)?|cowboy_shot/, 'medium'],
  [/dynamic action (?:shot|angle)|action shot/, 'wide'],
  [/full body/, 'wide'],
  [/couch level|low level/, 'low'],
  [/three quarter/, 'medium'],
  [/upper body/, 'medium'],
  [/intimate (?:dramatic )?angle|dramatic intimate angle/, 'medium'],
  // back_view/back shot：ShotId 枚举无「背面」槽位，取中景为中性框架，
  // 背面视角语义由蓝图 promptProse 自由文本兜底。
  [/back[_ ](?:view|shot)/, 'medium'],
  [/front[_ ]view/, 'medium'],
]
/**
 * 角度词优先预扫：低/高机位是比取景景别更罕见的作者意图信号。
 * 2026-08-24 审计：matchFirst 按子串长度取胜，`cinematic low angle medium shot`
 * 命中更长的 `medium shot`，把刻意低机位覆盖成平拍（≥10 例）。角度词先于
 * 取景表裁决；`medium shot, slight low angle` 这类双写以机位为准（取景信息
 * 通常仍由 promptProse 自由文本兜底）。
 */
const BLUEPRINT_ANGLE_RE: ReadonlyArray<readonly [RegExp, string]> = [
  [/low angle|from below/, 'low'],
  [/high angle|from above|overhead/, 'high'],
  [/\bpov\b|first-person|first person|主观/, 'pov'],
]

function blueprintAngleShot(cameraText: string): string | null {
  const text = String(cameraText || '').toLowerCase()
  if (!text) return null
  return BLUEPRINT_ANGLE_RE.find(([pattern]) => pattern.test(text))?.[1] ?? null
}
const MOOD_TO_COLOR: Record<string, string> = {
  warm: 'warmth', cozy: 'warmth', tender: 'warmth',
  calm: 'calm', serene: 'calm', quiet: 'calm', tranquil: 'calm',
  nostalgic: 'calm', wistful: 'calm',
  mystical: 'tension', mysterious: 'tension', melancholic: 'sad', sad: 'sad',
  lively: 'joy', hopeful: 'joy', lighthearted: 'joy',
}

/**
 * 情绪摄影语法（2026-09-06 v2 升级）：蓝图 mood → 镜头语言的确定性映射。
 * 只在蓝图 camera/lighting 未给出更强信号时作为**附加**镜头语言注入，
 * 不覆盖已解析的 shot/lighting 决策（sc280 旗帜构图契约不受影响）。
 * tokens 必须是 Danbooru 真实标签；prose 供 Krea 自然语言流拼接。
 */
const MOOD_CAMERA_GRAMMAR: ReadonlyArray<readonly [RegExp, { tokens: string[]; prose: string }]> = [
  [/温柔|治愈|暖|甜|tender|warm|healing|cozy/i,
    { tokens: ['soft_focus', 'blurred_background'],
      prose: 'Shot with an 85mm lens at shallow depth of field, a soft warm glow wrapping the subject.' }],
  [/孤独|寂|落寞|怅|lonely|solitary|melancho/i,
    { tokens: ['negative_space', 'scenery'],
      prose: 'Generous negative space and compressed distance emphasize her quiet solitude.' }],
  [/压迫|威压|凛|傲|凌厉|oppressive|domin|intimidat/i,
    { tokens: ['foreshortening', 'dutch_angle'],
      prose: 'A low aggressive angle with strong foreshortening bears down on the viewer.' }],
  [/神秘|幻|梦|妖|myst|dream|etherea/i,
    { tokens: ['lens_flare', 'light_particles'],
      prose: 'Ethereal lens flares and drifting light particles veil the scene in mystery.' }],
]

function matchMoodGrammar(mood: string): { tokens: string[]; prose: string } | undefined {
  const text = String(mood || '')
  if (!text) return undefined
  return MOOD_CAMERA_GRAMMAR.find(([pattern]) => pattern.test(text))?.[1]
}

function matchFirst(text: string, table: Record<string, string>): string | null {
  const lower = text.toLowerCase()
  const keys = Object.keys(table).sort((a, b) => b.length - a.length)
  for (const key of keys) {
    if (lower.includes(key)) return table[key]
  }
  return null
}

export function inferBlueprintDecisions(blueprint: SceneBlueprint | null): PopularBlueprintDecision {
  if (!blueprint) return { shot: null, lighting: null, composition: 'rule3', colorMood: null, size: '832x1216' }
  const hay = [blueprint.camera, blueprint.lighting, blueprint.mood, blueprint.promptProse, blueprint.sceneTags.join(', ')].join(' ').toLowerCase()
  const angleShot = blueprintAngleShot(blueprint.camera)
  const cameraText = String(blueprint.camera || '').toLowerCase()
  const prior = blueprint.adult ? existingBlueprintDecisions(blueprint) : null
  const shot = prior ? prior.shot : angleShot ?? matchFirst(cameraText, CAMERA_TO_SHOT)
    ?? EXTRA_CAMERA_TO_SHOT.find(([pattern]) => pattern.test(cameraText))?.[1]
    ?? matchFirst(hay, CAMERA_TO_SHOT)
  const lighting = prior ? prior.lighting : inferBlueprintLighting(blueprint)
  const colorMood = matchFirst(hay, MOOD_TO_COLOR)
  const moodGrammar = matchMoodGrammar(blueprint.mood)
  return {
    shot,
    lighting,
    composition: 'rule3',
    colorMood,
    size: blueprint.recommendedSize || '832x1216',
    moodGrammar,
  }
}

// ── Prompt 组装（唯一渲染层 = createPromptPlan + renderPromptPlan） ─────────

export interface PopularPromptOptions {
  character: PopularCharacter
  outfit: PopularOutfit
  blueprint: SceneBlueprint | null
  engine: 'anima' | 'krea2'
  profile?: ModelProfile | null
  manual?: string[]
  emotion?: string[]
  shot?: string | null
  lighting?: string | null
  composition?: string | null
  adultEnabled?: boolean
  /** 用户补充的画面描述；只追加，不得替换角色服装。 */
  visualDescription?: string
  /** Krea 风格配方（已按资格解析）；成人配方在此再 fail-closed 一次。 */
  style?: ResolvedStyle | null
  artistTags?: string[]
  artistProse?: string
  /**
   * 反推顶替的服装词条（2026-08-29）。非空时**整体替换** outfit.tokens 与
   * outfit.prose —— 只换 tag 不换散文是无效的：那句 "She wears 校服..." 仍在，
   * 参考图的泳装压不过（实测主因）。可一键清空恢复角色默认服装。
   */
  outfitOverride?: ReadonlyArray<string> | null
  /**
   * 服装是否由用户**显式**选择（非回退到默认）（2026-08-29）。
   *
   * 基础提示词对标 studio（宁宁/夏目）：它们无场景时 `characterControlTokens`
   * 返回空，只留人物基本特征。故 popular 在无蓝图且服装仍是默认时**不注入服装**，
   * 让反推词条与手动词条自由生效；用户主动挑了某套服装才注入。
   */
  outfitExplicit?: boolean
  /** 词条池 Mature 分类键集（tags.json cat==='Mature'，调用方派生）。
   *  manual 命中 Mature 词条时评级联动升 R18（与 studio isManualR18Tags 同一契约，
   *  2026-08-29 随机灵感开放热门角色引入：否则抽中 Mature 词仍被负面压制）。 */
  matureTokens?: ReadonlySet<string>
}

export interface PopularPromptResult {
  plan: PromptPlan
  prompt: string
  negative: string
  adult: boolean
}

const SHOT_TOKENS: Record<string, string> = {
  close: 'close-up', medium: 'medium shot', wide: 'wide shot',
  pov: 'pov', low: 'low angle', high: 'high angle', side: 'side view',
  turn: 'looking back', over: 'selfie', detail: 'extreme close-up',
}
const LIGHTING_TOKENS: Record<string, string> = {
  golden: 'golden_hour', window: 'window_light', back: 'backlighting',
  moon: 'moonlight', lantern: 'lantern', overcast: 'overcast',
}
/**
 * 氛围词强化（壁纸级第一）：每种光线决策除主光照 token 外追加一组通透感
 * 标签——逆光/轮廓光/体积光/景深是参考图（sc300 标杆）与平庸平涂的最大分水岭。
 */
const AMBIENCE_TOKENS: Record<string, string[]> = {
  golden: ['golden_hour', 'backlight', 'rim_light', 'volumetric_lighting', 'deep_depth_of_field', 'warm_lighting'],
  back: ['backlighting', 'rim_light', 'volumetric_lighting', 'silhouette', 'deep_depth_of_field'],
  window: ['window_light', 'soft_lighting', 'sunlight', 'volumetric_lighting', 'shadows'],
  moon: ['moonlight', 'night', 'cool_lighting', 'stars', 'deep_depth_of_field'],
  lantern: ['lantern', 'candlelight', 'warm_lighting', 'volumetric_lighting', 'shadows'],
  overcast: ['overcast', 'soft_diffused_light', 'cloudy', 'hazy'],
}
const COMPOSITION_TOKENS: Record<string, string> = {
  center: 'centered_composition', rule3: 'rule_of_thirds',
  left: 'off-center composition', right: 'off-center composition',
  foreground: 'blurry foreground', frame: 'framed', bywindow: 'by_window',
}

const NENE_NATSUME_POLLUTION = /(?:ayachi_nene|shiki_natsume|nene_r18|natsume_r18)/i
const NENE_NATSUME_PREFIX = /^(?:nene_|natsume_)[a-z0-9_]+$/i

/** 专家模式手动词条净化：热门角色场景不得出现宁宁/夏目 LoRA 控制词。 */
export function sanitizePopularManual(tags: string[]): string[] {
  return tags.filter(tag => !NENE_NATSUME_POLLUTION.test(tag) && !NENE_NATSUME_PREFIX.test(tag))
}

const STUDIO_NAME_RE = /(?:ayachi_nene|shiki_natsume)/i
const STUDIO_PREFIX_RE = /(?:^|[^a-z0-9_])(?:nene|natsume)_[a-z0-9_]+/i

/** 扫描一段文本是否泄漏宁宁/夏目 LoRA 锚点；返回泄漏描述，无则空数组。 */
export function scanStudioTokenLeaks(text: string): string[] {
  const leaks: string[] = []
  if (STUDIO_NAME_RE.test(text)) leaks.push('studio character name')
  if (STUDIO_PREFIX_RE.test(text)) leaks.push('studio control prefix')
  return leaks
}

/**
 * 人物/服装层禁携环境词（2026-08-29 干净人物提示词契约）：地点、季节、时段
 * 属于场景蓝图职责域。曾实测泄漏：5 个泳装带 summer、mika/hina 带 beach、
 * 防寒服带 snow、针织带 autumn——人物提示词与场景叠加（含反推叠加）时这些
 * 词会与蓝图词条打架。tea_party（套装语义）不在此列。
 */
const ENVIRONMENT_TOKENS = new Set([
  'beach', 'summer', 'winter', 'autumn', 'ocean', 'sea', 'underwater',
  'swimming_pool', 'poolside', 'indoors', 'outdoors', 'nightlife',
  'classroom', 'library', 'bedroom', 'festival',
])

/** 扫描词条数组中的环境词泄漏（identityTokens / outfit tokens 通用）。 */
function scanEnvironmentLeaks(tokens: ReadonlyArray<string>): string[] {
  return tokens.filter(token => ENVIRONMENT_TOKENS.has(String(token || '').toLowerCase()))
}

/**
 * 角色数据全字段污染扫描：identityTokens/exactTokens/identityProse/aliases/
 * exactPrefixes 以及每个 outfit 的 prose+tokens，统一在此判定，供内容契约
 * 校验与单测共用，避免两处各自维护一套正则漂移。
 * 2026-08-29 扩展：identityTokens 与 outfit tokens 额外扫环境词（地点/季节/
 * 时段），守住「干净人物提示词」——不选场景时角色词条不得自带环境。
 */
export function scanCharacterPollution(character: PopularCharacter): string[] {
  const leaks: string[] = []
  const textSources: Array<[string, string]> = [
    ['identityProse', character.identityProse],
    ['aliases', character.aliases.join(', ')],
    ['exactPrefixes', character.exactPrefixes.join(', ')],
    ['identityTokens', character.identityTokens.join(', ')],
    ['exactTokens', character.exactTokens.join(', ')],
  ]
  for (const [field, text] of textSources) {
    scanStudioTokenLeaks(text).forEach(leak => leaks.push(`${character.id}.${field}: ${leak}`))
  }
  scanEnvironmentLeaks(character.identityTokens).forEach(token => {
    leaks.push(`${character.id}.identityTokens: environment token "${token}"`)
  })
  character.outfits.forEach(outfit => {
    scanStudioTokenLeaks(`${outfit.prose} ${outfit.tokens.join(' ')}`).forEach(leak => {
      leaks.push(`${character.id}.outfit.${outfit.id}: ${leak}`)
    })
    scanEnvironmentLeaks(outfit.tokens).forEach(token => {
      leaks.push(`${character.id}.outfit.${outfit.id}: environment token "${token}"`)
    })
  })
  return leaks
}

function identityWithoutOutfit(prose: string): string {
  // 剥离句尾的服装描述（", wearing X." / ", dressed in X."），供 Krea 自然语言路径使用。
  return prose
    .replace(/,\s*(?:wearing|dressed in)\b[^.]*\.?$/i, '.')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 成人蓝图必须把「成年版本」落实到最终提示词，而不能只依赖 UI 门禁字段。
 * 角色库仍需保留原作身份供 SFW 使用，因此仅在 adultGranted 分支转换容易把
 * 模型拉回学生/少女形态的称谓，并在 Krea/Anima caption 中加入明确年龄锚点。
 */
function adultIdentityProse(prose: string): string {
  const identity = identityWithoutOutfit(prose)
    .replace(/\b(?:young\s+)?girl\b/gi, 'adult woman')
    .replace(/\bschoolgirl\b/gi, 'adult woman')
    .replace(/\b(?:middle|junior high|high)[- ]school student\b/gi, 'adult alumna')
    .replace(/\bstudent\b/gi, 'adult alumna')
    .replace(/\bteen(?:age|aged)?\b/gi, 'adult')
  return `The unmistakably adult, age-twenty-plus version of ${identity}`
}

const ADULT_IDENTITY_EXCLUDE_RE =
  /^(?:child|children|loli|underage|minor|young_girl|schoolgirl|student|teenager|middle_school_student|junior_high_student|high_school_student)$/

/** 渲染模板自带动词（Krea "wearing X" / Anima "She wears X"），服装 prose 若
 *  自带 "wearing/dressed in" 开头必须剥除，否则编译出 "wearing wearing"。
 *  2026-08-24 实测：8 角色 37 套服装踩坑（yor/reze/fern/jalter/sakura/yui/sylphiette/mimori/cecilia）。 */
function outfitProseForRender(prose: string): string {
  return String(prose || '').replace(/^(?:wearing|dressed in)\s+/i, '').trim()
}

/**
 * 反推顶替服装时的服装描述：把 tag 还原成可渲染的自然语言（下划线转空格）。
 * 渲染模板自带动词（Anima "She wears X" / Krea "wearing X"），这里只给名词短语。
 */
function outfitOverrideProse(tokens: ReadonlyArray<string>): string {
  return tokens.map(token => String(token || '').replace(/_/g, ' ').trim()).filter(Boolean).join(', ')
}

/**
 * 剥离身份散文里的服装描写（2026-08-29）。
 *
 * 既有的 `identityWithoutOutfit` 只剥**句尾** ", wearing X."；但 48 个角色里有 17 个
 * 的服装描写在**句中**（"…emerald eyes, wearing a white lab coat over…"），剥不掉。
 * 不选场景时，这段描写等于硬塞一套衣服给用户，挤掉自主添加词条的空间（对标
 * studio：宁宁/夏目不选场景时没有任何服装注入，服装由场景或用户自己给）。
 * 实测 17 个命中角色里 16 个剥得干净，仅 kyouyama_kazusa 的 "and black tights"
 * 属并列结构残留（影响小，不再加规则以免误伤）。
 */
/**
 * 明确的衣物类词（2026-08-29）。
 *
 * `OUTFIT_FAMILIES` 只覆盖 6 个高频互斥族（校服/泳装/和服…），但角色数据里实际
 * 混着大量普通衣物词（green_clothes / coat / dress / boots），互斥族判定管不到。
 * 这里补一张「只要出现就一定是衣服」的名单，仅在**不选场景**时用于过滤身份词。
 * 刻意**不含**发饰（hair_ribbon）、发型（short_hair）、职业（maid）、饰品
 * （earring / crown）——那些是身份特征，去掉会让角色变样。
 */
const GARMENT_TOKEN_RE =
  /^(?:[a-z0-9]+_)*(?:clothes|clothing|outfit|costume|coat|overcoat|trench_coat|jacket|dress|sundress|skirt|miniskirt|shirt|blouse|pants|trousers|jeans|shorts|hotpants|crop_top|tank_top|bodysuit|leotard|corset|bra|panties|underwear|boots|shoes|heels|sneakers|sandals|socks|tights|pantyhose|stockings|leggings|thighhighs|thigh_highs|over_knee_socks|knee_socks|uniform|serafuku|suit|robe|cloak|cape|capelet|hoodie|sweater|cardigan|vest|apron|kimono|yukata|qipao|cheongsam|swimsuit|swimwear|bikini|pajamas|sleepwear|nightgown|lingerie|gloves|scarf|necktie|belt|hat|helmet|armor|footwear|headdress)$/

function isGarmentToken(token: string): boolean {
  return GARMENT_TOKEN_RE.test(String(token || '').trim().toLowerCase())
}

function proseWithoutOutfit(prose: string): string {
  let out = String(prose || '')
  // ", wearing X …" / ", dressed in X …" 从句（句中、句尾皆可），删到句号或分号前
  out = out.replace(/,\s*(?:wearing|dressed in)\b[^.;]*/gi, '')
  out = out.replace(/;\s*(?:wearing|dressed in)\b[^.;]*/gi, '')
  // 清理：悬空逗号、标点前空白、重复空格、以连接词收尾
  out = out.replace(/,\s*(?=[,.;])/g, '')
  out = out.replace(/[,\s]+(?=[.;])/g, '')
  out = out.replace(/\s+/g, ' ')
  out = out.replace(/\b(?:with|and|over|in)\s*\.\s*$/i, '.')
  return out.trim()
}

export function buildPopularPromptPlan(options: PopularPromptOptions): PopularPromptResult | null {
  const { character, outfit, blueprint, engine } = options
  const profile = options.profile ?? null
  const adult = Boolean(blueprint?.adult)
  const adultGranted = adult && character.adultEligibility === 'adult' && options.adultEnabled === true
  // 成人蓝图 fail closed：资格不满足直接拒绝构建，不让任何显式词进入 Prompt。
  if (adult && !adultGranted) return null

  const manual = sanitizePopularManual(options.manual || [])
  // 反推顶替的服装（非空即整体替换 outfit.tokens 与 outfit.prose）
  const overridden = options.outfitOverride?.length ? [...options.outfitOverride] : null
  // 服装是否参与注入（2026-08-29 基础提示词瘦身，对标 studio 的「场景驱动」）：
  //   1) 反推顶替 → 一定注入（参考图服装必须出来）
  //   2) 有蓝图/场景 → 注入（用户已选中某个具体场面）
  //   3) 用户显式挑了某套服装 → 注入（尊重明确选择）
  //   4) 否则（无场景 + 仍是默认服装）→ 不注入，只留人物基本特征
  const outfitActive = Boolean(overridden) || Boolean(blueprint) || options.outfitExplicit === true
  // 手动 Mature 词条评级联动（单一契约 isManualR18Tags）：命中即升 R18 解除负面
  // 压制，但仅对成年角色生效（underage 资格仍 fail-closed，数据层契约不动）。
  const manualR18 = character.adultEligibility === 'adult'
    && isManualR18Tags(manual, options.matureTokens)
  const ratingLevel = (adultGranted || manualR18) ? 'R18' : 'ALL'
  const shotToken = options.shot ? SHOT_TOKENS[options.shot] : ''
  const lightingKey = options.lighting ?? ''
  const lightingToken = lightingKey ? LIGHTING_TOKENS[lightingKey] : ''
  const lightingTokens = lightingKey
    ? [...new Set([lightingToken, ...(AMBIENCE_TOKENS[lightingKey] || [])])].filter(Boolean)
    : []
  const compositionToken = options.composition ? COMPOSITION_TOKENS[options.composition] : ''
  // 情绪摄影语法（v2）：蓝图 mood → 附加镜头语言；不覆盖显式 shot/lighting 决策。
  const moodGrammar = blueprint ? inferBlueprintDecisions(blueprint).moodGrammar : undefined
  const moodGrammarTokens = moodGrammar?.tokens ?? []
  // Character DNA 锁 avoid（v2）：从常驻身份锚定流过滤易失真元素（如 C.C. 印记、
  // 花火面具、式和服类死绑回归）。只过滤 identity 标签流；场景蓝图按需使用不受限。
  const dnaAvoid = new Set((character.dnaLock?.avoid || []).map(key => normalizeProseKey(key)))
  // 成人配方与成人蓝图同一把 fail-closed 锁：资格不满足绝不进入渲染层。
  const style = options.style
  if (style?.adult && !adultGranted) return null

  // 用户描述是额外画面指令，服装由独立字段稳定保留。
  const userVisual = String(options.visualDescription || '').trim()
  // 成人内容只在 fail-closed 放行时注入：Anima 标签进 controls，散文拼接场景。
  const nsfwTokens = adultGranted ? (blueprint?.nsfwTokens || []) : []
  const nsfwProse = adultGranted ? String(blueprint?.nsfwProse || '').trim() : ''
  const sceneProse = [
    // 成人场景：裸体叙述前置，避免被服装散文压过（Krea 2 自然语言模型对句首描述权重最高）。
    ...(nsfwProse ? [nsfwProse] : []),
    blueprint?.promptProse,
    // 情绪摄影语法（v2）：Krea 自然语言流以一句镜头语言收尾。
    ...(moodGrammar ? [moodGrammar.prose] : []),
  ].filter(Boolean).join(' ')

  const emotionTokens = options.emotion || []

  if (engine === 'krea2') {
    // 成人蓝图：outfitProse 置空（Krea 模板会拼成 "subject, wearing {outfitProse}"，
    // 穿衣服描述会压过显式词导致拒绝出裸）；脱衣叙述由 nsfwProse 前置承载。
    // 反推顶替：Krea 只有散文流，必须换成参考图服装，否则 "wearing 校服..." 压制参考图。
    const outfitProse = (adultGranted || !outfitActive)
      ? ''
      : (overridden ? outfitOverrideProse(overridden) : outfitProseForRender(outfit.prose))
    // Krea 是自然语言模型：手动画师散文由 artistStyleProse 负责还原空格/去括号
    // 注释（如 @hiten (hitenkei) → hiten），这里直接透传用户手动选择。
    // 2026-08-29 需求变更：热门角色画师默认不注入（保持角色原滋原味）。
    // 蓝图 adultArtistHint 不再作为无手动画师时的自动回退——画师完全由用户
    // 手动选择（artistProse/artistTags），未选即不带画师。
    const effectiveArtistProse = options.artistProse
    // 2026-08-24 审计修复：Krea 分支此前硬编码 camera/lighting 为空数组，
    // 导演面板与蓝图推断的镜头/光照决策在 Krea 上被整体丢弃（438 蓝图实测
    // 仅剩 rule_of_thirds 一句构图）。经 promptCompiler 的 cameraPhrase/
    // lightPhrase 散文转换器织入；光照只取主词 + 前 2 个氛围词，并剔除
    // 2026-08-30 调研放宽：只丢 night（"lit by moonlight and night" 重复不成立），
    // 保留 stars（"lit by moonlight and stars" 自然，夜景氛围更足，Krea2 官方
    // "name the lighting" 指南）；氛围词从 2 个放宽到 4 个，光照描述更丰富。
    const KREA_PROSE_LIGHT_DROP = /^(?:night)$/
    const kreaLightingTokens = lightingKey
      ? [...new Set([lightingToken,
        ...(AMBIENCE_TOKENS[lightingKey] || []).filter(token => token && !KREA_PROSE_LIGHT_DROP.test(token)).slice(0, 4)])]
      : []
    const plan = createPromptPlan({
      subjectProse: adultGranted
        ? adultIdentityProse(character.identityProse)
        : (outfitActive
            ? identityWithoutOutfit(character.identityProse)
            : proseWithoutOutfit(character.identityProse)),
      outfitProse,
      sceneProse,
      emotion: emotionTokens,
      camera: shotToken ? [shotToken] : [],
      lighting: kreaLightingTokens,
      composition: compositionToken ? [compositionToken] : [],
      manual,
      negative: '',
      visualDescription: userVisual,
      style: style ? [style.lead] : [],
      medium: style?.medium ?? '',
      artistProse: effectiveArtistProse,
    })
    const rendered = renderPromptPlan(plan, 'krea2', profile)
    return { plan, prompt: rendered.prompt, negative: '', adult }
  }

  // 不选场景时，身份词里混入的服装一并去掉（数据遗留：不少角色把 pleated_skirt /
  // qipao / green_clothes / coat 等写进了 identityTokens，而它是无条件注入的，
  // 不过滤则瘦身对它们无效）。双保险：互斥族判定 + 普通衣物名单。
  const identityTokens = (outfitActive
    ? character.identityTokens
    : character.identityTokens.filter(token =>
        mutualGroupWithCategory(token)?.category !== 'outfit' && !isGarmentToken(token)))
    .filter(token => !dnaAvoid.has(normalizeProseKey(token)))
    .filter(token => !adultGranted || (!isGarmentToken(token)
      && !ADULT_IDENTITY_EXCLUDE_RE.test(String(token || '').trim().toLowerCase())))
  const exactControls = [...new Set([
    ...((adultGranted || !outfitActive) ? [] : (overridden ?? outfit.tokens)),
    ...(character.exactTokens || []),
    ...(adultGranted ? ['adult'] : []),
    ...nsfwTokens,
  ])]
  // 2026-08-29 需求变更：画师仅来自用户手动选择（artistTags），
  // 蓝图 adultArtistHint 不再自动兜底注入（保持角色原滋原味）。
  const effectiveArtists = (options.artistTags && options.artistTags.length) ? options.artistTags : undefined
  const rating = profileRatingTag(profile, { rating: ratingLevel })
  const plan = createPromptPlan({
    profile,
    identity: compositionTokens(identityTokens, blueprint).join(', '),
    controls: compositionTokens(exactControls, blueprint),
    artists: effectiveArtists,
    exactTokens: compositionTokens(character.exactTokens || [], blueprint),
    scenePrompt: compositionTokens(blueprint?.promptTokens || [], blueprint).join(', '),
    emotion: emotionTokens,
    camera: shotToken ? [shotToken] : [],
    lighting: [...lightingTokens, ...moodGrammarTokens].length ? [...new Set([...lightingTokens, ...moodGrammarTokens])] : [],
    composition: compositionToken ? [compositionToken] : [],
    manual,
    negative: (blueprint?.negativeTokens || []).join(', '),
    rating: rating || (ratingLevel === 'R18' ? 'nsfw' : ''),
    visualDescription: userVisual,
    subjectProse: adultGranted
      ? adultIdentityProse(character.identityProse)
      : (outfitActive
          ? identityWithoutOutfit(character.identityProse)
          : proseWithoutOutfit(character.identityProse)),
    // 2026-08-16 审计：Anima 成人路径此前漏置空 outfitProse（Krea 分支已置空）。
    // renderPromptPlan('anima') 会在 outfitProse 存在时渲染 "She wears {outfit}",
    // 服装词会与成人 nsfwProse 的裸体词打架、压过显式词。与 Krea 三铁律「outfitProse 置空」对齐。
    // 2026-08-29：反推顶替同理——那句 "She wears 校服..." 是热门角色还原不了参考图
    // 服装的主因，必须连同 controls 一起换成参考图服装。
    outfitProse: (adultGranted || !outfitActive)
      ? ''
      : (overridden ? outfitOverrideProse(overridden) : outfitProseForRender(outfit.prose)),
    sceneProse,
    // Anima 只接收模型原生短标签；Krea 的自然语言 lead 不进入标签流。
    style: style?.sd ? style.sd.split(',').map(token => token.trim()).filter(Boolean) : [],
  })
  const rendered = renderPromptPlan(plan, 'anima', profile)
  // renderPromptPlan 对 anima 恒返回空 negative，但无 LoRA 工作流含负向 encode 节点，
  // 因此负向词由调用方按下发：先按 profile negative_mode 合并 negative_prefix，
  // 再保留 blueprint 的非样板负向词（样板词由 replace 策略替换）。
  const negative = assembleNegative(
    profile,
    {
      negative: (blueprint?.negativeTokens || []).join(', '),
      rating: ratingLevel,
    },
    'anima',
    { shot: options.shot, character: character.id },
  )
  const finalNegative = blueprintNegative(negative, blueprint)
  return { plan, prompt: rendered.prompt, negative: finalNegative, adult }
}
