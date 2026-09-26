import { profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
/** AICSceneUX 的 TypeScript 替代：纯场景工具函数，无副作用 */

export interface SceneUXConfig {
  signatureSceneIds?: string[]
  reviewSceneIds?: string[]
  curatedSceneIds?: string[]
  personaCoreSceneIds?: string[]
  personaCoreReasons?: Record<string, string>
  searchAliases?: Record<string, string[]>
  recommendationReasons?: Record<string, string>
}

export interface PreferenceProfile {
  entries: number; favorites: number
  scenes: Record<string, SceneStats>
  characters: Record<string, SceneStats>
  generatedAt: number
}

interface SceneStats {
  uses: number; favorites: number
  lastUsed: number
}

const RECENT_KEY = 'aics_recent_scenes'
export const HIDDEN_SCENES_KEY = 'aics_hidden_scenes'
export const SCENE_USAGE_KEY = 'aics_scene_usage_v1'
export const SCENE_USAGE_VERSION = 1

export interface SceneUsageRecord {
  uses: number
  lastUsed: number
}

export type SceneUsageMap = Record<string, SceneUsageRecord>

interface SceneUsageEnvelope {
  version: number
  records: SceneUsageMap
}

export interface RecentScene {
  id: string
  title: string
  char: string
  usedAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function readHiddenScenes(storage?: Storage): Set<string> {
  try {
    const value = JSON.parse((storage ?? localStorage).getItem(HIDDEN_SCENES_KEY) ?? '[]')
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [])
  } catch {
    return new Set()
  }
}

export function writeHiddenScenes(ids: Iterable<string>, storage?: Storage): void {
  ;(storage ?? localStorage).setItem(HIDDEN_SCENES_KEY, JSON.stringify([...new Set(ids)]))
}

export function readSceneUsage(storage?: Storage): SceneUsageMap {
  const target = storage ?? localStorage
  const empty: SceneUsageEnvelope = { version: SCENE_USAGE_VERSION, records: {} }
  try {
    const stored = target.getItem(SCENE_USAGE_KEY)
    const value = JSON.parse(stored ?? '{}')
    const source = isRecord(value) && isRecord(value.records) ? value.records : value
    if (!isRecord(source)) {
      try { target.setItem(SCENE_USAGE_KEY, JSON.stringify(empty)) } catch {}
      return {}
    }
    const records = Object.fromEntries(Object.entries(source).flatMap(([id, raw]) => {
      const record = isRecord(raw) ? raw : {}
      const uses = Math.max(0, Math.floor(Number(record.uses) || 0))
      const lastUsed = Math.max(0, Number(record.lastUsed) || 0)
      const safeId = id.trim().slice(0, 80)
      return safeId && uses ? [[safeId, { uses, lastUsed }]] : []
    }))
    const migrated = JSON.stringify({ version: SCENE_USAGE_VERSION, records })
    if (stored !== migrated) {
      try { target.setItem(SCENE_USAGE_KEY, migrated) } catch {}
    }
    return records
  } catch {
    try { target.setItem(SCENE_USAGE_KEY, JSON.stringify(empty)) } catch {}
    return {}
  }
}

export function recordSceneUsage(scene: { id: string }, storage?: Storage, now = Date.now()): SceneUsageMap {
  if (!scene?.id) return readSceneUsage(storage)
  const target = storage ?? localStorage
  const usage = readSceneUsage(target)
  const previous = usage[scene.id]
  usage[scene.id] = {
    uses: Math.min((previous?.uses ?? 0) + 1, 9999),
    lastUsed: Math.max(previous?.lastUsed ?? 0, now),
  }
  try {
    target.setItem(SCENE_USAGE_KEY, JSON.stringify({
      version: SCENE_USAGE_VERSION,
      records: usage,
    }))
  } catch {}
  return usage
}

export function sceneUsageScore(record: SceneUsageRecord | undefined, now = Date.now()): number {
  if (!record) return 0
  const days = Math.max(0, (now - record.lastUsed) / 86400000)
  const recency = days <= 1 ? 12 : days <= 7 ? 8 : days <= 30 ? 4 : days <= 90 ? 1 : 0
  return Math.min(record.uses, 12) * 4 + recency
}

export function isPersonaCore(scene: { id: string }, config: SceneUXConfig | null | undefined): boolean {
  return list(config, 'personaCoreSceneIds').includes(scene.id)
}

function list(config: SceneUXConfig | null | undefined, key: keyof SceneUXConfig): string[] {
  const v = config?.[key]
  return Array.isArray(v) ? v as string[] : []
}

export function tier(scene: { id: string }, config: SceneUXConfig | null | undefined): 'signature' | 'review' | 'curated' | 'standard' {
  if (list(config, 'signatureSceneIds').includes(scene.id)) return 'signature'
  if (list(config, 'reviewSceneIds').includes(scene.id)) return 'review'
  if (list(config, 'curatedSceneIds').includes(scene.id)) return 'curated'
  return 'standard'
}

export function priority(scene: { id: string }, config: SceneUXConfig | null | undefined): number {
  const sigs = list(config, 'signatureSceneIds')
  const cur  = list(config, 'curatedSceneIds')
  const si = sigs.indexOf(scene.id), ci = cur.indexOf(scene.id)
  if (si >= 0) return 30000 - si
  if (ci >= 0) return 20000 - ci
  return 10000 - (Number(scene.id.replace(/\D/g, '')) || 0)
}

export function characterLabel(value: string): string {
  if (value === 'nene' || value === 'ayachi_nene') return '宁宁'
  if (value === 'natsume' || value === 'shiki_natsume') return '夏目'
  if (value === 'triad' || value === 'both') return '双人'
  return value || ''
}

function searchText(scene: Record<string, unknown>, extras?: string[]): string {
  return [
    scene.id, scene.title, scene.story, scene.emotion, scene.char,
    characterLabel(String(scene.char ?? '')), scene.rating,
    scene.category, scene.season, scene.time, scene.timeOfDay,
    scene.location, scene.weather, scene.camera, scene.lighting,
    ...(Array.isArray(scene.tags) ? scene.tags : []),
    ...(extras ?? []),
  ].join(' ').toLowerCase()
}

function normalizeQuery(value: string): string {
  return String(value ?? '').toLowerCase()
    .replace(/[，。！？、,.;；:：/\\|()[\]{}"'""'']+/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

function uniqueTerms(items: string[]): string[] {
  const seen = new Set<string>()
  return items.map(normalizeQuery).filter(t => {
    if (!t || seen.has(t)) return false
    seen.add(t)
    return true
  })
}

function detectInside(query: string, term: string): boolean {
  if (!term) return false
  if (/^[\u3400-\u9fff]$/.test(term)) return query === term || query.split(' ').includes(term)
  return query.includes(term)
}

export function analyzeQuery(query: string, config: SceneUXConfig | null | undefined) {
  const normalized = normalizeQuery(query)
  if (!normalized) return { normalized: '', groups: [] as string[][], intents: [] as string[], residualTerms: [] as string[] }
  const aliases = config?.searchAliases ?? {}
  const groups: string[][] = [], intents: string[] = []
  let residual = normalized

  if (aliases[normalized]) {
    groups.push(uniqueTerms([normalized, ...(aliases[normalized] ?? [])]))
    intents.push(normalized); residual = ''
  } else {
    Object.entries(aliases).forEach(([intent, synonyms]) => {
      const terms = uniqueTerms([intent, ...(synonyms ?? [])])
      const hits = terms.filter(t => detectInside(normalized, t))
      if (!hits.length) return
      groups.push(terms); intents.push(intent)
      hits.sort((a, b) => b.length - a.length).forEach(h => { residual = residual.split(h).join(' ') })
    })
  }

  const stopPhrases = ['请帮我找','帮我找','我想画','想画一个','想画','想要一个','想要','给我一个','给我','来一个','来点','比较','有一点','有点','一幅','一张','一些','一个','这种','那种','感觉','风格','画面','场景']
  stopPhrases.sort((a, b) => b.length - a.length).forEach(p => { residual = residual.split(p).join(' ') })
  const stopSingles = new Set(['我','的','地','得','在','把','请','找','画','想','要','个','张','些','点'])
  const residualTerms = normalizeQuery(residual).split(' ').filter(t => t && !stopSingles.has(t))
  residualTerms.forEach(t => groups.push([t]))

  return { normalized, groups, intents, residualTerms }
}

export function matchesSearch(scene: Record<string, unknown>, query: string, config: SceneUXConfig | null | undefined, extras?: string[]): boolean {
  const { groups } = analyzeQuery(query, config)
  if (!groups.length) return true
  const hay = searchText(scene, extras)
  return groups.every(grp => grp.some(t => hay.includes(t.toLowerCase())))
}

export function searchScore(scene: Record<string, unknown>, query: string, config: SceneUXConfig | null | undefined, extras?: string[]): number {
  const { groups, normalized } = analyzeQuery(query, config)
  if (!groups.length) return 0
  const fields = [
    { value: scene.title, w: 36 }, { value: characterLabel(String(scene.char ?? '')), w: 30 },
    { value: scene.emotion, w: 28 }, { value: scene.location, w: 24 },
    { value: scene.weather, w: 22 }, { value: scene.category, w: 20 },
    { value: scene.story, w: 16 },
    { value: Array.isArray(scene.tags) ? scene.tags.join(' ') : '', w: 14 },
    { value: [scene.camera, scene.lighting, scene.season, scene.timeOfDay].join(' '), w: 10 },
    { value: (extras ?? []).join(' '), w: 8 },
  ]
  let score = groups.reduce((sum, grp) => {
    let best = 0
    grp.forEach(term => {
      const t = normalizeQuery(term)
      fields.forEach(f => { if (normalizeQuery(String(f.value ?? '')).includes(t)) best = Math.max(best, f.w + Math.min(t.length, 8)) })
    })
    return sum + best
  }, 0)
  const title = normalizeQuery(String(scene.title ?? ''))
  const story = normalizeQuery(String(scene.story ?? ''))
  if (normalized && title.includes(normalized)) score += 50
  else if (normalized && story.includes(normalized)) score += 24
  return score
}

function normalizeChar(v: string): string {
  if (v === 'ayachi_nene') return 'nene'
  if (v === 'shiki_natsume') return 'natsume'
  if (v === 'both') return 'triad'
  return v || ''
}

function ensureStats(container: Record<string, SceneStats>, key: string): SceneStats {
  if (!container[key]) container[key] = { uses: 0, favorites: 0, lastUsed: 0 }
  return container[key]
}

export function buildPreferenceProfile(history: unknown[], now?: number): PreferenceProfile {
  const profile: PreferenceProfile = { entries: 0, favorites: 0, scenes: {}, characters: {}, generatedAt: now ?? Date.now() }
  ;(Array.isArray(history) ? history : []).forEach((entry) => {
    if (!isRecord(entry)) return
    profile.entries++
    if (entry.favorite) profile.favorites++
    const sceneId = stringValue(entry.scene)
    const characterId = normalizeChar(stringValue(entry.character))
    const targets = [
      sceneId ? ensureStats(profile.scenes, sceneId) : null,
      characterId ? ensureStats(profile.characters, characterId) : null,
    ].filter((stats): stats is SceneStats => stats !== null)
    targets.forEach(s => {
      s.uses++
      if (entry.favorite) s.favorites++
      s.lastUsed = Math.max(s.lastUsed, Number(entry.timestamp ?? entry.id) || 0)
    })
  })
  return profile
}

function statsScore(stats: SceneStats | undefined, now: number): number {
  if (!stats) return 0
  let score = Math.min(stats.uses, 6) * 2 + Math.min(stats.favorites, 3) * 12
  if (stats.lastUsed) {
    const days = Math.max(0, (now - stats.lastUsed) / 86400000)
    score += days <= 7 ? 4 : days <= 30 ? 2 : days <= 90 ? 1 : 0
  }
  return score
}

export function personalScore(scene: { id: string; char?: string }, profile: PreferenceProfile | null | undefined): number {
  if (!scene || !profile) return 0
  const now = profile.generatedAt || Date.now()
  return statsScore(profile.scenes?.[scene.id], now) + statsScore(profile.characters?.[normalizeChar(scene.char ?? '')], now) * 0.3
}

export function personalReason(scene: { id: string; char?: string }, profile: PreferenceProfile | null | undefined): string {
  if (!scene || !profile) return ''
  const ss = profile.scenes?.[scene.id]
  if (ss) {
    if (ss.favorites) return '你收藏过这个场景'
    if (ss.uses >= 2) return `你已经创作过 ${ss.uses} 次`
  }
  const cs = profile.characters?.[normalizeChar(scene.char ?? '')]
  if (cs && cs.uses >= 3 && cs.favorites) {
    return `符合你常画的${characterLabel(scene.char ?? '')}偏好`
  }
  return ''
}

export function isPersonalFavorite(scene: { id: string }, profile: PreferenceProfile | null | undefined): boolean {
  return !!(scene && profile?.scenes?.[scene.id]?.favorites)
}

function tagKey(value: unknown): string {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_')
}

/**
 * 判断当前 story 是否仍等同于场景自带故事。
 * 用于「脱离场景」时决定该不该清空文本：场景原文要清，用户自己写的要留。
 */
export function isSceneBoundStory(scene: unknown, story: unknown, baseStory?: unknown): boolean {
  if (!isRecord(scene)) return false
  const current = String(story ?? '').replace(/\s+/g, ' ').trim()
  const original = String(baseStory || scene.story || '').replace(/\s+/g, ' ').trim()
  return !!current && !!original && current === original
}

/**
 * 从历史记录恢复手动标签。
 * 老记录没有 manual_tags 快照时，用兼容场景的 tags 兜底；
 * 若场景与当前角色不兼容，则剔除该场景的内建标签，只留用户真正手加的。
 */
export function restoreHistoryManualTags(entry: unknown, scene: unknown, sceneCompatible: boolean): string[] {
  const history = isRecord(entry) ? entry : {}
  const sceneRecord = isRecord(scene) ? scene : null
  const hasSnapshot = Array.isArray(history.manual_tags)
  const source: unknown[] = hasSnapshot
    ? history.manual_tags as unknown[]
    : (sceneRecord && sceneCompatible && Array.isArray(sceneRecord.tags) ? sceneRecord.tags : [])
  const staleSceneTags = sceneRecord && !sceneCompatible
    ? new Set<string>((Array.isArray(sceneRecord.tags) ? sceneRecord.tags : []).map(tagKey))
    : null
  const seen = new Set<string>()
  return source.filter((tag): tag is string => {
    if (typeof tag !== 'string' || !tag.trim()) return false
    const key = tagKey(tag)
    if (!key || (staleSceneTags && staleSceneTags.has(key)) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 场景不兼容时，不要把仍绑定该场景的故事文本带回来 */
export function restoreHistoryStory(entry: unknown, scene: unknown, sceneCompatible: boolean): string {
  const history = isRecord(entry) ? entry : {}
  const sceneRecord = isRecord(scene) ? scene : null
  const story = typeof history.story === 'string' ? history.story : ''
  return sceneRecord && !sceneCompatible && isSceneBoundStory(sceneRecord, story, sceneRecord.story) ? '' : story
}

export function readRecent(storage?: Storage): RecentScene[] {
  try {
    const items: unknown = JSON.parse((storage ?? localStorage).getItem(RECENT_KEY) ?? '[]')
    return Array.isArray(items) ? items.flatMap((item): RecentScene[] => {
      if (!isRecord(item) || typeof item.id !== 'string' || !item.id) return []
      return [{
        id: item.id,
        title: stringValue(item.title),
        char: stringValue(item.char),
        usedAt: Math.max(0, Number(item.usedAt) || 0),
      }]
    }) : []
  } catch { return [] }
}

export function rememberRecent(scene: { id: string; title?: string; char?: string }, storage?: Storage): RecentScene[] {
  if (!scene?.id) return []
  const target = storage ?? localStorage
  const items = [{ id: scene.id, title: scene.title ?? '', char: scene.char ?? '', usedAt: Date.now() }, ...readRecent(target).filter(i => i.id !== scene.id)].slice(0, 8)
  try { target.setItem(RECENT_KEY, JSON.stringify(items)) } catch {}
  return items
}
