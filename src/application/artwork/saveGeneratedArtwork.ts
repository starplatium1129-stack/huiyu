import { PendingMediaUploadError } from './mediaUpload.ts'
import type { HistoryEntry } from '@/types/promptHistory'
import type { ArtworkSaveSnapshot, GeneratedArtworkInput, LegacyArtworkDefaults, SaveGeneratedArtworkDependencies, SaveGeneratedArtworkResult } from './artworkSaveInput'

function assembleRecord(entry: GeneratedArtworkInput, defaults: LegacyArtworkDefaults,
  imageId: string, measured: { width: number | null; height: number | null }, now: number, id: number,
  normalizeStyles: (value: unknown) => string[]): HistoryEntry {
  const currentSubject = defaults.subject
  const isPopular = currentSubject.kind === 'popular'
  return {
    id, timestamp: now,
    character: entry.character ?? defaults.character,
    scene: isPopular ? (currentSubject.blueprintId ?? null) : (entry.scene !== undefined ? entry.scene : defaults.scene),
    sceneTitle: entry.sceneTitle !== undefined ? entry.sceneTitle : defaults.sceneTitle,
    story: entry.story ?? defaults.story,
    visualDescription: entry.visualDescription ?? defaults.visualDescription,
    prompt: entry.prompt, negative: entry.negative ?? '', seed: entry.seed ?? defaults.seed,
    emotion: [...(entry.emotion ?? defaults.emotion)],
    shot: entry.shot !== undefined ? entry.shot : defaults.shot,
    lighting: entry.lighting !== undefined ? entry.lighting : defaults.lighting,
    composition: entry.composition !== undefined ? entry.composition : defaults.composition,
    colorMood: entry.colorMood !== undefined ? entry.colorMood : defaults.colorMood,
    manual_tags: [...(entry.manual_tags ?? defaults.manual_tags)],
    lora: isPopular ? null : ((entry.lora !== undefined ? entry.lora : defaults.lora) || null),
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

/** The caller already owns a detached snapshot. Load this implementation only when saving. */
export function saveArtworkSnapshot({ entry, defaults }: ArtworkSaveSnapshot, deps: SaveGeneratedArtworkDependencies): Promise<SaveGeneratedArtworkResult> {
  return deps.withStaging(async () => {
    let imageId = ''
    let pendingEntry: HistoryEntry | undefined
    const operationId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `artwork-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    try {
      imageId = await deps.putImage(entry.blob)
      // Thumbnails are derived, best-effort data; production already swallows their failures.
      void deps.cacheThumbnail(imageId, entry.blob).catch(() => {})
      const measured = await deps.measureBlob(entry.blob)
      const now = deps.now()
      const id = deps.nextId(now)
      const historyEntry = assembleRecord(entry, defaults, imageId, measured, now, id, deps.normalizeArtistStyleIds)
      pendingEntry = historyEntry
      await deps.appendArtwork(historyEntry)
      return { ok: true, entry: historyEntry }
    } catch (error) {
      // Append rejection can mean a lost acknowledgement after commit. Read back
      // by identity, or retain the image when the outcome remains unknown.
      if (pendingEntry) {
        try {
          const saved = await deps.readArtwork(pendingEntry.id)
          if (saved && String(saved.id).trim() === String(pendingEntry.id).trim() && saved.image_id === imageId) {
            return { ok: true, entry: pendingEntry }
          }
        } catch { /* An unreadable store cannot prove rollback. */ }
        return { ok: false, error, operationId, cleanup: { status: 'commit-unknown' as const, imageId } }
      }
      // Preserve existing owned-image compensation, but return its outcome with
      // an operation ID so cleanup failure is diagnosable and can be retried.
      if (!imageId && error instanceof PendingMediaUploadError) {
        return { ok: false, error, operationId: error.pending.operationId,
          cleanup: { status: 'upload-pending' as const, imageId: error.pending.imageId, upload: error.pending } }
      }
      if (!imageId) return { ok: false, error, operationId, cleanup: { status: 'not-needed' as const } }
      try {
        await deps.deleteImage(imageId)
        return { ok: false, error, operationId, cleanup: { status: 'completed' as const, imageId } }
      } catch (cleanupError) {
        console.warn('[artwork] owned image cleanup pending', { operationId, imageId })
        return { ok: false, error, operationId, cleanup: { status: 'failed' as const, imageId, error: cleanupError } }
      }
    }
  })
}
