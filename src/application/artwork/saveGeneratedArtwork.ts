import type { HistoryEntry } from '@/types/promptHistory'
import type { AnimaResultContext } from '@/types/anima'
import { parseArtworkRecords, type ArtworkRecord } from '@/types/artwork'
import { historyFromResultContext } from '@/utils/resultContext'

/** Existing commit input; callers can keep their snapshots and parent identity unchanged. */
export type GeneratedArtworkInput = Partial<HistoryEntry> & {
  blob: Blob
  prompt: string
  context?: AnimaResultContext | null
  /** Source artwork for inpaint/variants; both legacy ID representations remain valid. */
  parentId?: string | number | null
}

/** Explicit compatibility defaults. The store resolves these at the legacy save point. */
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
  | { ok: false; error: unknown }

function assembleRecord(entry: GeneratedArtworkInput, defaults: LegacyArtworkDefaults,
  imageId: string, measured: { width: number | null; height: number | null }, now: number, id: number,
  normalizeStyles: (value: unknown) => string[]): HistoryEntry {
  const currentSubject = defaults.subject
  const isPopular = currentSubject.kind === 'popular'
  return {
    id, timestamp: now,
    character: entry.character ?? defaults.character,
    scene: isPopular ? (currentSubject.blueprintId ?? null) : (entry.scene !== undefined ? entry.scene : defaults.scene),
    sceneTitle: entry.sceneTitle ?? defaults.sceneTitle,
    story: entry.story ?? defaults.story,
    visualDescription: entry.visualDescription ?? defaults.visualDescription,
    prompt: entry.prompt, negative: entry.negative ?? '', seed: entry.seed ?? defaults.seed,
    emotion: [...(entry.emotion ?? defaults.emotion)],
    shot: entry.shot !== undefined ? entry.shot : defaults.shot,
    lighting: entry.lighting !== undefined ? entry.lighting : defaults.lighting,
    composition: entry.composition !== undefined ? entry.composition : defaults.composition,
    colorMood: entry.colorMood !== undefined ? entry.colorMood : defaults.colorMood,
    manual_tags: [...(entry.manual_tags ?? defaults.manual_tags)],
    lora: isPopular ? null : ((entry.lora ?? defaults.lora) || null),
    cfg: entry.cfg ?? defaults.cfg, steps: entry.steps ?? defaults.steps,
    sampler: entry.sampler ?? defaults.sampler, scheduler: entry.scheduler ?? defaults.scheduler,
    checkpoint: entry.model ?? defaults.model, size: entry.size ?? defaults.size,
    engine: entry.engine ?? 'sd', profile: entry.profile ?? '', model: entry.model ?? defaults.model,
    loraId: isPopular ? null : (entry.loraId ?? null), loraStrength: isPopular ? null : (entry.loraStrength ?? null),
    loras: isPopular ? [] : Object.freeze((entry.loras ?? []).map(lora => Object.freeze({ id: lora.id, strength: lora.strength }))),
    hiresFix: entry.hiresFix ?? defaults.hiresFix, hiresScale: entry.hiresScale ?? defaults.hiresScale,
    hiresUpscaler: entry.hiresUpscaler ?? defaults.hiresUpscaler, hiresSteps: entry.hiresSteps ?? defaults.hiresSteps,
    hiresDenoise: entry.hiresDenoise ?? defaults.hiresDenoise, faceDetailer: entry.faceDetailer ?? defaults.faceDetailer,
    width: measured.width, height: measured.height,
    rating: {}, favorite: false, notes: '', image_id: imageId, image_url: '',
    version: 1, parent_id: entry.parentId ?? null, project: entry.project ?? defaults.project,
    subject: isPopular ? 'popular' : 'studio',
    characterId: isPopular ? currentSubject.characterId : undefined,
    outfitId: isPopular ? currentSubject.outfitId : undefined,
    blueprintId: isPopular ? currentSubject.blueprintId : undefined,
    noLora: isPopular, styleLoraId: entry.styleLoraId ?? null,
    artistStyleIds: normalizeStyles(entry.artistStyleIds ?? defaults.artistStyleIds),
  }
}

/** No store, database driver or notification dependency. Staging wraps image creation through commit. */
export function saveGeneratedArtwork(input: GeneratedArtworkInput, deps: SaveGeneratedArtworkDependencies): Promise<SaveGeneratedArtworkResult> {
  return deps.withStaging(async () => {
    let imageId = ''
    const entry = { ...input, ...historyFromResultContext(input.context) }
    try {
      imageId = await deps.putImage(entry.blob)
      // Thumbnails are derived, best-effort data; production already swallows their failures.
      void deps.cacheThumbnail(imageId, entry.blob).catch(() => {})
      const measured = await deps.measureBlob(entry.blob)
      const now = deps.now()
      const id = deps.nextId(now)
      const defaults = deps.resolveLegacyDefaults(entry)
      const historyEntry = assembleRecord(entry, defaults, imageId, measured, now, id, deps.normalizeArtistStyleIds)
      const history = parseArtworkRecords(await deps.appendArtwork(historyEntry))
      return { ok: true, entry: historyEntry, history }
    } catch (error) {
      // Preserve existing owned-image compensation and its timing. This is not an
      // ambiguous-commit recovery protocol, nor a guarantee that cleanup succeeded.
      if (imageId) void deps.deleteImage(imageId).catch(() => {})
      return { ok: false, error }
    }
  })
}
