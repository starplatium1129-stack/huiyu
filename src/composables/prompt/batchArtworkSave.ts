import { ArtworkSaveSupersededError, type GeneratedArtworkInput } from '@/application/artwork/artworkSaveInput'
import { fetchRuntimeResult, runtimeResultPath } from '@/api/runtimeTasks'
import { artworkRepository, type ArtworkRepository } from '@/storage/artworkRepository'
import { getDesktopRuntime } from '@/platform/desktop/runtime'
import { registerMigrationArtworkSource } from '@/platform/web/migrationBarrier'
import { usePromptHistoryStore } from '@/stores/promptHistoryStore'
import type { HistoryEntry } from '@/types/promptHistory'
import type { BatchDrawRunnerInput, BatchDrawRunnerResult } from '../generation/useBatchDraw'
import { sameTempResultOwner, type TempResultOwner } from '@/utils/tempResult'

export type BatchArtworkSource = { kind: 'task'; taskId: string } | { kind: 'image'; entry: GeneratedArtworkInput }
export type PendingBatchSave = { source: BatchArtworkSource; repository: ArtworkRepository; authority: string;
  owner?: TempResultOwner; runtimeOwned: boolean; preview?: Blob; saved?: HistoryEntry;
  admission?: BatchDrawRunnerInput['commitPrepared']; flight?: Promise<HistoryEntry | null> }
// Route disposal stops observation. Unarchived results keep their original
// request identity until this application session can finish saving them.
export const pendingBatchSaves = new Map<string, PendingBatchSave>()
let releaseArtworkSource: (() => void) | undefined
const hasUndurableBatchSource = () => [...pendingBatchSaves.values()].some(pending => !pending.saved
  && pending.source.kind === 'image' && !(pending.runtimeOwned && pending.source.entry.taskId))
export function updateArtworkSource() {
  if (hasUndurableBatchSource()) releaseArtworkSource ??= registerMigrationArtworkSource(hasUndurableBatchSource)
  else { releaseArtworkSource?.(); releaseArtworkSource = undefined }
}
export function batchSaveAuthority() {
  const workspace = getDesktopRuntime().bootstrap?.runtime?.workspace
  return JSON.stringify([workspace?.workspaceId, workspace?.principalId])
}
export const ownsPendingSave = (pending: Pick<PendingBatchSave, 'repository' | 'authority' | 'owner'>) => pending.repository === artworkRepository
  && pending.authority === batchSaveAuthority() && Boolean(pending.owner && sameTempResultOwner(pending.owner))
export function pendingBatchImage(requestKey: string): Blob | null {
  const pending = pendingBatchSaves.get(requestKey)
  return pending && ownsPendingSave(pending) ? pending.source.kind === 'image' ? pending.source.entry.blob : pending.preview ?? null : null
}

export async function persistBatchArtwork(input: BatchDrawRunnerInput, pending: PendingBatchSave,
  commit: (entry: GeneratedArtworkInput, repository: ArtworkRepository) => Promise<HistoryEntry | null>): Promise<BatchDrawRunnerResult> {
  const key = input.requestKey
  pendingBatchSaves.set(key, pending)
  updateArtworkSource()
  const changed = () => ({ ok: false, unresolved: true, pendingImage: true,
    error: '作品库身份已变化，原图和请求编号已保留；请回到原工作区继续入册' })
  if (!ownsPendingSave(pending)) return changed()
  // A remount waits for the old flight; it cannot authorize that worker with a new callback.
  if (pending.flight) await pending.flight
  if (!ownsPendingSave(pending)) return changed()
  if (!pending.saved) {
    pending.admission = input.commitPrepared
    const save = async () => {
      try {
        if (pending.source.kind === 'task') {
          const { persistTaskArtwork } = await import('./persistPromptArtwork')
          return await persistTaskArtwork(pending.source.taskId, 0, usePromptHistoryStore(), pending.repository, pending.authority)
        }
        pending.source.entry.pendingCommit ??= input.pendingCommit
        pending.source.entry.beforeAppend ??= async identity => {
          const admission = pending.admission
          if (!admission) throw new ArtworkSaveSupersededError(false)
          await admission(identity)
        }
        return await commit(pending.source.entry, pending.repository)
      } catch { return null } // Keep original bytes and identity for save-only recovery.
    }
    pending.flight = save().then(saved => {
      if (saved) { pending.saved = saved; updateArtworkSource() }
      return saved
    }).finally(() => { pending.flight = undefined; pending.admission = undefined })
    await pending.flight
  }
  const saved = pending.saved
  if (!ownsPendingSave(pending)) return changed()
  if (!saved) {
    // The task owns the original. Download only for an unsaved result's preview;
    // cancellation or a failed read must never discard its stable task identity.
    if (pending.source.kind === 'task' && !pending.preview) {
      try {
        const blob = await fetchRuntimeResult(runtimeResultPath(pending.source), input.signal)
        if (ownsPendingSave(pending)) pending.preview = blob
      } catch { /* The durable task remains recoverable without preview bytes. */ }
    }
    if (!ownsPendingSave(pending)) return changed()
    return { ok: false, unresolved: true, pendingImage: true, error: '图片已生成，入册失败；继续会重新保存，不重复出图' }
  }
  pendingBatchSaves.delete(key)
  updateArtworkSource()
  return { ok: true, historyId: saved.id, imageId: saved.image_id }
}
