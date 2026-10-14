import type { Ref } from 'vue'
import type { HistoryEntry } from '../../stores/promptBuilderStore'
import type { AnimaResult, AnimaResultContext } from '../../types/anima'
import type { TempResultRecord } from '../../utils/tempResult'
import type { TempResultDeps } from './useTempResult'
import type { GeneratedArtworkInput } from '@/application/artwork/artworkSaveInput'
import { ArtworkSaveSupersededError, type ArtworkCommitIdentity } from '@/application/artwork/artworkSaveInput'
import { artworkRepository, type ArtworkRepository } from '@/storage/artworkRepository'
import { withArtworkStaging } from '@/storage/artworkSession'
import { flushProfileWrites } from '@/platform/web/profileStorage'
import { clearTempResult, readTempResult, sameTempResultOwner, writeTempResultDurable, type TempResultOwner } from '@/utils/tempResult'

/** Media I/O belongs to the already requested completion, not route setup. */
export async function captureTempResult(input: {
  partial: Omit<TempResultRecord, 'imageId' | 'savedAt'>; blob: Blob; repository: ArtworkRepository; owner: TempResultOwner
}, observer: {
  current(): boolean; pending(): ArtworkCommitIdentity | undefined; durable(): void; publish(record: TempResultRecord): void; flash(message: string): void
}) {
  const { repository, owner } = input
  return withArtworkStaging(async () => {
    if (!observer.current()) return
    let imageId = ''
    try {
      const previous = readTempResult()
      if (previous?.pendingCommit) { observer.flash('上次入册回执尚未核对，原恢复指针已保留；可恢复原图继续入册或显式清除'); return }
      if (repository !== artworkRepository || !sameTempResultOwner(owner)) throw new Error('原图属于另一资料来源，请恢复原工作区')
      imageId = await repository.putImage(input.blob)
      if (!observer.current()) { void repository.deleteImage(imageId).catch(() => {}); return }
      const record = { ...input.partial, imageId, savedAt: Date.now(), owner, pendingCommit: observer.pending() }
      await writeTempResultDurable(record)
      const retained = readTempResult()
      if (retained?.imageId === imageId && retained.pendingCommit?.operationId === record.pendingCommit?.operationId
        && repository === artworkRepository && sameTempResultOwner(owner)) observer.durable()
      if (!observer.current()) return
      observer.publish(record)
      if (previous && previous.imageId !== imageId) void repository.deleteImage(previous.imageId).catch(() => {})
    } catch (error) {
      if (imageId) {
        try {
          const retained = readTempResult()
          if (retained?.imageId !== imageId && retained?.pendingCommit?.entry.image_id !== imageId) void repository.deleteImage(imageId).catch(() => {})
        } catch { /* An unreadable pointer cannot prove that this alias is unreferenced. */ }
      }
      console.warn('[temp-result] capture failed', error)
      if (observer.current()) observer.flash('临时成片保存失败：请入册，或下载原图后明确清除，再离开')
    }
  })
}

/** The caller captured the pointer and authority before loading this action. */
export async function releaseTempResult(input: {
  record: TempResultRecord | null; repository: ArtworkRepository; owner: TempResultOwner; revision: number; saved?: Pick<HistoryEntry, 'image_id'>
}, state: { mutation(): number; claim(): number; cleared(): void }) {
  const { record, repository, owner, revision, saved } = input
  const latest = readTempResult()
  if (revision !== state.mutation() || repository !== artworkRepository || !sameTempResultOwner(owner)
    || latest?.imageId !== record?.imageId || latest?.pendingCommit?.operationId !== record?.pendingCommit?.operationId) return
  const mutation = state.claim()
  if (!clearTempResult()) throw new Error('临时成片清除尚未写入，恢复指针已保留')
  await flushProfileWrites()
  if (repository !== artworkRepository || !sameTempResultOwner(owner)) return
  if (mutation === state.mutation() && !readTempResult()) state.cleared()
  // Absence cannot prove that an admitted append worker has stopped. Normal
  // library/operation retention owns pending aliases even after explicit discard.
  const pendingAlias = record?.pendingCommit?.entry.image_id
  if (record && record.imageId !== saved?.image_id && !(record.pendingCommit && record.imageId === pendingAlias))
    void repository.deleteImage(record.imageId).catch(() => {})
}

/** One pinned flight supplies its own observer; later remounts cannot replace it. */
export async function admitTempResultSave(pending: ArtworkCommitIdentity, input: {
  repository: ArtworkRepository; owner: TempResultOwner; url: string; partial: Omit<TempResultRecord, 'imageId' | 'savedAt'>;
  record: TempResultRecord | null; capturedMutation: number
}, state: {
  current(): boolean; mutation(): number; claim(): number; storedUrl(): string; retainedSource(): boolean;
  markerStable(): void; durable(): void; publish(record: TempResultRecord | null): void
}) {
  const { repository, owner, record, url, partial, capturedMutation } = input
  const latest = readTempResult()
  const referenced = latest?.pendingCommit?.operationId === pending.operationId && latest.pendingCommit.entry.image_id === pending.entry.image_id
  const movedPointer = record ? latest?.imageId !== record.imageId : Boolean(latest && capturedMutation !== state.mutation())
  if (!state.current() || repository !== artworkRepository || !sameTempResultOwner(owner) || latest?.pendingCommit && !referenced
    || !referenced && movedPointer && state.storedUrl() !== url)
    throw new ArtworkSaveSupersededError(!referenced && !state.retainedSource())
  const mutation = state.claim()
  const retained = latest && state.storedUrl() === url ? latest : { ...partial, imageId: pending.entry.image_id!, savedAt: Date.now() }
  await writeTempResultDurable({ ...retained, owner, pendingCommit: pending })
  state.markerStable()
  const published = readTempResult()
  const stillReferenced = published?.pendingCommit?.operationId === pending.operationId && published.pendingCommit.entry.image_id === pending.entry.image_id
  if (stillReferenced && repository === artworkRepository && sameTempResultOwner(owner)) state.durable()
  if (!state.current() || mutation !== state.mutation() || repository !== artworkRepository || !sameTempResultOwner(owner) || !stillReferenced)
    throw new ArtworkSaveSupersededError(!stillReferenced && !state.retainedSource())
  state.publish(published)
}

/** Persistence has already captured defaults and started before this action loads. */
export async function finishManualTempSave(outcome: Promise<{ entry: HistoryEntry | null } | { error: unknown }>, view: {
  pb: TempResultDeps['pb']; displayedResultHistoryId: Ref<string | number | null>;
  current(): boolean; releaseTemp(entry: HistoryEntry): Promise<void>; forget(): void
}) {
  const result = await outcome
  if ('error' in result) throw result.error
  const entry = result.entry
  if (!entry) { if (view.current()) view.pb.flash('入册未成功，画面仍在画布上，请重试或下载原图'); return }
  // A completed save belongs to the clicked image, not a newer canvas result.
  if (view.current()) {
    view.displayedResultHistoryId.value = entry.id
    try { await view.releaseTemp(entry) }
    catch { view.pb.flash('画面已入册，临时标记清除尚未确认；恢复连接后可继续核对'); view.forget(); return }
  }
  view.forget()
  if (view.current()) view.pb.flash('画面已存入本地作品册')
}

interface ResultActionOwner {
  pb: TempResultDeps['pb']
  displayedResultHistoryId: Ref<string | number | null>
  captureTemp(partial: Omit<TempResultRecord, 'imageId' | 'savedAt'>, blob: Blob, url: string, current: () => boolean): Promise<void>
  releaseTemp(saved?: HistoryEntry): Promise<void>
  commitResult(entry: GeneratedArtworkInput): Promise<HistoryEntry | null>
}
interface AnimaAutomaticInput {
  result: AnimaResult
  context: AnimaResultContext | null
  current: () => boolean
  history: Partial<HistoryEntry>
  story: string
  scene: TempResultDeps['pb']['sceneId']
  autoSave: boolean
  runtimeTaskId?: string
}

/** Automatic completion actions load only after a result arrives. */
export async function handleAnimaResultAction(input: AnimaAutomaticInput, owner: ResultActionOwner) {
  const { result, current, context: frozen, history, story, scene, autoSave, runtimeTaskId } = input
  const { pb, displayedResultHistoryId, captureTemp, releaseTemp } = owner
  if (!autoSave) {
    if (current()) displayedResultHistoryId.value = null
    await captureTemp({
      engine: result.metadata.engine,
      prompt: result.metadata.prompt,
      negative: result.metadata.negative,
      seed: result.metadata.seed,
      size: `${result.metadata.width}x${result.metadata.height}`,
      animaMetadata: result.metadata,
      context: frozen,
    }, result.blob, result.url, current)
    return
  }
  try {
    if (!result.blob.size) throw new Error('成片数据为空')
    // initImage 非空即 inpaint 重绘：parent_id 回指来源条目，作品册对比才有
    // 「重绘前 vs 重绘后」的真实语义（P1-14）。
    const isInpaint = Boolean(result.metadata.initImage)
    const saved = await owner.commitResult({
      taskId: runtimeTaskId,
      context: frozen,
      blob: result.blob,
      seed: result.metadata.seed,
      negative: result.metadata.negative ?? '',
      prompt: result.metadata.prompt,
      ...history,
      // F3：入册字段跟随出图时的冻结上下文，不随生成期间的表单改动漂移。
      story: frozen?.story ?? story,
      scene: frozen ? (frozen.sceneId ?? null) : scene,
      hiresFix: result.metadata.hiresFix === true,
      hiresScale: typeof result.metadata.hiresScale === 'number' ? result.metadata.hiresScale : undefined,
      hiresDenoise: typeof result.metadata.hiresDenoise === 'number' ? result.metadata.hiresDenoise : undefined,
      parentId: isInpaint ? frozen?.parentId : undefined,
    })
    if (!saved) throw new Error('作品册写入失败')
    if (current()) {
      displayedResultHistoryId.value = saved.id
      try { await releaseTemp(saved); pb.flash('已自动存入作品册') }
      catch { pb.flash('图片已自动入册，临时标记清除尚未确认；恢复连接后可继续核对') }
    }
  } catch (e) {
    console.warn('anima direct autosave failed', e)
    if (!current()) return
    pb.flash('自动入册失败：成片已保留在临时缓冲，可手动点「存入作品册」')
    await captureTemp({
      engine: result.metadata.engine,
      prompt: result.metadata.prompt,
      negative: result.metadata.negative,
      seed: result.metadata.seed,
      size: `${result.metadata.width}x${result.metadata.height}`,
      animaMetadata: result.metadata,
      context: frozen,
    }, result.blob, result.url, current)
  }
}
