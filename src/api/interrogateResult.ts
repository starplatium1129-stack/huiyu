import type { InterrogateAssistLayout, InterrogateAssistLayoutCanvas, InterrogateAssistLayoutItem } from '../types/interrogate'
export type { InterrogateAssistLayout, InterrogateAssistLayoutCanvas, InterrogateAssistLayoutItem } from '../types/interrogate'

export type InterrogateMode = 'tag' | 'caption'
export type InterrogateAssistProvider = 'chatgpt' | 'api'
export type InterrogateSubjectMode = 'free' | 'bound'
export interface InterrogateResult {
  engine: 'pixai'
  model: 'pixai-tagger-v1.0'
  mode: InterrogateMode
  threshold: number
  tags: string[]
  scores: Record<string, number>
  caption: string
  captionDerived?: 'pixai-tags'
  characterTags: string[]
  copyrightTags: string[]
  /** PixAI artist-style predictions, kept separate from general visual tags. */
  styleTags: string[]
  rating: Record<'general' | 'sensitive' | 'questionable' | 'explicit', number>
  warning?: string
  assistUsed?: boolean
  assistProvider?: InterrogateAssistProvider
  assistModel?: string
  assistFallbackReason?: string
  assistSubjectMode?: InterrogateSubjectMode
  assistLayout?: InterrogateAssistLayout
  cacheHit?: boolean
  cachedAt?: number
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

function probability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function tags(value: unknown, limit = Infinity): value is string[] {
  return Array.isArray(value) && value.length <= limit
    && value.every(tag => typeof tag === 'string' && tag.trim() === tag && tag.length > 0)
    && new Set(value).size === value.length
}

const ASSIST_CANVASES = new Set<InterrogateAssistLayoutCanvas>(['single', 'multi_panel', 'collage'])
const ASSIST_LABELS = new Set<InterrogateAssistLayoutItem['label']>(['character', 'object', 'text'])

/** Validate and deep-clone a normalized assist layout (`bbox` in [y1, x1, y2, x2] 0..1). */
export function parseAssistLayout(value: unknown): InterrogateAssistLayout | null {
  const data = record(value)
  if (!data || typeof data.canvas !== 'string' || !ASSIST_CANVASES.has(data.canvas as InterrogateAssistLayoutCanvas)) {
    return null
  }
  if (!Array.isArray(data.items) || data.items.length < 1 || data.items.length > 12) {
    return null
  }
  const items: InterrogateAssistLayoutItem[] = []
  for (const entry of data.items) {
    const item = record(entry)
    if (!item || typeof item.label !== 'string' || !ASSIST_LABELS.has(item.label as InterrogateAssistLayoutItem['label'])) {
      return null
    }
    if (typeof item.caption !== 'string' || !item.caption.trim()) return null
    if (!Array.isArray(item.bbox) || item.bbox.length !== 4) return null
    const [y1, x1, y2, x2] = item.bbox
    if (!probability(y1) || !probability(x1) || !probability(y2) || !probability(x2) || !(y1 < y2 && x1 < x2)) {
      return null
    }
    const label = item.label as InterrogateAssistLayoutItem['label']
    if (item.text !== undefined && typeof item.text !== 'string') return null
    const text = typeof item.text === 'string' ? item.text.trim() : ''
    if (label === 'text' && !text) return null
    items.push({
      label,
      caption: item.caption.trim(),
      bbox: [y1, x1, y2, x2],
      ...(label === 'text' || text ? { text } : {}),
    })
  }
  return { canvas: data.canvas as InterrogateAssistLayoutCanvas, items }
}

/** Keep the model's categories separate; never turn character/style/meta rows into general tags. */
export function decodeInterrogateResult(value: unknown, mode: InterrogateMode): InterrogateResult {
  const data = record(value)
  if (data?.engine === 'heuristic') {
    throw new Error('反推暂不可用，请稍后重试')
  }
  const scores = record(data?.scores)
  const rating = record(data?.rating)
  const characterTags = data?.characterTags
  // Older installed runtimes omit these categories; keep their original result usable.
  const copyrightTags = data?.copyrightTags === undefined ? [] : data.copyrightTags
  const styleTags = data?.styleTags === undefined ? [] : data.styleTags
  const assistLayout = data?.assistLayout === undefined ? undefined : parseAssistLayout(data.assistLayout)
  if (!data || data.engine !== 'pixai' || data.model !== 'pixai-tagger-v1.0'
    || data.mode !== mode || !probability(data.threshold)
    || !tags(data.tags, 100) || !tags(characterTags, 100) || !tags(copyrightTags, 100) || !tags(styleTags, 100)
    || typeof data.caption !== 'string' || !scores || !rating
    || Object.values(scores).some(score => !probability(score))
    || data.tags.some(tag => !probability(scores[tag]) || characterTags.includes(tag) || copyrightTags.includes(tag) || styleTags.includes(tag))
    || !probability(rating.general) || !probability(rating.sensitive)
    || !probability(rating.questionable) || !probability(rating.explicit)
    || (data.captionDerived !== undefined && data.captionDerived !== 'pixai-tags')
    || (data.warning !== undefined && typeof data.warning !== 'string')
    || (data.assistUsed !== undefined && typeof data.assistUsed !== 'boolean')
    || (data.assistProvider !== undefined && data.assistProvider !== 'chatgpt' && data.assistProvider !== 'api')
    || (data.assistModel !== undefined && typeof data.assistModel !== 'string')
    || (data.assistFallbackReason !== undefined && typeof data.assistFallbackReason !== 'string')
    || (data.assistSubjectMode !== undefined && data.assistSubjectMode !== 'free' && data.assistSubjectMode !== 'bound')
    || (data.assistLayout !== undefined && !assistLayout)
    || (data.cacheHit !== undefined && typeof data.cacheHit !== 'boolean')
    || (data.cachedAt !== undefined && (typeof data.cachedAt !== 'number' || !Number.isFinite(data.cachedAt)))) {
    throw new Error('反推结果异常，请重试')
  }
  return {
    engine: 'pixai', model: 'pixai-tagger-v1.0', mode, threshold: data.threshold,
    tags: [...data.tags], scores: { ...scores } as Record<string, number>,
    characterTags: [...characterTags], caption: data.caption,
    copyrightTags: [...copyrightTags], styleTags: [...styleTags],
    rating: { general: rating.general, sensitive: rating.sensitive,
      questionable: rating.questionable, explicit: rating.explicit },
    ...(data.captionDerived === 'pixai-tags' ? { captionDerived: 'pixai-tags' as const } : {}),
    ...(typeof data.warning === 'string' ? { warning: data.warning } : {}),
    ...(typeof data.assistUsed === 'boolean' ? { assistUsed: data.assistUsed } : {}),
    ...(data.assistProvider === 'chatgpt' || data.assistProvider === 'api' ? { assistProvider: data.assistProvider } : {}),
    ...(typeof data.assistModel === 'string' ? { assistModel: data.assistModel } : {}),
    ...(typeof data.assistFallbackReason === 'string' ? { assistFallbackReason: data.assistFallbackReason } : {}),
    ...(data.assistSubjectMode === 'free' || data.assistSubjectMode === 'bound' ? { assistSubjectMode: data.assistSubjectMode } : {}),
    ...(assistLayout ? { assistLayout } : {}),
    ...(typeof data.cacheHit === 'boolean' ? { cacheHit: data.cacheHit } : {}),
    ...(typeof data.cachedAt === 'number' && Number.isFinite(data.cachedAt) ? { cachedAt: data.cachedAt } : {}),
  }
}
