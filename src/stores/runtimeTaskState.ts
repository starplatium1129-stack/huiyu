import { computed, ref, toRaw } from 'vue'
import type { TaskRecord } from '../../types/tasks'
export const taskRecords = ref<TaskRecord[]>([])
export const copyTask = (task: TaskRecord) => structuredClone(toRaw(task))
export const runtimeTasks = computed(() => taskRecords.value.map(copyTask))
export const runtimeTasksEnabled = ref(false)
export const runtimeTaskError = ref('')
export const runtimeTaskActiveCount = computed(() => taskRecords.value.filter(task => !task.upstreamSettled).length)
export const unresolvedTaskRequests = new Map<string, { key: string; kind: TaskRecord['kind'] }>()
export const pendingTaskRequests = ref<Array<{ key: string; kind: TaskRecord['kind'] }>>([])

export function mergeTasks(incoming: readonly TaskRecord[], expected: string): void {
  if (incoming.length === 0) return
  // Validate the whole response before publishing any partial state. Revisions
  // identify immutable runtime snapshots; unchanged polling must not clone and
  // re-sort every task or invalidate all derived UI snapshots every 2.5 seconds.
  if (incoming.some(task => task.runtimeEpoch !== expected)) throw new Error('运行时已更换，请重新读取任务')
  const records = new Map(taskRecords.value.map(task => [task.taskId, task]))
  let changed = false
  for (const task of incoming) {
    const current = records.get(task.taskId)
    if (!current || current.runtimeEpoch !== task.runtimeEpoch || current.revision < task.revision) {
      records.set(task.taskId, copyTask(task)); changed = true
    }
  }
  if (changed) taskRecords.value = [...records.values()].sort((a, b) => b.createdAt - a.createdAt)
  const received = new Set(incoming.map(task => task.requestKey))
  let resolved = false
  for (const [input, pending] of unresolvedTaskRequests) if (received.has(pending.key)) { unresolvedTaskRequests.delete(input); resolved = true }
  if (resolved) pendingTaskRequests.value = [...unresolvedTaskRequests.values()]
}
export function rememberTask(task: TaskRecord, expected: string): TaskRecord {
  mergeTasks([task], expected)
  // Callers still own a detached result, never the stored record or a mutable
  // cross-layer shared reference. List refresh has no unused return copies.
  return copyTask(taskRecords.value.find(value => value.taskId === task.taskId)!)
}

export function runtimeRequestKey(kind: TaskRecord['kind'], input: Record<string, unknown>): string {
  const fingerprint = JSON.stringify({ kind, input }), previous = unresolvedTaskRequests.get(fingerprint)
  if (previous) return previous.key
  const key = crypto.randomUUID()
  unresolvedTaskRequests.set(fingerprint, { key, kind }); pendingTaskRequests.value = [...unresolvedTaskRequests.values()]
  return key
}

export function forgetTaskRequest(key: string): void {
  for (const [input, pending] of unresolvedTaskRequests) if (pending.key === key) unresolvedTaskRequests.delete(input)
  pendingTaskRequests.value = [...unresolvedTaskRequests.values()]
}
export function clearRuntimeTasks(): void { taskRecords.value = [] }
export function resetRuntimeTaskWorkspace(): void {
  clearRuntimeTasks()
  unresolvedTaskRequests.clear()
  pendingTaskRequests.value = []
}
