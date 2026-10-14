import type { Ref } from 'vue'
import type { TempResultDeps, PendingAnimaSource } from './useTempResult'
import { hasRuntimeTasks } from '@/api/runtimeTaskAuthority'
import type { TaskSummary } from '../../../types/tasks'
import { artworkRepository } from '@/storage/artworkRepository'
import { readTempResult, resolveTempResultOwner, sameTempResultOwner, writeTempResultDurable } from '@/utils/tempResult'
import type { TempResultRecord, TempResultOwner } from '@/utils/tempResult'

/** Reuse session bytes and their save input; a new URL is only view ownership. */
export async function restorePendingAnimaSource(source: PendingAnimaSource, deps: TempResultDeps, observer: {
  current(): boolean; retained(): boolean; adopt(): void;
  bind(source: PendingAnimaSource): void; capture(source: PendingAnimaSource): Promise<void>
}): Promise<boolean | null> {
  try {
    if (!observer.current()) return false
    if (source.intent?.flight) await source.intent.flight.catch(() => null)
    if (!observer.current()) return false
    if (!observer.retained()) return null
    observer.adopt()
    const char = source.context?.char
    if (char === 'nene' || char === 'natsume' || char === 'triad') deps.pb.setChar(char)
    source.result = { ...source.result, url: URL.createObjectURL(source.result.blob) }
    const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
    deps.patchAnimaState({ result: { ...source.result, metadata: clone(source.result.metadata) },
      job: clone(source.result.metadata), resultContext: clone(source.context),
      phase: 'succeeded', progress: 1, statusText: '已找回尚未落稳的原图', errorMsg: '', errorReport: null })
    deps.setDrawEngine(source.result.metadata.engine === 'krea2' ? 'krea2' : 'anima')
    observer.bind(source)
    if (!source.intent) await observer.capture(source)
    deps.pb.flash('已找回未落稳原图，可继续保存或明确清除；入册编号保持原身份')
    return true
  } catch (error) { deps.pb.flash(error instanceof Error ? error.message : '原图来源暂时无法核对，图片仍保留'); return false }
}

/** Loaded only to recover an empty canvas. The mounted owner supplies its result revision guard. */
export async function restoreUnarchivedResult(deps: TempResultDeps, storedResultUrl: Ref<string>, current: () => boolean,
  adoptLegacy: (record: TempResultRecord, url: string) => void): Promise<boolean> {
  const { pb } = deps
  if (!current()) return false
  if (hasRuntimeTasks()) {
    const { readRuntimeTaskPage, getRuntimeTask, runtimeResultPath, fetchRuntimeResult } = await import('@/api/runtimeTasks')
    let summary: TaskSummary | undefined, before: number | undefined, through: number | undefined
    do {
      const page = await readRuntimeTaskPage('inbox', { before, through }).catch(() => null)
      if (!page || !current()) return false
      summary = page.items.find(item => ['generation', 'anima', 'creative'].includes(item.kind) && item.resultState === 'available' && !['saved', 'discarded'].includes(item.deliveryState))
      before = page.nextCursor ?? undefined; through = page.throughRevision
    } while (!summary && before !== undefined)
    if (summary) {
      const task = await getRuntimeTask(summary.taskId).catch(() => null)
      if (!task || !current()) return false
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
        deps.resultContext.value = context; deps.setDrawEngine('sd', { restoreExistingResult: true })
      } else {
        const metadata = runtimeImageMetadata(task)
        deps.patchAnimaState({ result: { url, blob, metadata }, job: metadata, resultContext: context, phase: 'succeeded', progress: 1, statusText: '已从收件箱找回结果' })
        deps.setDrawEngine(task.kind === 'creative' ? 'krea2' : 'anima')
      }
      storedResultUrl.value = url; return true
    }
  }
  let record: TempResultRecord | null, owner: TempResultOwner | undefined
  try { record = readTempResult(); if (record) owner = resolveTempResultOwner(record) }
  catch (error) { pb.flash(error instanceof Error ? error.message : '临时成片身份暂时无法核对'); return false }
  if (!record) return false
  const repository = artworkRepository
  let blob: Blob | null = null
  try { blob = await repository.getImage(record.imageId) }
  catch { if (current()) pb.flash('临时成片暂时无法读取，恢复指针已保留，请恢复原工作区后重试'); return false }
  if (!current() || repository !== artworkRepository || !owner || !sameTempResultOwner(owner)) return false
  if (!blob || !blob.size) { pb.flash('临时成片原图暂时不可用，恢复指针已保留'); return false }
  if (record.engine !== 'sd' && !record.animaMetadata) { pb.flash('临时成片元数据不完整，原记录已保留'); return false }
  try { await writeTempResultDurable({ ...record, owner }) }
  catch { if (current()) pb.flash('临时成片来源尚未写稳，恢复指针已保留'); return false }
  if (!current() || repository !== artworkRepository || !sameTempResultOwner(owner)) return false
  // Restore the result's subject before the engine's existing compatibility guard.
  if (record.engine === 'sd' && pb.isPopular) pb.setStudioSubject()
  const originChar = record.context?.char
  if (originChar === 'nene' || originChar === 'natsume' || originChar === 'triad') pb.setChar(originChar)
  if (record.engine === 'sd') {
    deps.sd.adoptResult(URL.createObjectURL(blob), record.seed, record.prompt)
    deps.resultContext.value = record.context ?? null
    deps.setDrawEngine('sd', { restoreExistingResult: true })
  } else {
    if (!record.animaMetadata) return false
    deps.patchAnimaState({ result: { url: URL.createObjectURL(blob), blob, metadata: record.animaMetadata },
      job: record.animaMetadata, resultContext: record.context ?? null, phase: 'succeeded', progress: 1,
      statusText: '已找回上次未入册的成片', errorMsg: '', errorReport: null })
    deps.setDrawEngine(record.engine === 'krea2' ? 'krea2' : 'anima')
  }
  pb.flash('已找回上次未入册的成片：可点「存入作品册」，或点「清除」丢弃')
  storedResultUrl.value = deps.displayResultUrl.value
  adoptLegacy({ ...record, owner }, storedResultUrl.value)
  return true
}
