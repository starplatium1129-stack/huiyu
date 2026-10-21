import { computed, shallowRef } from 'vue'
import { cancelRuntimeTaskKey, getRuntimeTaskByKey, hasRuntimeTasks, submitRuntimeTask, waitForRuntimeTask, type TaskRecord } from '@/api/runtimeTasks'
import { newTaskRequestDraft, readTaskRequestDraft, type TaskRequestDraft } from '@/storage/taskRequestDraft'
import { assertRequestOwner, clearRequestDraft, writeRequestDraft } from '@/storage/requestDraft'

export const taskSettled = (task: TaskRecord | null) => !!task && task.upstreamSettled && task.recoveryState === 'normal'
  && ['succeeded', 'failed', 'cancelled'].includes(task.status)

/** One durable acceptance key per visit. Unknown admission is queried or cancelled, never resubmitted. */
export function useAcceptedTaskSession(options: {
  slot: string; kinds: TaskRequestDraft['kind'][]; signal: AbortSignal; check: () => void
  validate: (task: TaskRecord) => void; onAccepted?: () => void
}) {
  const request = shallowRef<TaskRequestDraft | null>(null), task = shallowRef<TaskRecord | null>(null)
  const settled = computed(() => taskSettled(task.value) && (!request.value || task.value?.requestKey === request.value.key))
  const unresolved = computed(() => !!(request.value || task.value) && !settled.value)
  function check() {
    options.signal.throwIfAborted(); options.check()
    if (request.value) assertRequestOwner(request.value, hasRuntimeTasks())
  }
  function accept(value: TaskRecord) {
    check()
    const owned = request.value
    if (!options.kinds.includes(value.kind as TaskRequestDraft['kind']) || owned && (value.kind !== owned.kind
      || value.requestKey !== owned.key || owned.taskId && value.taskId !== owned.taskId))
      throw new Error('任务回执与原请求不符，请在任务中心核对')
    options.validate(value)
    if (task.value?.taskId === value.taskId && value.revision < task.value.revision) return false
    task.value = structuredClone(value); options.onAccepted?.()
    return true
  }
  function restore() {
    const saved = readTaskRequestDraft(options.slot)
    if (saved && (saved.transport !== 'runtime' || !options.kinds.includes(saved.kind)))
      throw new Error('保存的任务请求类型无效，已保留记录，请核对任务中心')
    request.value = saved
    return saved
  }
  async function remember(owned: TaskRequestDraft, value: TaskRecord) {
    check()
    if (request.value?.key !== owned.key) throw new Error('原任务已由新的操作接管')
    accept(value)
    const updated = { ...owned, taskId: value.taskId }
    await writeRequestDraft(options.slot, updated); check()
    if (request.value?.key !== owned.key) throw new Error('原任务已由新的操作接管')
    request.value = updated
  }
  async function resolve() {
    check()
    const owned = request.value
    if (!owned) return task.value
    const value = await getRuntimeTaskByKey(owned.key, options.signal); check()
    if (value) await remember(owned, value)
    return value
  }
  async function observe() {
    const value = await resolve()
    if (!value) throw new Error('接收状态仍待确认，请在任务中心查询原操作，或请求取消；不会重复提交')
    const completed = await waitForRuntimeTask(value.taskId, options.signal, check,
      { timeoutMs: 11 * 60_000, onDetail: value => { accept(value) } })
    check(); accept(completed)
    return completed
  }
  async function release() {
    check()
    const owned = request.value
    if (!owned) return
    if (!settled.value) throw new Error('请先确认原任务已经结束，或请求取消')
    await clearRequestDraft(options.slot, owned); check()
    if (request.value?.key === owned.key) request.value = null
  }
  async function submit(kind: TaskRequestDraft['kind'], input: Record<string, unknown>, context?: Record<string, unknown>,
    details?: Record<string, unknown>, cancelled: () => boolean = () => false) {
    check()
    if (!options.kinds.includes(kind) || request.value || unresolved.value) throw new Error('请先确认原任务已经结束')
    const owned = newTaskRequestDraft(kind, input, true, context, details)
    owned.submitted = true; request.value = owned; task.value = null
    // Persist before transmission; even an interrupted response leaves this exact key recoverable.
    await writeRequestDraft(options.slot, owned); check()
    if (cancelled()) return
    const value = await submitRuntimeTask(kind, owned.input, owned.key, owned.context, { signal: options.signal, onSubmitting: check })
    await remember(owned, value)
  }
  async function cancel() {
    check()
    const owned = request.value, key = owned?.key || task.value?.requestKey
    if (!key || settled.value) return task.value
    const value = await cancelRuntimeTaskKey(key, options.signal); check()
    if (value) { if (owned) await remember(owned, value); else accept(value) }
    else if (owned) {
      await clearRequestDraft(options.slot, owned); check()
      if (request.value?.key === owned.key) { request.value = null; task.value = null }
    }
    return value
  }
  return { task, request, settled, unresolved, accept, restore, resolve, observe, release, submit, cancel }
}
