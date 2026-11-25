import { normalizeKey } from './promptPrimitives.ts'
import { sanitizeOutfitOverride } from './wardrobeContent.ts'
import { parseAssistLayout, type InterrogateAssistLayout, type InterrogateSubjectMode } from '../api/interrogateResult.ts'
import type { DirectorControlSources, DirectorControlValues } from '../types/promptDirector.ts'
import type { CastFormation, CastMember } from '../types/prompt'
import { parseCastFormation, parseCastInteraction, parseCastMember, parseCastMembers, parseLeadPosition } from './promptCast.ts'

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
  presetId?: string
  label?: string
  prose?: string
  suppressedTags?: string[]
}

export function parseOutfitOverride(value: unknown): DraftOutfitOverride | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  const tokens = Array.isArray(input.tokens)
    ? [...new Set(input.tokens.filter((token): token is string => typeof token === 'string').map(token => token.trim()).filter(Boolean))]
    : []
  if (!tokens.length) return null
  const optionalText = (value: unknown, max: number) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : undefined
  const presetId = optionalText(input.presetId, 512), label = optionalText(input.label, 512), prose = optionalText(input.prose, 4000)
  const suppressedTags = Array.isArray(input.suppressedTags)
    ? [...new Set(input.suppressedTags.filter((tag): tag is string => typeof tag === 'string' && !!tag.trim()).map(tag => tag.trim()))].slice(0, 256)
    : []
  return sanitizeOutfitOverride({ tokens, replaced: typeof input.replaced === 'string' ? input.replaced : null,
    ...(presetId ? { presetId } : {}), ...(label ? { label } : {}), ...(prose ? { prose } : {}),
    ...(suppressedTags.length ? { suppressedTags } : {}) })
}

/** Content owned by the active reference picture. User-owned tags are excluded. */
export interface DraftReferenceInput {
  tags: string[]
  /** Original interrogation data. The adopted tags retain their existing edit ownership. */
  rawTags?: string[]
  rawCaption?: string
  sourceIdentityTerms?: string[]
  subjectMode?: InterrogateSubjectMode
  /** A real picture caption. Derived PixAI tag summaries never enter this layer. */
  caption?: string
  /** Earlier engine workflows place the source caption directly in the editable description. */
  captionInEditor?: boolean
  /** Normalized visual layout regions extracted by vision assist for MOSS. */
  layout?: InterrogateAssistLayout
  /** Model categories retained for ordering, including names absent from the local catalogue. */
  characterTokens?: string[]
  copyrightTokens?: string[]
}

/** Clone the reference layer and retire classification for removed source tags. */
export function cloneReferenceInput(input: DraftReferenceInput | null | undefined, tags = input?.tags ?? []): DraftReferenceInput | null {
  const caption = input?.caption?.trim()
  const layout = parseAssistLayout(input?.layout)
  if (!input || (!tags.length && !caption && !layout && !input.rawTags?.length && !input.rawCaption)) return null
  const keys = new Set(tags.map(normalizeKey))
  const characterTokens = input.characterTokens?.filter(tag => keys.has(normalizeKey(tag))) ?? []
  const copyrightTokens = input.copyrightTokens?.filter(tag => keys.has(normalizeKey(tag))) ?? []
  return { tags: [...tags], ...(caption ? { caption, ...(input.captionInEditor ? { captionInEditor: true } : {}) } : {}),
    ...(layout ? { layout } : {}),
    ...(input.subjectMode ? { subjectMode: input.subjectMode } : {}),
    ...(input.rawTags?.length ? { rawTags: [...input.rawTags] } : {}),
    ...(input.rawCaption ? { rawCaption: input.rawCaption } : {}),
    ...(input.sourceIdentityTerms?.length ? { sourceIdentityTerms: [...input.sourceIdentityTerms] } : {}),
    ...(characterTokens.length ? { characterTokens } : {}), ...(copyrightTokens.length ? { copyrightTokens } : {}) }
}

/** Validate stored or imported references before they become editable state. */
export function parseReferenceInput(value: unknown): DraftReferenceInput | null {
  if (!isRecord(value) || Array.isArray(value)) return null
  const strings = (input: unknown) => Array.isArray(input)
    ? input.filter((item): item is string => typeof item === 'string') : []
  return cloneReferenceInput({
    tags: [...new Set(strings(value.tags).map(tag => tag.trim()).filter(Boolean))],
    rawTags: strings(value.rawTags),
    rawCaption: stringValue(value.rawCaption),
    sourceIdentityTerms: strings(value.sourceIdentityTerms),
    caption: stringValue(value.caption),
    captionInEditor: value.captionInEditor === true,
    layout: parseAssistLayout(value.layout) ?? undefined,
    characterTokens: strings(value.characterTokens),
    copyrightTokens: strings(value.copyrightTokens),
    subjectMode: value.subjectMode === 'free' || value.subjectMode === 'bound' ? value.subjectMode : undefined,
  })
}

export type PromptCastSnapshot = {
  coStars?: CastMember[]
  castFormation?: CastFormation
  castInteraction?: string
  leadCast?: CastMember
  leadPosition?: number
}

export function readPromptCastSnapshot(value: unknown): PromptCastSnapshot {
  if (!isRecord(value) || Array.isArray(value)) return {}
  const coStars = parseCastMembers(value.coStars)
  const castFormation = parseCastFormation(value.castFormation)
  const castInteraction = parseCastInteraction(value.castInteraction)
  const leadCast = parseCastMember(value.leadCast)
  const leadPosition = parseLeadPosition(value.leadPosition, coStars.length)
  return { ...(coStars.length ? { coStars } : {}), ...(castFormation ? { castFormation } : {}), ...(castInteraction ? { castInteraction } : {}),
    ...(leadCast ? { leadCast } : {}), ...(leadPosition ? { leadPosition } : {}) }
}

export type ArtworkCastSnapshot = PromptCastSnapshot & {
  coStarIds?: string[]
}

export function readArtworkCastSnapshot(value: unknown): ArtworkCastSnapshot {
  const cast = readPromptCastSnapshot(value)
  const coStarIds = cast.coStars?.filter(member => member.source !== 'custom').map(member => member.characterId)
  return { ...cast, ...(coStarIds?.length ? { coStarIds } : {}) }
}

export function supplementalReferenceCaption(input: DraftReferenceInput | null, description: string): string {
  return input?.caption && !input.captionInEditor && input.caption !== description.trim() ? input.caption : ''
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

export interface PromptBuilderDraft extends PromptCastSnapshot {
  storyOrigin?: import('@/types/storyOrigin').StoryOrigin
  randomVariation?: DraftRandomVariation | null
  sceneStyleBaseline?: DirectorControlValues
  directorSources?: DirectorControlSources
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
