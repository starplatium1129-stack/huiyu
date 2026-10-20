import { PendingMediaUploadError } from './mediaUpload.ts'
import { ArtworkSaveSupersededError } from './artworkSaveInput'
import { parseOutfitOverride } from '@/utils/promptBuilderPersistence'
import type { HistoryEntry } from '@/types/promptHistory'
import type { ArtworkCommitIdentity, ArtworkSaveSnapshot, GeneratedArtworkInput, LegacyArtworkDefaults, SaveGeneratedArtworkDependencies, SaveGeneratedArtworkResult } from './artworkSaveInput'

interface SaveState {
  phase: 'fresh' | 'prepared' | 'unknown' | 'saved'
  everAdmitted: boolean
  imageId: string
  operationId: string
  pending?: ArtworkCommitIdentity
  saved?: HistoryEntry
  flight?: Promise<SaveGeneratedArtworkResult>
}
const states = new WeakMap<ArtworkSaveSnapshot, SaveState>()
const detached = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

function assembleRecord(entry: GeneratedArtworkInput, defaults: LegacyArtworkDefaults,
  imageId: string, measured: { width: number | null; height: number | null }, now: number, id: number,
  normalizeStyles: (value: unknown) => string[]): HistoryEntry {
  const currentSubject = defaults.subject
  const isPopular = currentSubject.kind === 'popular'
  const recordedLora = Boolean(entry.lora || entry.loraId || entry.loras?.length)
  return {
    id, timestamp: now,
    character: entry.character ?? defaults.character,
    scene: isPopular ? (currentSubject.blueprintId ?? null) : (entry.scene !== undefined ? entry.scene : defaults.scene),
    sceneTitle: entry.sceneTitle !== undefined ? entry.sceneTitle : defaults.sceneTitle,
    story: entry.story ?? defaults.story,
    visualDescription: entry.visualDescription ?? defaults.visualDescription,
    prompt: entry.prompt, negative: entry.negative ?? '', seed: entry.seed ?? defaults.seed,
    negativeCustom: entry.negativeCustom,
    emotion: [...(entry.emotion ?? defaults.emotion)],
    shot: entry.shot !== undefined ? entry.shot : defaults.shot,
    lighting: entry.lighting !== undefined ? entry.lighting : defaults.lighting,
    composition: entry.composition !== undefined ? entry.composition : defaults.composition,
    colorMood: entry.colorMood !== undefined ? entry.colorMood : defaults.colorMood,
    manual_tags: [...(entry.manual_tags ?? defaults.manual_tags)],
    lora: (entry.lora !== undefined ? entry.lora : isPopular ? entry.loraId : defaults.lora) || null,
    cfg: entry.cfg ?? defaults.cfg, steps: entry.steps ?? defaults.steps,
    sampler: entry.sampler ?? defaults.sampler, scheduler: entry.scheduler ?? defaults.scheduler,
    checkpoint: entry.model ?? defaults.model, size: entry.size ?? defaults.size,
    engine: entry.engine ?? 'sd', profile: entry.profile ?? '', model: entry.model ?? defaults.model,
    provider: entry.provider,
    loraId: entry.loraId ?? null, loraStrength: entry.loraStrength ?? null,
    loras: Object.freeze((entry.loras ?? []).map(lora => Object.freeze({ id: lora.id, strength: lora.strength }))),
    hiresFix: entry.hiresFix ?? defaults.hiresFix, hiresScale: entry.hiresScale ?? defaults.hiresScale,
    hiresUpscaler: entry.hiresUpscaler ?? defaults.hiresUpscaler, hiresSteps: entry.hiresSteps ?? defaults.hiresSteps,
    hiresDenoise: entry.hiresDenoise ?? defaults.hiresDenoise, faceDetailer: entry.faceDetailer ?? defaults.faceDetailer,
    sketchControl: entry.sketchControl ? { ...entry.sketchControl } : undefined,
    sketchControlModel: entry.sketchControlModel ? { ...entry.sketchControlModel } : undefined,
    regions: entry.regions?.map(region => ({ ...region })),
    width: measured.width, height: measured.height,
    rating: {}, favorite: false, notes: '', image_id: imageId, image_url: '',
    version: 1, parent_id: entry.parentId ?? null, project: entry.project ?? defaults.project,
    subject: isPopular ? 'popular' : 'studio',
    characterId: isPopular ? currentSubject.characterId : undefined,
    outfitId: isPopular ? currentSubject.outfitId : undefined,
    outfitExplicit: isPopular ? entry.outfitExplicit ?? currentSubject.outfitExplicit : undefined,
    outfitOverride: isPopular ? parseOutfitOverride(entry.outfitOverride) : undefined,
    blueprintId: isPopular ? currentSubject.blueprintId : undefined,
    noLora: entry.noLora ?? (isPopular && !recordedLora), styleLoraId: entry.styleLoraId ?? null,
    artistStyleIds: normalizeStyles(entry.artistStyleIds ?? defaults.artistStyleIds),
  }
}

/** The caller already owns a detached snapshot. Load this implementation only when saving. */
export function saveArtworkSnapshot(snapshot: ArtworkSaveSnapshot, deps: SaveGeneratedArtworkDependencies): Promise<SaveGeneratedArtworkResult> {
  const { entry, defaults } = snapshot
  let state = states.get(snapshot)
  if (!state) {
    const pending = entry.pendingCommit ? detached(entry.pendingCommit) : undefined
    const operationId = pending?.operationId ?? (typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `artwork-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`)
    state = { phase: pending ? 'unknown' : 'fresh', everAdmitted: Boolean(pending), imageId: pending?.entry.image_id ?? '', operationId, pending }
    states.set(snapshot, state)
  }
  if (state.flight) return state.flight
  const owned = state
  const failure = (error: unknown, status: 'commit-unknown' | 'identity-pending'): SaveGeneratedArtworkResult =>
    ({ ok: false, error, operationId: owned.operationId, cleanup: { status, imageId: owned.imageId } })
  const success = (): SaveGeneratedArtworkResult => ({ ok: true, entry: detached(owned.saved!) })
  const reconcile = async (): Promise<SaveGeneratedArtworkResult | null> => {
    const pending = owned.pending!
    let saved
    try { saved = await deps.readArtwork(pending.entry.id) }
    catch (error) { return failure(error, 'commit-unknown') }
    if (saved) {
      if (String(saved.id).trim() !== String(pending.entry.id).trim() || saved.image_id !== owned.imageId)
        return failure(new Error('原作品编号对应另一张图片，已停止入册；请核对作品册'), 'commit-unknown')
      owned.saved = pending.entry; owned.phase = 'saved'
      return success()
    }
    owned.phase = 'prepared'
    return null
  }
  const work = deps.withStaging(async () => {
    if (owned.phase === 'saved') return success()
    if (owned.phase === 'unknown') {
      const result = await reconcile()
      if (result) return result
    }
    try {
      if (!owned.pending) {
        // A previous pre-assembly cleanup failure cannot create another alias.
        if (owned.imageId) { await deps.deleteImage(owned.imageId); owned.imageId = '' }
        owned.imageId = await deps.putImage(entry.blob)
        void deps.cacheThumbnail(owned.imageId, entry.blob).catch(() => {})
        const measured = await deps.measureBlob(entry.blob), now = deps.now(), id = deps.nextId(now)
        const assembled = assembleRecord(entry, defaults, owned.imageId, measured, now, id, deps.normalizeArtistStyleIds)
        // Desktop append derives exactly this operation ID from the record ID.
        owned.operationId = `artwork:${String(id)}`
        owned.pending = { operationId: owned.operationId, entry: assembled }; owned.phase = 'prepared'
      }
      // Preserve the same record/alias across marker retries. A previous append
      // can still be running even when reconciliation currently finds no row.
      if (entry.beforeAppend) {
        try { await entry.beforeAppend(detached(owned.pending)) }
        catch (error) {
          if (error instanceof ArtworkSaveSupersededError && error.releaseImage && !owned.everAdmitted) {
            const imageId = owned.imageId
            try {
              await deps.deleteImage(imageId); owned.imageId = ''; owned.pending = undefined; owned.phase = 'fresh'
              return { ok: false, error, operationId: owned.operationId, cleanup: { status: 'completed', imageId } }
            } catch (cleanupError) {
              return { ok: false, error, operationId: owned.operationId, cleanup: { status: 'failed', imageId, error: cleanupError } }
            }
          }
          return failure(error, owned.everAdmitted ? 'commit-unknown' : 'identity-pending')
        }
      }
      owned.phase = 'unknown'
      owned.everAdmitted = true
      await deps.appendArtwork(detached(owned.pending.entry))
      owned.saved = owned.pending.entry; owned.phase = 'saved'
      return success()
    } catch (error) {
      if (owned.pending) {
        const result = await reconcile()
        if (result) return result
        // Absence at this read does not prove an admitted worker has stopped.
        // Retry must reconcile again and retain the same append identity.
        owned.phase = 'unknown'
        return failure(error, 'commit-unknown')
      }
      // Preserve existing owned-image compensation, but return its outcome with
      // an operation ID so cleanup failure is diagnosable and can be retried.
      if (!owned.imageId && error instanceof PendingMediaUploadError) {
        return { ok: false, error, operationId: error.pending.operationId,
          cleanup: { status: 'upload-pending' as const, imageId: error.pending.imageId, upload: error.pending } }
      }
      if (!owned.imageId) return { ok: false, error, operationId: owned.operationId, cleanup: { status: 'not-needed' as const } }
      try {
        const imageId = owned.imageId
        await deps.deleteImage(imageId); owned.imageId = ''
        return { ok: false, error, operationId: owned.operationId, cleanup: { status: 'completed' as const, imageId } }
      } catch (cleanupError) {
        console.warn('[artwork] owned image cleanup pending', { operationId: owned.operationId, imageId: owned.imageId })
        return { ok: false, error, operationId: owned.operationId, cleanup: { status: 'failed' as const, imageId: owned.imageId, error: cleanupError } }
      }
    }
  })
  owned.flight = work.finally(() => { owned.flight = undefined })
  return owned.flight
}
