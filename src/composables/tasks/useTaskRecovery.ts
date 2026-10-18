import { onUnmounted, ref, watch } from 'vue'
import { hydrateTasks, updateTask, useTaskCenter, type TaskRecord } from '@/composables/useTaskCenter'
import { cancelRecoveredTask, queryTask } from './taskRecovery'
import { hasRuntimeTasks } from '@/api/runtimeTaskAuthority'
import { runtimeTasksEnabled } from '@/stores/runtimeTaskState'

export function useTaskRecovery() {
  const center = useTaskCenter()
  const refreshing = ref(false)
  const error = ref('')
  let disposed = false, refreshAgain = false, tail = Promise.resolve()
  let sweep: Promise<void> | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let reading: { id: string; controller: AbortController } | undefined
  const cancellations = new Map<string, AbortController>()
  const current = (id: string) => center.tasks.value.find(task => task.id === id)
  const enabled = () => !runtimeTasksEnabled.value && !hasRuntimeTasks()
  const targets = (includeInterrupted = true) => enabled() ? center.tasks.value.filter(task => task.backend && !center.controls(task.id)
    && (task.status === 'running' || includeInterrupted && task.status === 'interrupted')) : []
  const snapshot = (task: TaskRecord): TaskRecord => ({ ...task, backend: task.backend && { ...task.backend } })
  function unchanged(task: TaskRecord, signal: AbortSignal) {
    const value = current(task.id)
    if (!value) return false
    return !disposed && enabled() && !signal.aborted && !center.controls(task.id) && value.updatedAt === task.updatedAt
      && value.backend?.id === task.backend?.id && value.backend?.kind === task.backend?.kind
  }
  function enqueue(run: () => Promise<void>) {
    const operation = tail.then(run)
    tail = operation.catch(() => {})
    return operation
  }
  function schedule() {
    clearTimeout(timer); timer = undefined
    if (disposed || sweep || cancellations.size || !targets().some(task => task.status === 'running')) return
    timer = setTimeout(() => { void refresh(false) }, 1500)
  }
  function requestRefresh() {
    if (disposed || !enabled()) return
    if (sweep || cancellations.size) refreshAgain = true
    else void refresh()
  }
  function refresh(includeInterrupted = true): Promise<void> {
    if (disposed || !enabled()) return Promise.resolve()
    if (sweep) return sweep
    clearTimeout(timer); timer = undefined
    refreshing.value = true; error.value = ''
    const controller = new AbortController(), { signal } = controller
    let hydrated = false
    const operation = enqueue(async () => {
      if (disposed || !enabled() || signal.aborted) return
      reading = { id: '', controller }
      try {
        await hydrateTasks(); hydrated = true
        // One serial reader owns startup, handoff, manual refresh and polling.
        for (const candidate of targets(includeInterrupted)) {
          if (disposed || !enabled() || signal.aborted) break
          if (center.controls(candidate.id) || cancellations.has(candidate.id)) continue
          const task = snapshot(candidate)
          reading.id = task.id
          try {
            const patch = await queryTask(task, signal)
            if (unchanged(task, signal)) updateTask(task.id, patch)
          } catch {
            if (unchanged(task, signal)) {
              error.value = '部分任务状态暂时无法查询，请重试；不会自动重新提交任务。'
              updateTask(task.id, { status: 'interrupted', stage: 'unknown', progress: null, message: error.value })
            }
          }
        }
      } catch { if (!disposed && !signal.aborted) error.value = '任务记录读取失败，请重试。' }
      finally { if (reading?.controller === controller) reading = undefined }
    }).finally(() => {
      sweep = undefined; refreshing.value = false
      if (refreshAgain) { refreshAgain = false; requestRefresh() }
      else if (hydrated) schedule()
    })
    sweep = operation
    return operation
  }
  async function cancel(id: string) {
    if (disposed || !enabled() || !current(id)?.backend || center.controls(id) || cancellations.has(id)) return
    clearTimeout(timer); timer = undefined
    reading?.controller.abort()
    const controller = new AbortController(), { signal } = controller
    cancellations.set(id, controller)
    try {
      await enqueue(async () => {
        if (disposed || !enabled() || signal.aborted || center.controls(id)) return
        const value = current(id)
        if (!value?.backend) return
        const task = snapshot(value)
        reading = { id, controller }
        try {
          // A synchronous owner-change watcher aborts this signal, including
          // while the mutation helper is waiting for its dynamic API import.
          await cancelRecoveredTask(task, signal)
          signal.throwIfAborted()
          const patch = await queryTask(task, signal)
          if (unchanged(task, signal)) updateTask(id, patch)
        } finally { if (reading?.controller === controller) reading = undefined }
      })
    } finally {
      cancellations.delete(id)
      if (refreshAgain) { refreshAgain = false; requestRefresh() }
      else schedule()
    }
  }
  let knownTargets = new Set<string>()
  watch(() => `${enabled()}:${center.tasks.value.map(task => `${task.id}:${task.status}:${task.backend?.kind || ''}:${task.backend?.id || ''}:${Boolean(center.controls(task.id))}`).join('|')}`, () => {
    const reclaiming = !enabled() || Boolean(reading?.id && (center.controls(reading.id) || !current(reading.id)?.backend))
    if (reclaiming) reading?.controller.abort()
    for (const [id, controller] of cancellations) if (!enabled() || center.controls(id) || !current(id)?.backend) controller.abort()
    const next = new Set(targets().map(task => task.id)), gained = [...next].some(id => !knownTargets.has(id))
    knownTargets = next
    if (reading?.id !== '' && (gained || reclaiming && next.size)) requestRefresh()
    else schedule()
  }, { flush: 'sync' })
  onUnmounted(() => {
    disposed = true; clearTimeout(timer); reading?.controller.abort()
    cancellations.forEach(controller => controller.abort())
  })
  return { refreshing, error, refresh, cancel }
}
