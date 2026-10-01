export type InterrogateMode = 'tag' | 'caption'
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
  rating: Record<'general' | 'sensitive' | 'questionable' | 'explicit', number>
  warning?: string
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

/** Keep the model's categories separate; never turn character/style/meta rows into general tags. */
export function decodeInterrogateResult(value: unknown, mode: InterrogateMode): InterrogateResult {
  const data = record(value)
  if (data?.engine === 'heuristic') {
    throw new Error('PixAI 本地反推模型不可用，演示标签未写入工作台，请检查模型后重试')
  }
  const scores = record(data?.scores)
  const rating = record(data?.rating)
  const characterTags = data?.characterTags
  if (!data || data.engine !== 'pixai' || data.model !== 'pixai-tagger-v1.0'
    || data.mode !== mode || !probability(data.threshold)
    || !tags(data.tags, 100) || !tags(characterTags)
    || typeof data.caption !== 'string' || !scores || !rating
    || Object.values(scores).some(score => !probability(score))
    || data.tags.some(tag => !probability(scores[tag]) || characterTags.includes(tag))
    || !probability(rating.general) || !probability(rating.sensitive)
    || !probability(rating.questionable) || !probability(rating.explicit)
    || (data.captionDerived !== undefined && data.captionDerived !== 'pixai-tags')
    || (data.warning !== undefined && typeof data.warning !== 'string')) {
    throw new Error('反推服务返回了无效 PixAI 结果，请更新本地反推服务后重试')
  }
  return {
    engine: 'pixai', model: 'pixai-tagger-v1.0', mode, threshold: data.threshold,
    tags: [...data.tags], scores: { ...scores } as Record<string, number>,
    characterTags: [...characterTags], caption: data.caption,
    rating: { general: rating.general, sensitive: rating.sensitive,
      questionable: rating.questionable, explicit: rating.explicit },
    ...(data.captionDerived === 'pixai-tags' ? { captionDerived: 'pixai-tags' as const } : {}),
    ...(typeof data.warning === 'string' ? { warning: data.warning } : {}),
  }
}
