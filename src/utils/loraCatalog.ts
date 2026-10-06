import endfieldLora from '../../runtime-rs/src/images/endfield-lora.json' with { type: 'json' }

/** Only the installed Endfield cast uses this collection; expanded 2.9B is excluded. */
export function endfieldAnimaBinding(characterId: string | null | undefined, family = 'anima', modelId = 'anima-miaomiao-v1.6') {
  const nativeCharacters = endfieldLora.nativeCharactersByModel as Record<string, string[]>
  if (family !== 'anima' || !characterId || !Object.hasOwn(endfieldLora.characters, characterId)
    || !endfieldLora.compatibleModels.includes(modelId) || nativeCharacters[modelId]?.includes(characterId)) return null
  return { character: characterId, loraId: endfieldLora.id, loraStrength: endfieldLora.strength }
}

export interface LoraWeightMap {
  portrait?: number
  fullbody?: number
  complex_scene?: number
}

export interface LoraCatalogEntry {
  id: string
  name: string
  version: string
  description: string
  recommendedWeight?: number | LoraWeightMap
  baseModel: string
  character: string
  triggerWords: string[]
  experimental?: boolean
  previewLabel?: string
  evaluation?: {
    status: string
    evaluatedAt: string
    method: string
    matrix: string
    evidence: string
    metrics: Array<[string, string]>
    knownLimitation: string
    selectionReason: string
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : []
}

function weightMap(value: unknown): number | LoraWeightMap | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!isRecord(value)) return undefined
  const result: LoraWeightMap = {}
  for (const key of ['portrait', 'fullbody', 'complex_scene'] as const) {
    const number = Number(value[key])
    if (Number.isFinite(number)) result[key] = number
  }
  return Object.keys(result).length ? result : undefined
}

export function parseLoraCatalog(value: unknown): LoraCatalogEntry[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  return value.flatMap((item): LoraCatalogEntry[] => {
    if (!isRecord(item)) return []
    const id = text(item.id)
    const name = text(item.name)
    if (!id || !name || seen.has(id)) return []
    seen.add(id)
    const training = isRecord(item.training) ? item.training : {}
    const dataset = isRecord(item.dataset) ? item.dataset : {}
    const triggers = stringList(item.trigger_words)
    const trigger = text(item.trigger)
    const validation = isRecord(item.validation) ? item.validation : {}
    const metrics = isRecord(validation.metrics)
      ? Object.entries(validation.metrics).flatMap(([label, result]) => {
          const value = text(result)
          return value ? [[label, value] as [string, string]] : []
        })
      : []
    const hasEvaluation = Boolean(text(validation.status) || metrics.length || text(validation.evidence))
    return [{
      id,
      name,
      version: text(item.version),
      description: text(item.description),
      recommendedWeight: weightMap(item.recommended_weight),
      baseModel: text(item.base_model) || text(training.base_model),
      character: text(item.character) || text(dataset.character),
      triggerWords: triggers.length ? triggers : (trigger ? [trigger] : []),
      ...(item.experimental === true ? { experimental:true } : {}),
      ...(text(item.preview_label) ? { previewLabel:text(item.preview_label) } : {}),
      ...(hasEvaluation ? { evaluation: {
        status: text(validation.status),
        evaluatedAt: text(validation.evaluated_at),
        method: text(validation.method),
        matrix: text(validation.matrix),
        evidence: text(validation.evidence),
        metrics,
        knownLimitation: text(validation.known_limitation),
        selectionReason: text(validation.selection_reason),
      } } : {}),
    }]
  })
}

export function formatLoraWeight(weight: number | LoraWeightMap | undefined): string {
  if (typeof weight === 'number') return String(weight)
  if (!weight) return ''
  return Object.entries(weight)
    .map(([key, value]) => `${key}: ${Math.round(value * 100)}%`)
    .join(' / ')
}
