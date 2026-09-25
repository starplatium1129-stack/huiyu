import type { AdultEligibility, PopularOutfit, PopularCharacter } from '../types/character'
export type { AdultEligibility, PopularOutfit, PopularCharacter } from '../types/character'

// 热门角色无 LoRA 创作模式 —— 数据解析、资格门控与结构化输入构建。
// 纯 TS 无 DOM：数据经 sceneStore 单例加载后传入，本模块只做派生与门控。
// 命名遵循 src/utils/ 既有风格（promptPolicy / sceneInference）。

import type { SceneBlueprint } from '../types/sceneBlueprint'
export type { SceneBlueprint } from '../types/sceneBlueprint'

import {
  isRecord,
  negativeStringList,
  requiredString,
  requiredStringList,
  stringList,
  stringValue,
} from './popularParseGuards.ts'
import { parseCompositionIntent } from './blueprintComposition.ts'
export * from './popularBlueprintDecisions.ts'
export * from './popularPromptBuilder.ts'

export type DrawSubject =
  | { kind: 'studio' }
  | { kind: 'popular'; characterId: string; outfitId: string; blueprintId: string | null }

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
