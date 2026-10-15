import type { GeneratedArtworkInput } from '@/application/artwork/artworkSaveInput'
import { fetchRuntimeResult, runtimeResultPath } from '@/api/runtimeTasks'
import { artworkRepository, type ArtworkRepository } from '@/storage/artworkRepository'
import { getDesktopRuntime } from '@/platform/desktop/runtime'
import { registerMigrationArtworkSource } from '@/platform/web/migrationBarrier'
import { usePromptHistoryStore } from '@/stores/promptHistoryStore'
import type { HistoryEntry } from '@/types/promptHistory'
import type { BatchDrawRunnerInput, BatchDrawRunnerResult } from '../generation/useBatchDraw'

export type BatchArtworkSource = { kind: 'task'; taskId: string } | { kind: 'image'; entry: GeneratedArtworkInput }
export type PendingBatchSave = { source: BatchArtworkSource; repository: ArtworkRepository; authority: string;
  runtimeOwned: boolean; preview?: Blob; saved?: HistoryEntry }
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
export const ownsPendingSave = (pending: Pick<PendingBatchSave, 'repository' | 'authority'>) => pending.repository === artworkRepository && pending.authority === batchSaveAuthority()
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
  let saved = pending.saved ?? null
  if (!saved) {
    try {
      if (pending.source.kind === 'task') {
        const { persistTaskArtwork } = await import('./persistPromptArtwork')
        saved = await persistTaskArtwork(pending.source.taskId, 0, usePromptHistoryStore(), pending.repository, pending.authority)
      } else saved = await commit(pending.source.entry, pending.repository)
    } catch { /* Keep the original result and request identity for save-only recovery. */ }
    if (saved) { pending.saved = saved; updateArtworkSource() }
  }
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
