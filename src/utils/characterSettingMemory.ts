import { runtimeFetch } from '../platform/runtimeUrl.ts'
import { DATA_VERSION } from '../stores/sceneStore.ts'

/**
 * 角色设定记忆（2026-08-28 路线图第 6 条 · 最小闭环）。
 *
 * 数据源：data/characters.json 中的既有角色档案
 * （bg_story / personality / likes / speech / identity / visual_dna），
 * 零新增数据文件、零编造。热门角色（40+）的 canon/identityProse 在
 * sceneStore.popularCharacters 中，出图侧已消费，此处专注聊天/陪伴注入。
 *
 * 不做向量库（单人本地项目是负债）：按角色精确取设定卡 + 关键词检索，
 * 与 chatMemory 的 recallChatFacts 同思路，注入预算受控。
 */

export interface CharacterIdentityRecord {
  role?: string
  age?: string
  occupation?: string
  faction?: string
}

export interface CharacterSettingRecord {
  id: string
  name: string
  /** 背景故事（角色世界观与命运核心）。 */
  bgStory: string
  /** 性格标签数组。 */
  personality: string[]
  /** 喜好（情感锚点，桌宠共鸣用）。 */
  likes: string[]
  /** 说话风格（英文，LLM 语气对齐用）。 */
  speech: string
  identity?: CharacterIdentityRecord
}

const MAX_ITEM_TEXT = 240
const MAX_ITEMS = 8

function cleanText(value: unknown, fallback = '', maxLength = MAX_ITEM_TEXT): string {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
  return text || fallback
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(item => cleanText(item)).filter(Boolean)
    : []
}

function parseIdentity(value: unknown): CharacterIdentityRecord | undefined {
  if (typeof value === 'string') {
    const role = cleanText(value)
    return role ? { role } : undefined
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const identity: CharacterIdentityRecord = {
    role: cleanText(record.role) || undefined,
    age: cleanText(record.age) || undefined,
    occupation: cleanText(record.occupation) || undefined,
    faction: cleanText(record.faction) || undefined,
  }
  return Object.values(identity).some(Boolean) ? identity : undefined
}

function parseRecord(value: unknown): CharacterSettingRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = cleanText(record.id)
  if (!id) return null
  const name = cleanText(record.name) || id
  return {
    id,
    name,
    bgStory: cleanText(record.bg_story, '', 4000),
    personality: stringList(record.personality),
    likes: stringList(record.likes),
    speech: cleanText(record.speech),
    identity: parseIdentity(record.identity),
  }
}

export function parseCharacterSettingCards(value: unknown): CharacterSettingRecord[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const cards: CharacterSettingRecord[] = []
  for (const raw of value) {
    const card = parseRecord(raw)
    if (!card || seen.has(card.id)) continue
    seen.add(card.id)
    cards.push(card)
  }
  return cards
}

// ── 懒加载（data/characters.json 约几十 KB；DATA_VERSION 防浏览器缓存）─────
let cardsCache: CharacterSettingRecord[] | null = null
let cardsPromise: Promise<CharacterSettingRecord[]> | null = null
let cardsRevision = 0

export async function loadCharacterSettingCards(force = false): Promise<CharacterSettingRecord[]> {
  if (cardsCache && !force) return cardsCache
  if (!cardsPromise || force) {
    const revision = ++cardsRevision
    cardsPromise = (async () => {
      const response = await runtimeFetch(`/data/characters.json?v=${DATA_VERSION}`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`characters.json HTTP ${response.status}`)
      const data = await response.json()
      const cards = parseCharacterSettingCards(data)
      if (revision === cardsRevision) cardsCache = cards
      return cards
    })().catch(error => {
      if (revision === cardsRevision) cardsPromise = null
      throw error
    })
  }
  return cardsPromise
}

/** 同步读缓存（聊天组合根预热后每次回合取用，不阻塞请求体组装）。 */
export function characterSettingCards(): CharacterSettingRecord[] {
  return cardsCache ?? []
}

// ── 检索与注入 ──────────────────────────────────────────────────────────

/** 单个角色设定 → 一组可注入的条目文本（预算受控）。 */
export function buildCharacterSettingEntries(card: CharacterSettingRecord): string[] {
  const entries: string[] = []
  if (card.bgStory) {
    entries.push(`背景：${card.bgStory.slice(0, MAX_ITEM_TEXT)}`)
  }
  if (card.personality.length) entries.push(`性格：${card.personality.join('、')}`)
  if (card.likes.length) entries.push(`喜好：${card.likes.join('、')}`)
  if (card.speech) entries.push(`说话风格：${card.speech}`)
  const identity = card.identity
  if (identity) {
    const parts = [
      identity.role ? `身份 ${identity.role}` : '',
      identity.age ? `年龄 ${identity.age}` : '',
      identity.occupation ? `职业 ${identity.occupation}` : '',
      identity.faction ? `所属 ${identity.faction}` : '',
    ].filter(Boolean)
    if (parts.length) entries.push(`设定：${parts.join('；')}`)
  }
  for (let start = MAX_ITEM_TEXT; start < card.bgStory.length; start += MAX_ITEM_TEXT) entries.push(`背景：${card.bgStory.slice(start, start + MAX_ITEM_TEXT)}`)
  return entries
}

function relevanceTerms(value: string): Set<string> {
  const text = cleanText(value, '', 4000).toLocaleLowerCase()
  const terms = new Set<string>(text.match(/[a-z0-9][a-z0-9_-]+/g) || [])
  for (const sequence of text.match(/[\u3400-\u9fff]+/g) || []) {
    if (sequence.length === 1) terms.add(sequence)
    for (let index = 0; index < sequence.length - 1; index += 1) terms.add(sequence.slice(index, index + 2))
  }
  return terms
}

/**
 * 角色设定召回：精确角色匹配优先；query 为空时返回该角色全部设定条目，
 * 否则按关键词重叠排序截取（聊天回合按用户输入召回，与 recallChatFacts 同思路）。
 */
export function recallCharacterSetting(
  cards: CharacterSettingRecord[],
  characterId: string,
  query = '',
  limit = 6,
): string[] {
  const target = cards.find(card => card.id === characterId)
  if (!target) return []
  const count = Math.max(0, Math.min(MAX_ITEMS, Number.isFinite(limit) ? Math.floor(limit) : 6))
  if (!count) return []
  const entries = buildCharacterSettingEntries(target)
  if (!query.trim()) return entries.slice(0, count)

  const queryTerms = relevanceTerms(query)
  const ranked = entries
    .map(entry => {
      const terms = relevanceTerms(entry)
      let overlap = 0
      for (const term of queryTerms) if (terms.has(term)) overlap += 1
      return { entry, overlap }
    })
    .sort((left, right) => right.overlap - left.overlap)
  const selected = ranked.filter(item => item.overlap > 0).map(item => item.entry)
  // 关键词未命中任何条目时，退回角色基础设定（背景 + 性格），保证注入不空。
  if (!selected.length) return entries.slice(0, Math.min(2, count))
  return selected.slice(0, count)
}
