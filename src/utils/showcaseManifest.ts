export type ShowcaseCharacter = 'nene' | 'natsume' | 'triad'
export type ShowcaseRating = 'All' | 'R15' | 'R18'
export type ShowcaseEntryType = 'scene' | 'artist' | 'popular' | 'lora'

/**
 * 生成版本元数据：字段全部可选，旧样张缺省即视为「未记录」。
 * engine/model/checkpoint 指生成引擎、模型名与 checkpoint 文件；
 * loraId/loraVersion 记录 LoRA 与版本；seed 为确定性的生成种子。
 */
export interface ShowcaseGenMeta {
  engine?: string
  model?: string
  checkpoint?: string
  loraId?: string
  loraVersion?: string
  seed?: number
}

/** 审核依据：发布脚本把人工复核的 verdict/recordId/notes 写回条目顶部。 */
export interface ShowcaseReviewRef {
  verdict: 'pass'
  recordId?: string
  notes?: string
  reviewedAt?: string
}

/** 生成来源追踪：批次、候选 key、通过的 recordId 与复核信息。 */
export interface ShowcaseProvenance {
  batch?: string
  key?: string
  recordId?: string
  attempt?: number
  generatedAt?: string
  review?: ShowcaseReviewRef
}

export interface ShowcaseEntry {
  id: string
  title: string
  story: string
  category: string
  char: string
  rating: ShowcaseRating
  attempt: number
  /** 条目类型：scene（场景样张，默认）/ artist（画师风格）/ popular（热门角色）/ lora（LoRA 样张） */
  type: ShowcaseEntryType
  /** 展示名：热门角色样张用于角色标签（如「雷电将军 (Genshin Impact)」） */
  displayName?: string
  /** 相对 showcase 根目录的大图/缩略图路径；缺省时按 id 约定（{id}.jpg）推导 */
  image?: string
  thumb?: string
  /** Optional source dimensions used to reserve card space before the image decodes. */
  width?: number
  height?: number
  /** 生成版本元数据；缺省时 UI 不渲染元数据行 */
  meta?: ShowcaseGenMeta
  /** 完整 prompt / negative；新发布条目保留用于审计，UI 不强制展示 */
  prompt?: string
  negative?: string
  /** 来源与审核依据；缺省表示旧样张未记录 */
  provenance?: ShowcaseProvenance
}

export interface ShowcaseManifest {
  /** 场景数语义：只数 type === 'scene' 的条目 */
  sceneCount: number
  /** 全部条目数（含画师/热门角色/LoRA） */
  entryCount: number
  /** 各类型条目数 */
  typeCounts: Record<ShowcaseEntryType, number>
  /** 按 rating 对所有条目计数（R18 直接可筛，默认模糊） */
  counts: Record<ShowcaseRating, number>
  entries: ShowcaseEntry[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function nonNegativeNumber(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) && number >= 0 ? number : undefined
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function optionalDimension(value: unknown): number | undefined {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

function parseMeta(value: unknown): ShowcaseGenMeta | undefined {
  if (!isRecord(value)) return undefined
  const meta: ShowcaseGenMeta = {}
  const engine = optionalString(value.engine)
  if (engine) meta.engine = engine
  const model = optionalString(value.model)
  if (model) meta.model = model
  const checkpoint = optionalString(value.checkpoint)
  if (checkpoint) meta.checkpoint = checkpoint
  const loraId = optionalString(value.loraId)
  if (loraId) meta.loraId = loraId
  const loraVersion = optionalString(value.loraVersion)
  if (loraVersion) meta.loraVersion = loraVersion
  const seed = nonNegativeNumber(value.seed)
  if (seed !== undefined) meta.seed = Math.trunc(seed)
  return Object.keys(meta).length ? meta : undefined
}

function parseReview(value: unknown): ShowcaseReviewRef | undefined {
  if (!isRecord(value) || value.verdict !== 'pass') return undefined
  const review: ShowcaseReviewRef = { verdict: 'pass' }
  const recordId = optionalString(value.recordId)
  if (recordId) review.recordId = recordId
  const notes = optionalString(value.notes)
  if (notes) review.notes = notes
  const reviewedAt = optionalString(value.reviewedAt)
  if (reviewedAt) review.reviewedAt = reviewedAt
  return review
}

function parseProvenance(value: unknown): ShowcaseProvenance | undefined {
  if (!isRecord(value)) return undefined
  const provenance: ShowcaseProvenance = {}
  const batch = optionalString(value.batch)
  if (batch) provenance.batch = batch
  const key = optionalString(value.key)
  if (key) provenance.key = key
  const recordId = optionalString(value.recordId)
  if (recordId) provenance.recordId = recordId
  const attempt = nonNegativeNumber(value.attempt)
  if (attempt !== undefined) provenance.attempt = Math.trunc(attempt)
  const generatedAt = optionalString(value.generatedAt)
  if (generatedAt) provenance.generatedAt = generatedAt
  const review = parseReview(value.review)
  if (review) provenance.review = review
  return Object.keys(provenance).length ? provenance : undefined
}

function parseEntry(value: unknown): ShowcaseEntry | null {
  if (!isRecord(value)) return null
  if (typeof value.id !== 'string' || !value.id.trim()) return null
  if (typeof value.title !== 'string' || !value.title.trim()) return null
  const rawType = value.type
  const type: ShowcaseEntryType = rawType === 'artist'
    ? 'artist'
    : rawType === 'popular'
      ? 'popular'
      : rawType === 'lora'
        ? 'lora'
        : 'scene'
  const char = typeof value.char === 'string' ? value.char.trim() : ''
  if (type === 'scene') {
    if (char !== 'nene' && char !== 'natsume' && char !== 'triad') return null
  } else if (!char) {
    return null
  }
  if (value.rating !== 'All' && value.rating !== 'R15' && value.rating !== 'R18') return null
  const entry: ShowcaseEntry = {
    id: value.id.trim(),
    title: value.title.trim(),
    story: typeof value.story === 'string' ? value.story : '',
    category: typeof value.category === 'string' ? value.category : '',
    char,
    rating: value.rating,
    // 2026-08-16 审计：外层 Math.max(1,·) 会把显式 attempt:0（未迭代首版）抬成 1，
    // 与 provenance.attempt 的 Math.trunc 语义不一致。缺省 1、显式 0 保留。
    attempt: Math.trunc(nonNegativeNumber(value.attempt) ?? 1),
    type,
  }
  const displayName = optionalString(value.displayName)
  if (displayName) entry.displayName = displayName
  const image = optionalString(value.image)
  if (image) entry.image = image
  const thumb = optionalString(value.thumb)
  if (thumb) entry.thumb = thumb
  const width = optionalDimension(value.width)
  const height = optionalDimension(value.height)
  if (width !== undefined) entry.width = width
  if (height !== undefined) entry.height = height
  const meta = parseMeta(value.meta)
  if (meta) entry.meta = meta
  const prompt = optionalString(value.prompt)
  if (prompt) entry.prompt = prompt
  const negative = optionalString(value.negative)
  if (negative) entry.negative = negative
  const provenance = parseProvenance(value.provenance)
  if (provenance) entry.provenance = provenance
  return entry
}

function entryOrder(entry: ShowcaseEntry): number {
  const suffix = Number(entry.id.match(/(\d+)$/)?.[1])
  return Number.isFinite(suffix) ? suffix : Number.MAX_SAFE_INTEGER
}

export function parseShowcaseManifest(value: unknown): ShowcaseManifest {
  if (!isRecord(value) || !Array.isArray(value.entries)) {
    throw new Error('样张 manifest 格式无效')
  }
  const seen = new Set<string>()
  const entries = value.entries
    .map(parseEntry)
    .filter((entry): entry is ShowcaseEntry => entry !== null)
    .filter(entry => {
      if (seen.has(entry.id)) return false
      seen.add(entry.id)
      return true
    })
    .sort((a, b) => entryOrder(a) - entryOrder(b) || a.id.localeCompare(b.id))
  if (!entries.length && value.entries.length) throw new Error('样张 manifest 没有有效条目')

  const sceneCount = entries.filter(entry => entry.type === 'scene').length
  const typeCounts: Record<ShowcaseEntryType, number> = {
    scene: sceneCount,
    artist: entries.filter(entry => entry.type === 'artist').length,
    popular: entries.filter(entry => entry.type === 'popular').length,
    lora: entries.filter(entry => entry.type === 'lora').length,
  }
  return {
    // 一律由条目推导：sceneCount 语义为「场景数」，旧 v14 manifest 全为 scene
    // 条目，推导结果与历史 sceneCount 一致；新增的 entryCount/typeCounts 同样
    // 以条目为准，避免 manifest 里的冗余数字与真实数据漂移。
    sceneCount,
    entryCount: entries.length,
    typeCounts,
    counts: {
      All: entries.filter(entry => entry.rating === 'All').length,
      R15: entries.filter(entry => entry.rating === 'R15').length,
      R18: entries.filter(entry => entry.rating === 'R18').length,
    },
    entries,
  }
}
