import type { PendingMediaUpload } from './mediaUpload.ts'
import type { HistoryEntry } from '@/types/promptHistory'
import type { AnimaResultContext } from '@/types/anima'
import type { ArtworkRecord } from '@/types/artwork'
import { historyFromResultContext } from '@/utils/resultContext'
import { parseOutfitOverride } from '@/utils/promptBuilderPersistence'
import { normalizeDirectorSources } from '@/utils/promptDirector'
import type { DirectorControlSources } from '@/types/promptDirector'

/** Existing commit input; callers can keep their snapshots and parent identity unchanged. */
export type GeneratedArtworkInput = Partial<HistoryEntry> & {
  blob: Blob
  prompt: string
  context?: AnimaResultContext | null
  /** Source artwork for inpaint/variants; both legacy ID representations remain valid. */
  parentId?: string | number | null
  taskId?: string
  resultIndex?: number
  pendingCommit?: ArtworkCommitIdentity
  beforeAppend?: (pending: ArtworkCommitIdentity) => Promise<void>
}

/** Compatibility defaults are captured once at save invocation, before any asynchronous work. */
export type LegacyArtworkDefaults = Readonly<Required<Pick<HistoryEntry,
  'character' | 'scene' | 'sceneTitle' | 'story' | 'visualDescription' | 'seed' | 'shot' | 'lighting'
  | 'composition' | 'colorMood' | 'lora' | 'cfg' | 'steps' | 'sampler' | 'scheduler' | 'model' | 'size'
  | 'hiresFix' | 'hiresScale' | 'hiresUpscaler' | 'hiresSteps' | 'hiresDenoise' | 'faceDetailer' | 'project'
>> & {
  subject: Readonly<{ kind: 'studio' } | { kind: 'popular'; characterId: string; outfitId: string; blueprintId?: string | null; outfitExplicit?: boolean }>
  emotion: readonly string[]
  manual_tags: ReadonlySet<string> | readonly string[]
  artistStyleIds: readonly string[]
  directorSources: Readonly<DirectorControlSources>
}>

export interface SaveGeneratedArtworkDependencies {
  withStaging: (work: () => Promise<SaveGeneratedArtworkResult>) => Promise<SaveGeneratedArtworkResult>
  putImage: (blob: Blob) => Promise<string>
  deleteImage: (id: string) => Promise<void>
  cacheThumbnail: (id: string, blob: Blob) => Promise<void>
  measureBlob: (blob: Blob) => Promise<{ width: number | null; height: number | null }>
  now: () => number
  nextId: (now: number) => number
  normalizeArtistStyleIds: (value: unknown) => string[]
  readArtwork: (id: string | number) => Promise<ArtworkRecord | null>
  appendArtwork: (entry: HistoryEntry) => Promise<void>
}

export type SaveGeneratedArtworkResult =
  | { ok: true; entry: HistoryEntry }
  | { ok: false; error: unknown; operationId: string; cleanup: { status: 'not-needed' | 'completed' | 'failed' | 'commit-unknown' | 'identity-pending' | 'upload-pending'; imageId?: string; error?: unknown; upload?: PendingMediaUpload } }


export interface ArtworkSaveSnapshot { entry: GeneratedArtworkInput; defaults: LegacyArtworkDefaults }
export interface ArtworkCommitIdentity { operationId: string; entry: HistoryEntry }
/** Draft boundaries retain only the existing structured append identity. */
export function isArtworkCommitIdentity(value: unknown): value is ArtworkCommitIdentity {
  if (!value || typeof value !== 'object') return false
  const pending = value as Partial<ArtworkCommitIdentity>, entry = pending.entry as (HistoryEntry & Record<string, unknown>) | undefined
  return Boolean(entry && typeof entry === 'object' && (typeof entry.id === 'string' || typeof entry.id === 'number' && Number.isFinite(entry.id))
    && typeof entry.image_id === 'string' && entry.image_id && typeof entry.prompt === 'string'
    && pending.operationId === `artwork:${String(entry.id)}` && !('blob' in entry) && !entry.image_data
    && (!entry.image_url || !/^(blob:|data:)/.test(entry.image_url)))
}
export class ArtworkSaveSupersededError extends Error {
  constructor(readonly releaseImage: boolean) { super('当前画面已变化，已停止尚未提交的入册'); this.name = 'AbortError' }
}
const snapshots = new WeakMap<GeneratedArtworkInput, ArtworkSaveSnapshot>()

/** Capture before loading the persistence implementation or awaiting any storage lease. */
export function prepareGeneratedArtwork(input: GeneratedArtworkInput, resolveDefaults: (entry: GeneratedArtworkInput) => LegacyArtworkDefaults): ArtworkSaveSnapshot {
  const previous = snapshots.get(input)
  if (previous) return previous
  const merged = { ...input, ...historyFromResultContext(input.context) }
  const entry: GeneratedArtworkInput = { ...merged,
    emotion: merged.emotion ? [...merged.emotion] : merged.emotion,
    manual_tags: merged.manual_tags ? [...merged.manual_tags] : merged.manual_tags,
    artistStyleIds: merged.artistStyleIds ? [...merged.artistStyleIds] : merged.artistStyleIds,
    directorSources: merged.directorSources === undefined ? undefined : normalizeDirectorSources(merged.directorSources),
    outfitOverride: merged.outfitOverride === undefined ? undefined : parseOutfitOverride(merged.outfitOverride),
    loras: merged.loras?.map(lora => ({ ...lora })),
    sketchControl: merged.sketchControl ? { ...merged.sketchControl } : undefined,
    sketchControlModel: merged.sketchControlModel ? { ...merged.sketchControlModel } : undefined,
    regions: merged.regions?.map(region => ({ ...region })),
    pendingCommit: merged.pendingCommit ? JSON.parse(JSON.stringify(merged.pendingCommit)) as ArtworkCommitIdentity : undefined,
  }
  const resolved = resolveDefaults(entry)
  const defaults: LegacyArtworkDefaults = { ...resolved, subject: { ...resolved.subject }, directorSources: normalizeDirectorSources(resolved.directorSources),
    emotion: [...resolved.emotion], manual_tags: [...resolved.manual_tags], artistStyleIds: [...resolved.artistStyleIds] }
  const snapshot = { entry, defaults }
  snapshots.set(input, snapshot)
  return snapshot
}
