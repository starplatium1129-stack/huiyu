import type { Ref } from 'vue'
import type { TempResultDeps, PendingAnimaSource } from './useTempResult'
import type { ResultRestoreOwner } from '../generation/animaSessionContract'
import { hasRuntimeTasks } from '@/api/runtimeTaskAuthority'
import type { TaskSummary } from '../../../types/tasks'
import { artworkRepository } from '@/storage/artworkRepository'
import { readTempResult, resolveTempResultOwner, sameTempResultOwner, writeTempResultDurable } from '@/utils/tempResult'
import type { TempResultRecord, TempResultOwner } from '@/utils/tempResult'

export interface TempRestoreObserver extends ResultRestoreOwner {
  publish(url: string, adopt: () => void): boolean
}

/** The reader owns an unpublished URL; the receiving image session owns it after handoff. */
function publishBlob(blob: Blob, deps: TempResultDeps, observer: TempRestoreObserver, adopt: (url: string) => void) {
  const url = URL.createObjectURL(blob)
  const handedOff = () => deps.sd.resultUrl.value === url || deps.animaState.value.result?.url === url
  try {
    return observer.publish(url, () => adopt(url)) && handedOff() ? url : ''
  } finally { if (!handedOff()) URL.revokeObjectURL(url) }
}

/** Reuse session bytes and their save input; a new URL is only view ownership. */
export async function restorePendingAnimaSource(source: PendingAnimaSource, deps: TempResultDeps, observer: TempRestoreObserver & {
  retained(): boolean; adopt(): void;
  bind(source: PendingAnimaSource): void; capture(source: PendingAnimaSource): Promise<void>
}): Promise<boolean | null> {
  try {
    if (!observer.current()) return false
    // The outer read slot can stop its observer's wait, but must stay occupied
    // until this existing save really settles. Never abort or replace that save.
    if (source.intent?.flight) await source.intent.flight.catch(() => null)
    if (!observer.current()) return false
    observer.signal.throwIfAborted()
    if (!observer.retained()) return null
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    const url = publishBlob(source.result.blob, deps, observer, url => {
      observer.adopt()
      const char = source.context?.char
      if (char === 'nene' || char === 'natsume' || char === 'triad') deps.pb.setChar(char)
      const previous = deps.animaState.value.result, result = { ...source.result, url }
      try {
        deps.patchAnimaState({ result: { ...result, metadata: clone(result.metadata) },
          job: clone(result.metadata), resultContext: clone(source.context),
          phase: 'succeeded', progress: 1, statusText: '已找回尚未落稳的原图', errorMsg: '', errorReport: null })
      } finally {
        if (deps.animaState.value.result?.url === url) {
          source.result = result
          if (previous && previous.url !== url) URL.revokeObjectURL(previous.url)
        }
      }
      deps.setDrawEngine(result.metadata.engine === 'krea2' ? 'krea2' : 'anima', { restoreExistingResult: true })
    })
    if (!url) return false
    observer.bind(source)
    // Publication has its own result owner. Losing this read's visit must not
    // interrupt the only Blob's already-authorized durable handoff.
    if (!source.intent) await observer.capture(source)
    if (observer.current()) deps.pb.flash('已找回未落稳原图，可继续保存或明确清除；入册编号保持原身份')
    return true
  } catch (error) {
    if (observer.current()) deps.pb.flash(error instanceof Error ? error.message : '原图来源暂时无法核对，图片仍保留')
    return false
  }
}

/** Loaded only to recover an empty canvas, with the visit and media owner supplied by its caller. */
export async function restoreUnarchivedResult(deps: TempResultDeps, storedResultUrl: Ref<string>, observer: TempRestoreObserver,
  adoptLegacy: (record: TempResultRecord, url: string) => void): Promise<boolean> {
  const { pb } = deps, { signal, current } = observer
  if (!current()) return false
  signal.throwIfAborted()
  if (hasRuntimeTasks()) {
    const { readRuntimeTaskPage, getRuntimeTask, runtimeResultPath, fetchRuntimeResult } = await import('@/api/runtimeTasks')
    if (!current()) return false
    let summary: TaskSummary | undefined, before: number | undefined, through: number | undefined
    do {
      const page = await readRuntimeTaskPage('inbox', { before, through, signal }).catch(() => null)
      if (!page || !current()) return false
      summary = page.items.find(item => ['generation', 'anima', 'creative'].includes(item.kind) && item.resultState === 'available' && !['saved', 'discarded'].includes(item.deliveryState))
      before = page.nextCursor ?? undefined; through = page.throughRevision
    } while (!summary && before !== undefined)
    if (summary) {
      const task = await getRuntimeTask(summary.taskId, signal).catch(() => null)
      if (!task || !current()) return false
      const blob = await fetchRuntimeResult(runtimeResultPath(task), signal, task).catch(() => null)
      if (!blob || !current()) return false
      const { runtimeImageMetadata, runtimeTaskRecipe, runtimeTaskResultContext } = await import('@/utils/runtimeTaskResult')
      if (!current()) return false
      const context = runtimeTaskResultContext(task), recipe = runtimeTaskRecipe(task)
      const url = publishBlob(blob, deps, observer, url => {
        if (task.kind === 'generation') {
          if (pb.isPopular) pb.setStudioSubject()
          if (context.char === 'nene' || context.char === 'natsume' || context.char === 'triad') pb.setChar(context.char)
          deps.sd.adoptResult(url, recipe.seed ?? null, recipe.prompt ?? '', task.taskId)
          deps.resultContext.value = context
          deps.setDrawEngine('sd', { restoreExistingResult: true })
        } else {
          const metadata = runtimeImageMetadata(task), previous = deps.animaState.value.result
          deps.patchAnimaState({ result: { url, blob, metadata }, job: metadata, resultContext: context, phase: 'succeeded', progress: 1, statusText: '已从收件箱找回结果' })
          if (previous && previous.url !== url) URL.revokeObjectURL(previous.url)
          deps.setDrawEngine(task.kind === 'creative' ? 'krea2' : 'anima', { restoreExistingResult: true })
        }
      })
      if (!url) return false
      storedResultUrl.value = url; return true
    }
  }
  let record: TempResultRecord | null, owner: TempResultOwner | undefined
  try { record = readTempResult(); if (record) owner = resolveTempResultOwner(record) }
  catch (error) { if (current()) pb.flash(error instanceof Error ? error.message : '临时成片身份暂时无法核对'); return false }
  if (!record || !current()) return false
  const repository = artworkRepository
  let blob: Blob | null = null
  try { blob = await repository.getImage(record.imageId, signal) }
  catch { if (current()) pb.flash('临时成片暂时无法读取，恢复指针已保留，请恢复原工作区后重试'); return false }
  if (!current() || repository !== artworkRepository || !owner || !sameTempResultOwner(owner)) return false
  if (!blob || !blob.size) { pb.flash('临时成片原图暂时不可用，恢复指针已保留'); return false }
  if (record.engine !== 'sd' && !record.animaMetadata) { pb.flash('临时成片元数据不完整，原记录已保留'); return false }
  const samePointer = () => {
    const latest = readTempResult()
    return latest?.imageId === record.imageId && latest.savedAt === record.savedAt
      && latest.pendingCommit?.operationId === record.pendingCommit?.operationId
      && latest.pendingCommit?.entry.image_id === record.pendingCommit?.entry.image_id
  }
  if (!samePointer()) return false
  try { await writeTempResultDurable({ ...record, owner }) }
  catch { if (current()) pb.flash('临时成片来源尚未写稳，恢复指针已保留'); return false }
  if (!current() || repository !== artworkRepository || !sameTempResultOwner(owner) || !samePointer()) return false
  const url = publishBlob(blob, deps, observer, url => {
    if (record.engine === 'sd' && pb.isPopular) pb.setStudioSubject()
    const originChar = record.context?.char
    if (originChar === 'nene' || originChar === 'natsume' || originChar === 'triad') pb.setChar(originChar)
    if (record.engine === 'sd') {
      deps.sd.adoptResult(url, record.seed, record.prompt)
      deps.resultContext.value = record.context ?? null
      deps.setDrawEngine('sd', { restoreExistingResult: true })
    } else {
      const metadata = record.animaMetadata!, previous = deps.animaState.value.result
      deps.patchAnimaState({ result: { url, blob, metadata }, job: metadata, resultContext: record.context ?? null,
        phase: 'succeeded', progress: 1, statusText: '已找回上次未入册的成片', errorMsg: '', errorReport: null })
      if (previous && previous.url !== url) URL.revokeObjectURL(previous.url)
      deps.setDrawEngine(record.engine === 'krea2' ? 'krea2' : 'anima', { restoreExistingResult: true })
    }
  })
  if (!url) return false
  storedResultUrl.value = url; adoptLegacy({ ...record, owner }, url)
  if (current()) pb.flash('已找回上次未入册的成片：可点「存入作品册」，或点「清除」丢弃')
  return true
}
