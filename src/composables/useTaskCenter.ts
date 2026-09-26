import { computed, getCurrentInstance, onUnmounted, ref, watch } from 'vue'
import { readTaskHistory, updateTaskHistory } from '@/platform/web/taskHistory'
import { recordDiagnosticTask } from '../utils/localDiagnostics.ts'
import type { GenerationStage } from '@/utils/generationTask'
import { hasRuntimeTasks } from '@/api/runtimeTaskAuthority'
import { runtimeTaskActiveCount } from '@/api/runtimeTaskState'

export type TaskStatus = 'idle' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'
export interface TaskSummary {
  kind: 'image' | 'batch' | 'video' | 'interrogate'
  title: string
  status: TaskStatus
  stage?: GenerationStage
  message?: string
  progress?: number | null
  route: string
  resultRoute?: string
  backend?: { kind: 'video' | 'video-batch'; id: string }
}
export interface TaskRecord extends TaskSummary { id: string; createdAt: number; updatedAt: number }
export interface TaskControls { cancel?: () => unknown; retry?: () => unknown }
const tasks = ref<TaskRecord[]>([])
const opened = ref(false)
const storageError = ref('')
const actions = new Map<string, TaskControls>()
let reloadApproved = false
export function approveTaskReload() { reloadApproved = true }
export function consumeTaskReloadApproval() { const approved = reloadApproved; reloadApproved = false; return approved }
let loading: Promise<void> | undefined
let writeTail = Promise.resolve()
const deletedTasks = new Map<string, number>()
const TASK_HISTORY_LIMIT = 60

export interface TaskStorageDiagnostics {
  recordCount: number
  tombstoneCount: number
  serializedBytes: number
  oldestTombstoneAt: number | null
  oldestTombstoneAgeMs: number | null
  historyLimit: number
  compaction: { policy: 'retain-tombstones'; safeToDrop: false; reason: string }
}

export interface TaskSummaryCompactionPlan {
  eligibleIds: string[]
  retainedIds: string[]
  safeToApply: boolean
  reason: string
}

interface StoredTaskSnapshot { version: 1; records: unknown[]; deleted: Record<string, number> }

function parseTaskRecord(item: unknown): TaskRecord | null {
  if (!item || typeof item !== 'object') return null
  const value = item as Partial<TaskRecord>
  if (typeof value.id !== 'string' || typeof value.title !== 'string' || typeof value.route !== 'string'
    || !value.route.startsWith('/') || value.route.startsWith('//')
    || !['image', 'batch', 'video', 'interrogate'].includes(String(value.kind))
    || !['idle', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(String(value.status))) return null
  const createdAt = typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : 0
  const updatedAt = typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : createdAt
  const backend = value.backend && ['video', 'video-batch'].includes(value.backend.kind)
    && typeof value.backend.id === 'string' && /^[\w-]{1,160}$/.test(value.backend.id)
    ? { kind: value.backend.kind, id: value.backend.id } : undefined
  return {
    ...value as TaskRecord,
    createdAt,
    updatedAt,
    backend,
    resultRoute: typeof value.resultRoute === 'string' && value.resultRoute.startsWith('/') && !value.resultRoute.startsWith('//') ? value.resultRoute : undefined,
  }
}

function decodeSnapshot(value: unknown): { records: TaskRecord[]; deleted: Map<string, number> } {
  const recordsValue = Array.isArray(value) ? value : value && typeof value === 'object' && Array.isArray((value as StoredTaskSnapshot).records)
    ? (value as StoredTaskSnapshot).records : []
  const deletedValue = !Array.isArray(value) && value && typeof value === 'object' && (value as StoredTaskSnapshot).deleted
    ? (value as StoredTaskSnapshot).deleted : {}
  const records = recordsValue.map(parseTaskRecord).filter((item): item is TaskRecord => Boolean(item))
  const deleted = new Map<string, number>()
  if (deletedValue && typeof deletedValue === 'object') {
    for (const [id, timestamp] of Object.entries(deletedValue)) {
      if (/^[\w-]{1,160}$/.test(id) && typeof timestamp === 'number' && Number.isFinite(timestamp)) deleted.set(id, timestamp)
    }
  }
  return { records, deleted }
}

function mergeSnapshot(remote: { records: TaskRecord[]; deleted: Map<string, number> }) {
  const byId = new Map<string, TaskRecord>()
  const localIds = new Set(tasks.value.map(task => task.id))
  for (const record of remote.records) {
    byId.set(record.id, !localIds.has(record.id) && record.status === 'running'
      ? { ...record, status: 'interrupted', message: '这是其他页面会话留下的记录，请回工作台检查进度或已保存结果。' }
      : record)
  }
  for (const record of tasks.value) {
    const existing = byId.get(record.id)
    if (!existing || record.updatedAt >= existing.updatedAt) byId.set(record.id, record)
  }
  const deleted = new Map(remote.deleted)
  for (const [id, timestamp] of deletedTasks) deleted.set(id, Math.max(timestamp, deleted.get(id) || 0))
  for (const id of byId.keys()) {
    const deletedAt = deleted.get(id)
    if (deletedAt !== undefined) byId.delete(id)
  }
  const records = [...byId.values()].sort((a, b) => b.createdAt - a.createdAt)
  let completed = 0
  const retained = records.filter(record => {
    if (record.status === 'running' || ++completed <= TASK_HISTORY_LIMIT) return true
    deleted.set(record.id, Math.max(Date.now(), record.updatedAt))
    return false
  })
  return { records: retained, deleted }
}

function encodeSnapshot(snapshot: { records: TaskRecord[]; deleted: Map<string, number> }): StoredTaskSnapshot {
  return { version: 1, records: snapshot.records, deleted: Object.fromEntries(snapshot.deleted) }
}

/** Measure the bounded summary store without deciding that a tombstone is safe to discard. */
export function taskStorageDiagnostics(now = Date.now()): TaskStorageDiagnostics {
  const serialized = JSON.stringify(encodeSnapshot({ records: tasks.value, deleted: deletedTasks }))
  const oldestTombstoneAt = deletedTasks.size ? Math.min(...deletedTasks.values()) : null
  return {
    recordCount: tasks.value.length,
    tombstoneCount: deletedTasks.size,
    serializedBytes: typeof TextEncoder === 'function' ? new TextEncoder().encode(serialized).byteLength : serialized.length,
    oldestTombstoneAt,
    oldestTombstoneAgeMs: oldestTombstoneAt === null ? null : Math.max(0, now - oldestTombstoneAt),
    historyLimit: TASK_HISTORY_LIMIT,
    compaction: {
      policy: 'retain-tombstones',
      safeToDrop: false,
      reason: '尚无跨窗口确认水位；墓碑必须保留，不能按数量或年龄直接丢弃以免旧窗口复活已清理摘要。',
    },
  }
}

/**
 * Produce a compaction plan only after an external cross-window drain has
 * been confirmed. The task center never removes tombstones merely because a
 * count or age threshold was reached.
 */
export function planTaskSummaryCompaction(
  deleted: Record<string, number>,
  confirmation?: { watermark: number; staleWritersDrained: boolean },
): TaskSummaryCompactionPlan {
  const ids = Object.keys(deleted).sort((a, b) => (deleted[a] ?? 0) - (deleted[b] ?? 0))
  if (!confirmation || !Number.isFinite(confirmation.watermark) || confirmation.watermark <= 0 || !confirmation.staleWritersDrained) {
    return { eligibleIds: [], retainedIds: ids, safeToApply: false,
      reason: '需要明确确认水位，并证明旧窗口写入者已排空后才能删除墓碑。' }
  }
  const eligibleIds = ids.filter(id => (deleted[id] ?? Infinity) <= confirmation.watermark)
  const eligible = new Set(eligibleIds)
  return { eligibleIds, retainedIds: ids.filter(id => !eligible.has(id)), safeToApply: true,
    reason: '仅删除确认水位之前的墓碑；任务记录和未确认墓碑保持不变。' }
}

function persist() {
  if (hasRuntimeTasks()) return
  writeTail = writeTail.catch(() => {}).then(async () => {
    const saved = await updateTaskHistory(value => encodeSnapshot(mergeSnapshot(decodeSnapshot(value))))
    // Local progress may have changed while the transaction committed.
    const merged = mergeSnapshot(decodeSnapshot(saved))
    tasks.value = merged.records
    deletedTasks.clear()
    for (const [id, timestamp] of merged.deleted) deletedTasks.set(id, timestamp)
  }).then(() => { storageError.value = '' }).catch(() => { storageError.value = '任务摘要暂未保存；当前任务继续运行。' })
}
export function createTask(summary: TaskSummary, controls: TaskControls = {}): string {
  const id = `task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  tasks.value.unshift({ ...summary, id, createdAt: Date.now(), updatedAt: Date.now() })
  recordDiagnosticTask(id, summary.kind, summary.status)
  actions.set(id, controls)
  // Running work is never removed to make room for historical summaries.
  let completed = 0
  tasks.value = tasks.value.filter(task => task.status === 'running' || ++completed <= TASK_HISTORY_LIMIT)
  const retained = new Set(tasks.value.map(task => task.id))
  for (const key of actions.keys()) if (!retained.has(key)) actions.delete(key)
  persist()
  return id
}
export function updateTask(id: string, patch: Partial<TaskSummary>) {
  const task = tasks.value.find(item => item.id === id)
  if (!task) return
  if (patch.status && patch.status !== task.status) recordDiagnosticTask(id, task.kind, patch.status)
  Object.assign(task, patch, { updatedAt: Math.max(Date.now(), task.updatedAt + 1) })
  persist()
}
export function flushTaskSummaries() { return writeTail }
export function forgetTaskControls(id: string) { actions.delete(id) }
export function hydrateTasks(): Promise<void> {
  const read = () => hasRuntimeTasks() ? import('@/api/runtimeTasks').then(api => api.readRuntimeTaskHistory()) : readTaskHistory()
  return loading ??= read().then(value => {
    const snapshot = decodeSnapshot(value)
    // A user may clear tasks while the initial read is pending. Hydration must
    // merge those local tombstones instead of restoring an older snapshot.
    for (const [id, timestamp] of snapshot.deleted) deletedTasks.set(id, Math.max(timestamp, deletedTasks.get(id) || 0))
    const existing = new Set(tasks.value.map(task => task.id))
    for (const item of snapshot.records.slice(0, 100)) {
      if (existing.has(item.id) || tasks.value.some(task => task.backend?.kind === item.backend?.kind && task.backend?.id === item.backend?.id && item.backend)) continue
      existing.add(item.id)
      tasks.value.push({ ...item, status: item.status === 'running' ? 'interrupted' : item.status,
        message: item.status === 'running' ? '这是其他页面会话留下的记录，请回工作台检查进度或已保存结果。' : item.message })
    }
    tasks.value = mergeSnapshot({ records: tasks.value, deleted: snapshot.deleted }).records
    storageError.value = ''
  }).catch(error => { loading = undefined; storageError.value = '暂时无法读取之前的任务摘要，可重新尝试。'; throw error })
}

/** Reattach an owner to its persisted backend identity instead of creating a duplicate. */
function findBackendTask(summary: TaskSummary) {
  return summary.backend && tasks.value.find(task => task.backend?.kind === summary.backend?.kind && task.backend?.id === summary.backend?.id)
}
export function useTaskCenter() {
  return { tasks, opened, storageError, activeCount: computed(() => hasRuntimeTasks() ? runtimeTaskActiveCount.value : tasks.value.filter(task => task.status === 'running').length),
    storageDiagnostics: computed(() => taskStorageDiagnostics()),
    controls: (id: string) => actions.get(id),
    clearCompleted() {
      const keep = tasks.value.filter(task => task.status === 'running' || task.status === 'failed' || task.status === 'interrupted')
      const retained = new Set(keep.map(task => task.id))
      const deletedAt = Date.now()
      for (const task of tasks.value) if (!retained.has(task.id)) deletedTasks.set(task.id, deletedAt)
      for (const id of actions.keys()) if (!retained.has(id)) actions.delete(id)
      tasks.value = keep
      persist()
    },
  }
}

/** Attach work to its owner; deactivation keeps it alive, destruction is explicit. */
export function useTrackedTask(source: () => TaskSummary, controls: TaskControls = {}) {
  if (!getCurrentInstance()) return
  let id = ''
  let previous: TaskStatus = 'idle'
  watch(source, summary => {
    if (hasRuntimeTasks() && summary.kind !== 'interrogate') return
    const prior = tasks.value.find(task => task.id === id)
    if (summary.backend && prior?.backend && (summary.backend.id !== prior.backend.id || summary.backend.kind !== prior.backend.kind)) {
      forgetTaskControls(id); id = ''; previous = 'idle'
    }
    if (summary.status === 'idle') { if (id && previous === 'running') updateTask(id, { status: 'interrupted', message: summary.message || '任务未返回完成状态，请回工作台检查。' }); if (id) forgetTaskControls(id); id = ''; previous = 'idle'; return }
    if (!id) {
      const restored = findBackendTask(summary)
      if (restored) { id = restored.id; actions.set(id, controls) }
    }
    if (!id && summary.status !== 'running') { previous = summary.status; return }
    if (!id || !tasks.value.some(task => task.id === id) || (summary.status === 'running' && previous !== 'running' && previous !== 'idle')) {
      if (id) { const old = tasks.value.find(task => task.id === id); if (old?.resultRoute && !old.resultRoute.startsWith('/gallery')) updateTask(id, { resultRoute: undefined }); forgetTaskControls(id) }
      id = createTask(summary, controls)
    } else updateTask(id, summary)
    previous = summary.status
  }, { immediate: true })
  onUnmounted(() => {
    if (id && previous === 'running') updateTask(id, { status: 'interrupted', message: '工作台已关闭，请检查已接收任务或返回重试。' })
    forgetTaskControls(id)
  })
}
