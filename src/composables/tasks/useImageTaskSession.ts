import { computed, shallowRef } from 'vue'
import type { TaskRecord } from '../../../types/tasks'
import type { AnimaPublicJob } from '@/types/anima'
import { hasRuntimeTasks, fetchRuntimeResult, runtimeResultPath, taskMessage, getRuntimeTask } from '@/api/runtimeTasks'
import { acceptDirectImageRequest, cancelDirectImageRequest } from '@/api/directImageRequests'
import { waitForDirectImageJob, fetchResultImage, jobPath, imageJob } from '@/api/directImageJobs'
import { apiClient } from '@/api/client'
import { DirectRequestRejected } from '@/api/directGenerationRequests'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { newTaskRequestDraft, readTaskRequestDraft, type TaskRequestDraft } from '@/storage/taskRequestDraft'
import { assertRequestOwner, clearRequestDraft, writeRequestDraft } from '@/storage/requestDraft'
import { useAcceptedTaskSession } from './useAcceptedTaskSession'
import { useTrackedTask } from '@/composables/useTaskCenter'

export interface ImageTask {
  taskId: string; kind: TaskRequestDraft['kind']; provider: string; input: Record<string, unknown>; metadata: Record<string, unknown>
  status: string; upstreamSettled: boolean; recoveryState: string; resultAvailable: boolean; outputs: number[]
  requestKey: string; createdAt: number; runtimeTask?: TaskRecord
}
export const imageTaskSettled = (task: ImageTask | null) => !!task && task.upstreamSettled && task.recoveryState === 'normal'
  && ['succeeded', 'failed', 'cancelled'].includes(task.status)
export const imageTaskMessage = (task: ImageTask) => task.runtimeTask ? taskMessage(task.runtimeTask)
  : String(task.metadata.progressText || task.metadata.error || ({ succeeded: '处理完成', failed: '处理失败', cancelled: '已取消', queued: '正在排队' }[task.status] || '正在处理…'))
function runtimeView(task: TaskRecord): ImageTask {
  return { ...task, kind: task.kind as ImageTask['kind'], runtimeTask: task, resultAvailable: task.resultState === 'available', outputs: task.resultRefs.filter(v => v.mime === 'image/png').map(v => v.index) }
}
export async function fetchImageTaskResult(task: ImageTask, signal: AbortSignal, index = 0): Promise<Blob> {
  if (!task.outputs.includes(index)) throw new Error('任务尚无这张图片')
  if (task.runtimeTask) return fetchRuntimeResult(runtimeResultPath(task.runtimeTask, index), signal, task.runtimeTask)
  return fetchResultImage(`${jobPath(task.kind === 'lineart' ? 'manga' : task.kind as 'qwen' | 'moss' | 'manga', task.taskId)}/${index === 1 ? 'lineart' : 'result'}`, signal)
}
/** Same two transports as ordinary drawing; a direct receipt never impersonates a workspace task. */
export function useImageTaskSession(options: { slot: string; kinds: TaskRequestDraft['kind'][]; family: 'qwen' | 'moss' | 'manga'; signal: AbortSignal; check: () => void; validate: (task: ImageTask) => void; onAccepted?: () => void }) {
  if (hasRuntimeTasks()) {
    const runtime = useAcceptedTaskSession({ ...options, validate: task => options.validate(runtimeView(task)) })
    const task = computed({ get: () => runtime.task.value ? runtimeView(runtime.task.value) : null,
      set: (value: ImageTask | null) => { runtime.task.value = value?.runtimeTask || null } })
    return { ...runtime, task, accept: (value: ImageTask | TaskRecord) => runtime.accept('outputs' in value ? value.runtimeTask! : value),
      observe: async () => runtimeView(await runtime.observe()), load: async (id: string) => runtimeView(await getRuntimeTask(id, options.signal)) }
  }
  const request = shallowRef<TaskRequestDraft | null>(null), task = shallowRef<ImageTask | null>(null)
  const settled = computed(() => imageTaskSettled(task.value)), unresolved = computed(() => !!(request.value || task.value) && !settled.value)
  function check() { options.signal.throwIfAborted(); options.check(); if (request.value) assertRequestOwner(request.value, false) }
  function decode(job: AnimaPublicJob, owned = request.value): ImageTask {
    const previous = task.value?.taskId === job.id ? task.value : null
    const metadata: Record<string, unknown> = { ...job.metadata, progress: job.progress, progressText: job.progressText, error: job.error, context: owned?.context ?? previous?.metadata.context }
    const input: Record<string, unknown> = { ...previous?.input, ...owned?.input, ...job.metadata }
    const value: ImageTask = { taskId: job.id, kind: owned?.kind || (input.operation === 'lineart' ? 'lineart' : options.family), provider: job.provider || '',
      input, metadata, status: job.status, upstreamSettled: job.upstreamSettled === true, recoveryState: job.unknown === false ? 'normal' : 'unknown',
      resultAvailable: job.resultAvailable, outputs: job.resultAvailable ? [0, ...(input.lineartResult && input.operation !== 'lineart' ? [1] : [])] : [],
      requestKey: owned?.key || previous?.requestKey || '', createdAt: previous?.createdAt ?? (typeof input.createdAt === 'number' ? input.createdAt : Date.now()) }
    options.validate(value)
    return value
  }
  function accept(value: ImageTask | TaskRecord) {
    check()
    if (!('outputs' in value) || value.runtimeTask || !options.kinds.includes(value.kind)) throw new Error('任务不属于当前生图连接')
    options.validate(value); task.value = value; options.onAccepted?.(); return true
  }
  async function remember(job: AnimaPublicJob) {
    check(); accept(decode(job))
    if (request.value) { const updated = { ...request.value, taskId: job.id }; await writeRequestDraft(options.slot, updated); check(); request.value = updated }
    return task.value!
  }
  async function resolve() {
    check()
    if (!request.value) return task.value
    if (task.value?.taskId === request.value.taskId) return task.value
    return accepted(true)
  }
  async function accepted(resume: boolean): Promise<ImageTask> {
    const owned = request.value!
    try { return await remember(await acceptDirectImageRequest(options.family, owned.input, owned.key, { signal: options.signal, resume })) }
    catch (error) {
      if (error instanceof DirectRequestRejected) { check(); await clearRequestDraft(options.slot, owned); request.value = null; task.value = null }
      throw error
    }
  }
  async function release() {
    check(); if (!request.value) return
    if (!settled.value) throw new Error('请先确认原任务已经结束')
    await clearRequestDraft(options.slot, request.value); check(); request.value = null
  }
  async function cancel() {
    check(); if (!request.value) return task.value
    const result = await cancelDirectImageRequest(options.family, request.value.key, runtimeResourceIdentity())
    check(); if (result) return remember(result)
    await clearRequestDraft(options.slot, request.value); request.value = null; task.value = null; return null
  }
  useTrackedTask(() => ({ kind: 'image', title: options.family === 'manga' ? '漫画化' : options.family === 'moss' ? 'MOSS 创作' : 'Qwen 创作',
    status: !settled.value ? 'running' : task.value?.status === 'succeeded' ? 'succeeded' : task.value?.status === 'cancelled' ? 'cancelled' : 'failed',
    message: task.value ? imageTaskMessage(task.value) : '接收状态待确认，请查询原操作',
    progress: typeof task.value?.metadata.progress === 'number' ? task.value.metadata.progress : null,
    route: options.family === 'qwen' ? `/prompt-builder?editor=qwen${task.value ? `&job=${encodeURIComponent(task.value.taskId)}` : ''}` : options.family === 'manga' ? '/gallery' : '/prompt-builder',
  }), { cancel }, () => !!request.value || !!task.value)
  return { task, request, settled, unresolved, accept, release, resolve,
    restore() { check(); const saved = readTaskRequestDraft(options.slot); if (saved && (!options.kinds.includes(saved.kind) || saved.transport !== 'direct')) throw new Error('原任务属于另一连接，请回原连接核对'); request.value = saved; check(); return saved },
    async submit(kind: TaskRequestDraft['kind'], input: Record<string, unknown>, context?: Record<string, unknown>, details?: Record<string, unknown>, cancelled = () => false) {
      check(); if (request.value || unresolved.value || !options.kinds.includes(kind)) throw new Error('请先确认原任务已经结束')
      const owned = newTaskRequestDraft(kind, input, false, context, details); owned.submitted = true; request.value = owned; task.value = null
      await writeRequestDraft(options.slot, owned); check(); if (cancelled()) return
      await accepted(false)
    },
    async observe() {
      const value = await resolve(); if (!value) throw new Error('原任务尚未找到，请核对原请求')
      await waitForDirectImageJob(options.family, value.taskId, options.signal, { timeoutMs: 11 * 60_000, immediate: true,
        update: job => { check(); accept(decode(job)) } })
      return task.value!
    },
    cancel,
    async load(id: string) { check(); return decode(imageJob(await apiClient.request(jobPath(options.family, id), { signal: options.signal, cachePolicy: 'bypass' }), id)) },
  }
}
