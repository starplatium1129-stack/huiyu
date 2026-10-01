import type { Ref } from 'vue'
import type { TempResultDeps } from './useTempResult'
import { hasRuntimeTasks } from '@/api/runtimeTaskAuthority'
import { runtimeTasks } from '@/stores/runtimeTaskState'
import { artworkRepository } from '@/storage/artworkRepository'
import { clearTempResult, readTempResult } from '@/utils/tempResult'

/** Loaded only to recover an empty canvas. The mounted owner supplies its result revision guard. */
export async function restoreUnarchivedResult(deps: TempResultDeps, storedResultUrl: Ref<string>, current: () => boolean): Promise<boolean> {
  const { pb } = deps
  if (!current()) return false
  if (hasRuntimeTasks()) {
    const { refreshRuntimeTasks, runtimeResultPath, fetchRuntimeResult } = await import('@/api/runtimeTasks')
    await refreshRuntimeTasks().catch(() => {})
    if (!current()) return false
    const task = runtimeTasks.value.find(item => ['generation', 'anima', 'creative'].includes(item.kind) && item.resultState === 'available' && !['saved', 'discarded'].includes(item.deliveryState))
    if (!task) return false
    const blob = await fetchRuntimeResult(runtimeResultPath(task)).catch(() => null)
    if (!blob || !current()) return false
    const { runtimeImageMetadata, runtimeTaskRecipe, runtimeTaskResultContext } = await import('@/utils/runtimeTaskResult')
    if (!current()) return false
    const context = runtimeTaskResultContext(task), recipe = runtimeTaskRecipe(task)
    const url = URL.createObjectURL(blob)
    if (task.kind === 'generation') {
      if (pb.isPopular) pb.setStudioSubject()
      if (context.char === 'nene' || context.char === 'natsume' || context.char === 'triad') pb.setChar(context.char)
      deps.sd.adoptResult(url, recipe.seed ?? null, recipe.prompt ?? '', task.taskId)
      deps.resultContext.value = context; deps.setDrawEngine('sd')
    } else {
      const metadata = runtimeImageMetadata(task)
      deps.patchAnimaState({ result: { url, blob, metadata }, job: metadata, resultContext: context, phase: 'succeeded', progress: 1, statusText: '已从收件箱找回结果' })
      deps.setDrawEngine(task.kind === 'creative' ? 'krea2' : 'anima')
    }
    storedResultUrl.value = url; return true
  }
  const record = readTempResult()
  if (!record) return false
  let blob: Blob | null = null
  try { blob = await artworkRepository.getImage(record.imageId) } catch { /* Read failure leaves no restorable media. */ }
  if (!current()) return false
  if (!blob || !blob.size) { clearTempResult(); return false }
  // Restore the result's subject before the engine's existing compatibility guard.
  if (record.engine === 'sd' && pb.isPopular) pb.setStudioSubject()
  const originChar = record.context?.char
  if (originChar === 'nene' || originChar === 'natsume' || originChar === 'triad') pb.setChar(originChar)
  if (record.engine === 'sd') {
    deps.sd.adoptResult(URL.createObjectURL(blob), record.seed, record.prompt)
    deps.resultContext.value = record.context ?? null
    deps.setDrawEngine('sd')
  } else {
    if (!record.animaMetadata) { clearTempResult(); return false }
    deps.patchAnimaState({ result: { url: URL.createObjectURL(blob), blob, metadata: record.animaMetadata },
      job: record.animaMetadata, resultContext: record.context ?? null, phase: 'succeeded', progress: 1,
      statusText: '已找回上次未入册的成片', errorMsg: '', errorReport: null })
    deps.setDrawEngine(record.engine === 'krea2' ? 'krea2' : 'anima')
  }
  pb.flash('已找回上次未入册的成片：可点「存入作品册」，或点「清除」丢弃')
  storedResultUrl.value = deps.displayResultUrl.value
  return true
}
