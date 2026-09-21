import type { HistoryEntry } from '@/types/promptHistory'
import type { AnimaResultContext } from '@/types/anima'
import type { ArtworkRecord } from '@/types/artwork'
import { historyFromResultContext } from '@/utils/resultContext'

/** Existing commit input; callers can keep their snapshots and parent identity unchanged. */
export type GeneratedArtworkInput = Partial<HistoryEntry> & {
  blob: Blob
  prompt: string
  context?: AnimaResultContext | null
  /** Source artwork for inpaint/variants; both legacy ID representations remain valid. */
  parentId?: string | number | null
}

/** Compatibility defaults are captured once at save invocation, before any asynchronous work. */
export type LegacyArtworkDefaults = Readonly<Required<Pick<HistoryEntry,
  'character' | 'scene' | 'sceneTitle' | 'story' | 'visualDescription' | 'seed' | 'shot' | 'lighting'
  | 'composition' | 'colorMood' | 'lora' | 'cfg' | 'steps' | 'sampler' | 'scheduler' | 'model' | 'size'
  | 'hiresFix' | 'hiresScale' | 'hiresUpscaler' | 'hiresSteps' | 'hiresDenoise' | 'faceDetailer' | 'project'
>> & {
  subject: Readonly<{ kind: 'studio' } | { kind: 'popular'; characterId: string; outfitId: string; blueprintId?: string | null }>
  emotion: readonly string[]
  manual_tags: ReadonlySet<string> | readonly string[]
  artistStyleIds: readonly string[]
}>

export interface SaveGeneratedArtworkDependencies {
  withStaging: (work: () => Promise<SaveGeneratedArtworkResult>) => Promise<SaveGeneratedArtworkResult>
  putImage: (blob: Blob) => Promise<string>
  deleteImage: (id: string) => Promise<void>
  cacheThumbnail: (id: string, blob: Blob) => Promise<void>
  measureBlob: (blob: Blob) => Promise<{ width: number | null; height: number | null }>
  now: () => number
  nextId: (now: number) => number
  resolveLegacyDefaults: (entry: GeneratedArtworkInput) => LegacyArtworkDefaults
  normalizeArtistStyleIds: (value: unknown) => string[]
  appendArtwork: (entry: HistoryEntry) => Promise<unknown[]>
}

export type SaveGeneratedArtworkResult =
  | { ok: true; entry: HistoryEntry; history: ArtworkRecord[] }
  | { ok: false; error: unknown; operationId: string; cleanup: { status: 'not-needed' | 'completed' | 'failed'; imageId?: string; error?: unknown } }


export interface ArtworkSaveSnapshot { entry: GeneratedArtworkInput; defaults: LegacyArtworkDefaults }

/** Capture before loading the persistence implementation or awaiting any storage lease. */
export function prepareGeneratedArtwork(input: GeneratedArtworkInput, resolveDefaults: SaveGeneratedArtworkDependencies['resolveLegacyDefaults']): ArtworkSaveSnapshot {
  const merged = { ...input, ...historyFromResultContext(input.context) }
  const entry: GeneratedArtworkInput = { ...merged,
    emotion: merged.emotion ? [...merged.emotion] : merged.emotion,
    manual_tags: merged.manual_tags ? [...merged.manual_tags] : merged.manual_tags,
    artistStyleIds: merged.artistStyleIds ? [...merged.artistStyleIds] : merged.artistStyleIds,
    loras: merged.loras?.map(lora => ({ ...lora })),
  }
  const resolved = resolveDefaults(entry)
  const defaults: LegacyArtworkDefaults = { ...resolved, subject: { ...resolved.subject },
    emotion: [...resolved.emotion], manual_tags: [...resolved.manual_tags], artistStyleIds: [...resolved.artistStyleIds] }
  return { entry, defaults }
}
