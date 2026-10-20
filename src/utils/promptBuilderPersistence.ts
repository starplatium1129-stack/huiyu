import { normalizeKey } from './promptPrimitives.ts'

export type DraftCharKey = 'nene' | 'natsume' | 'triad' | 'none'

export interface SDParams {
  cfg: number
  steps: number
  sampler: string
  scheduler: string
  size: string
  hiresFix: boolean
  hiresScale: number
  hiresUpscaler: string
  hiresSteps: number
  hiresDenoise: number
  faceDetailer: boolean
  seedLock: boolean
  seed: number
  quality: boolean
  tail: boolean
  negative: boolean
  negativeCustom: string
}

export interface DraftSelections {
  emotion: string[]
  shot: string | null
  lighting: string | null
  composition: string | null
}

export interface DraftOutfitOverride {
  tokens: string[]
  replaced: string | null
}

export function parseOutfitOverride(value: unknown): DraftOutfitOverride | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const tokens = Array.isArray(input.tokens)
    ? [...new Set(input.tokens.filter((token): token is string => typeof token === 'string').map(token => token.trim()).filter(Boolean))]
    : []
  return tokens.length ? { tokens, replaced: typeof input.replaced === 'string' ? input.replaced : null } : null
}

/** Only tags actually introduced by reverse inference; user-owned duplicates are excluded. */
export interface DraftReferenceInput {
  tags: string[]
  /** Model categories retained for ordering, including names absent from the local catalogue. */
  characterTokens?: string[]
  copyrightTokens?: string[]
}

/** Clone the reference layer and retire classification for removed source tags. */
export function cloneReferenceInput(input: DraftReferenceInput | null | undefined, tags = input?.tags ?? []): DraftReferenceInput | null {
  if (!input || !tags.length) return null
  const keys = new Set(tags.map(normalizeKey))
  const characterTokens = input.characterTokens?.filter(tag => keys.has(normalizeKey(tag))) ?? []
  const copyrightTokens = input.copyrightTokens?.filter(tag => keys.has(normalizeKey(tag))) ?? []
  return { tags: [...tags], ...(characterTokens.length ? { characterTokens } : {}), ...(copyrightTokens.length ? { copyrightTokens } : {}) }
}

/** Runtime-only scene variation; never writes the source scene/catalog. */
export interface DraftRandomVariation {
  context: string
  source: string
  prompt: string
  prose: string
  tags: string[]
  outfit: string[]
}

export interface PromptBuilderDraft {
  randomVariation?: DraftRandomVariation | null
  sceneStyleBaseline?: { shot: string | null; lighting: string | null; composition: string | null; colorMood: string | null }
  updatedAt: number
  story?: string
  visualDescription?: string
  char?: DraftCharKey
  sceneId?: string | null
  sceneTitle?: string | null
  selections?: Partial<DraftSelections>
  colorMood?: string | null
  manualTags?: string[]
  outfitOverride?: DraftOutfitOverride | null
  referenceInput?: DraftReferenceInput | null
  artistStyleIds?: string[]
  sceneBaseStory?: string
  directorMode?: 'basic' | 'pro'
  sdParams?: Partial<SDParams>
  /** 2026-08-16 审计：用户手动确认过的出图参数键——恢复草稿时若不同步恢复
   *  touched 集合，后续 applyModelProfile 会把恢复值当默认值静默覆盖。 */
  sdParamsTouched?: string[]
  projectId?: string
  /** 热门角色无 LoRA 创作模式（旧草稿缺省为 studio，向后兼容）。 */
  subject?: 'studio' | 'popular'
  characterId?: string
  outfitId?: string
  outfitExplicit?: boolean
  blueprintId?: string | null
  noLora?: boolean
}

export interface PromptPreset {
  id: string
  name: string
  label: string
  [key: string]: unknown
}

export interface RestoredHistoryContext<TScene extends { id: string }> {
  scene: TScene | null
  story: string
}

const SD_PARAM_KEYS = new Set<keyof SDParams>([
  'cfg', 'steps', 'sampler', 'scheduler', 'size', 'hiresFix', 'hiresScale',
  'hiresUpscaler', 'hiresSteps', 'hiresDenoise', 'faceDetailer', 'seedLock',
  'seed', 'quality', 'tail', 'negative', 'negativeCustom',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function isSDParamKey(key: string): key is keyof SDParams {
  return SD_PARAM_KEYS.has(key as keyof SDParams)
}

/** Resolve the scene first; callers apply the returned story after loadScene(). */
export function restoreHistorySceneStory<TScene extends { id: string }>(
  entry: unknown,
  scenes: TScene[],
): RestoredHistoryContext<TScene> {
  const record = isRecord(entry) ? entry : {}
  const sceneId = stringValue(record.scene)
  const scene = sceneId ? (scenes.find(item => item.id === sceneId) ?? null) : null
  return { scene, story: stringValue(record.story) || '' }
}
