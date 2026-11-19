import { ApiClientError } from '@/api/client'
import { companionDrawingBatch } from '@/api/companionDrawingApi'
import { hasRuntimeTasks } from '@/api/runtimeTasks'
import { assertRequestOwner, clearRequestDraft, newRequestDraft, readRequestDraft, writeRequestDraft, type RequestDraft } from '@/storage/requestDraft'
import { COMPANION_DRAWING_BATCH_KEY as slot } from '@/utils/storageKeys'
import { abortableTask } from '@/utils/abortableTask'
import { parseCompanionChatImages } from '@/types/companionDrawing'
import type { CompanionToolContext } from './companionChatTools'
import type { CompanionToolResult } from './executeCompanionTool'

interface BatchDraft extends RequestDraft {
  character: string
  branch: string
  input: Record<string, unknown>
}

let busy = false

function readBatchDraft(): BatchDraft | null {
  const draft = readRequestDraft(slot)
  if (!draft) return null
  if (typeof draft.character !== 'string' || typeof draft.branch !== 'string'
    || !draft.input || typeof draft.input !== 'object' || Array.isArray(draft.input)) {
    throw new Error('原对话批次记录无法读取，已保留记录')
  }
  return draft as unknown as BatchDraft
}

export async function acknowledgeCompanionBatch(id: string) {
  const draft = readBatchDraft()
  if (draft?.key !== id) return
  assertRequestOwner(draft, hasRuntimeTasks())
  await clearRequestDraft(slot, draft)
}

export async function generateCompanionDrawingBatch(args: Record<string, unknown>, context: CompanionToolContext): Promise<CompanionToolResult> {
  if (!hasRuntimeTasks()) throw new Error('请在桌面客户端启用私人任务工作区后使用批量绘图')
  if (busy) throw new Error('正在处理上一批对话绘图')
  const { action = 'generate', ...input } = args
  if (action !== 'generate' && action !== 'preview' && action !== 'resume' && action !== 'cancel') throw new Error('批次操作无效')
  const signal = AbortSignal.any([context.signal, AbortSignal.timeout(30 * 60_000)])
  signal.throwIfAborted()
  busy = true
  let draft: BatchDraft | null = null
  let cancellation: ReturnType<typeof companionDrawingBatch> | undefined
  const stop = () => {
    if (context.signal.reason !== 'user-cancel' || !draft?.submitted || cancellation) return
    const original = draft
    cancellation = Promise.resolve().then(() => {
      assertRequestOwner(original, hasRuntimeTasks())
      return companionDrawingBatch(original.key, 'DELETE')
    })
    void cancellation.catch(() => {})
  }
  signal.addEventListener('abort', stop, { once: true })
  try {
    draft = readBatchDraft()
    const recovering = !!draft
    if (draft) {
      assertRequestOwner(draft, hasRuntimeTasks())
      if (draft.character !== context.character || draft.branch !== context.branch) {
        throw new Error('请回到原角色和原对话分支，继续或取消上次绘图')
      }
    } else {
      if (action !== 'generate' && action !== 'preview') return { ok: false, output: '当前对话没有待取回的绘图批次。' }
      draft = { ...newRequestDraft(true), character: context.character, branch: context.branch,
        input: { ...input, preview: action === 'preview' } }
      await writeRequestDraft(slot, draft)
    }
    signal.throwIfAborted()
    assertRequestOwner(draft, hasRuntimeTasks())
    const id = draft.key
    let batch = recovering ? await companionDrawingBatch(id, 'GET', signal) : null
    if (action === 'cancel') batch = await companionDrawingBatch(id, 'DELETE', signal)
    else if (action === 'resume' && batch?.state === 'paused') batch = await companionDrawingBatch(id, 'PATCH', signal)
    if (!batch) {
      context.report(recovering ? '正在核对上一批绘图…' : '正在准备本机绘图配方…')
      if (!draft.submitted) {
        draft = { ...draft, submitted: true }
        await writeRequestDraft(slot, draft)
      }
      signal.throwIfAborted()
      assertRequestOwner(draft, hasRuntimeTasks())
      try {
        // A lost response can replay only the frozen input under the original ID.
        batch = await companionDrawingBatch(id, 'POST', signal, draft.input)
      } catch (error) {
        if (!signal.aborted && error instanceof ApiClientError && error.responseBody?.submissionNotAccepted === true) {
          await clearRequestDraft(slot, draft)
        }
        throw error
      }
    }
    if (batch) await context.onDrawingBatch?.(id)
    while (batch?.state === 'running' || batch?.state === 'cancelling') {
      const done = batch.jobs.filter(job => ['succeeded', 'failed', 'cancelled'].includes(job.status)).length
      context.report(batch.state === 'cancelling' ? '正在停止这批图片…' : `本机绘图已处理 ${done}/${batch.jobs.length} 张…`)
      await abortableTask(() => new Promise<void>(resolve => setTimeout(resolve, 2000)), signal)
      assertRequestOwner(draft, hasRuntimeTasks())
      batch = await companionDrawingBatch(id, 'GET', signal)
    }
    if (!batch) throw new Error('原批次回执暂不可用，请继续核对原批次')
    signal.throwIfAborted()
    assertRequestOwner(draft, hasRuntimeTasks())
    if (batch.state === 'draft') {
      const output = '出图方案已准备，请在卡片上查看或修改，点击开始后才会生成。'
      return { ok: true, output, drawingBatchId: id }
    }
    const images = parseCompanionChatImages(batch.jobs.filter(job => job.status === 'succeeded').map(job => ({
      path: `/api/tasks/v1/${job.taskId}/results/0`,
      name: `${job.sceneTitle} · 第 ${job.variant + 1} 张`.slice(0, 240),
      taskId: job.taskId, imageId: job.imageId, artworkId: job.historyId,
    })))
    const failures = [...new Set(batch.jobs.map(job => job.error).filter(Boolean))].join('；')
    const paused = batch.state === 'paused'
    const status = paused ? `批次已暂停。${batch.error || '请核对原任务后再继续。'}`
      : batch.state === 'cancelled' ? '批次已停止。' : ''
    const saved = images.filter(image => image.artworkId).length
    const archive = saved === images.length ? '，已保存到作品册。'
      : `，其中 ${saved} 张已入册，其余可在任务中心补存。`
    const output = (recovering && (action === 'generate' || action === 'preview') ? '已核对上一批绘图，本次新要求尚未提交。' : '')
      + (images.length ? `已生成 ${images.length}/${batch.jobs.length} 张${archive}` : '这批没有可返回的图片。')
      + status + (failures ? `部分任务未完成（${failures}）。` : '')
    if (!images.length && !paused) await clearRequestDraft(slot, draft)
    return { ok: images.length > 0, output, images, ...(!paused ? { drawingBatchId: id } : {}) }
  } catch (error) {
    if (signal.aborted) {
      stop()
      if (draft && !draft.submitted) await clearRequestDraft(slot, draft)
      if (cancellation) await cancellation
      if (signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError') {
        throw new Error('等待出图已超时，原批次仍保留，可以继续取回')
      }
    }
    throw error
  } finally {
    signal.removeEventListener('abort', stop)
    busy = false
  }
}
