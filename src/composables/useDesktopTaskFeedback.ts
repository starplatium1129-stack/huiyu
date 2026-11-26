import { computed, onScopeDispose, ref, watch } from 'vue'
import { getRuntimeTaskSummary } from '@/api/runtimeTasks'
import { desktopRuntimeIdentity, getDesktopRuntime, onDesktopRuntime } from '@/platform/desktop/runtime'
import { desktopShell } from '@/platform/desktop/shell'
import { pendingTaskRequests, runtimeTasks } from '@/stores/runtimeTaskState'

export function useDesktopTaskFeedback() {
  const authority = ref(desktopRuntimeIdentity())
  const connected = ref(getDesktopRuntime().connection === 'ready')
  const stop = onDesktopRuntime(state => {
    authority.value = desktopRuntimeIdentity()
    connected.value = state.connection === 'ready'
  })
  const active = computed(() => runtimeTasks.value.filter(task => !task.upstreamSettled))
  const singleRunning = computed(() => connected.value && active.value.length === 1
    && active.value[0].status === 'running' ? active.value[0].taskId : '')
  const progress = ref<number | null>(null)
  watch([singleRunning, authority], ([taskId], _previous, cleanup) => {
    progress.value = null
    if (!taskId) return
    const controller = new AbortController()
    let timer: number | undefined
    cleanup(() => { controller.abort(); window.clearTimeout(timer) })
    const read = async () => {
      try {
        const task = await getRuntimeTaskSummary(taskId, controller.signal)
        if (controller.signal.aborted) return
        const value = task.liveProgress?.value
        progress.value = task.status === 'running' && typeof value === 'number' && Number.isFinite(value)
          ? Math.round(Math.max(0, Math.min(1, value)) * 100) : null
      } catch { /* The taskbar keeps its indeterminate state until feedback returns. */ }
      finally {
        if (!controller.signal.aborted) timer = window.setTimeout(read, document.hidden ? 8000 : 3000)
      }
    }
    void read()
  }, { immediate: true })

  const busy = computed(() => Boolean(active.value.length || pendingTaskRequests.value.length))
  watch([busy, progress, connected], ([running, value, ready]) => {
    void desktopShell.taskProgress(running, ready ? value : null).catch(() => {})
  }, { immediate: true })

  const watched = new Set<string>()
  watch(authority, () => watched.clear(), { flush: 'sync' })
  watch(runtimeTasks, tasks => {
    const live = new Set<string>()
    for (const task of tasks) {
      live.add(task.taskId)
      if (!task.upstreamSettled) watched.add(task.taskId)
      else if (watched.delete(task.taskId) && task.status === 'succeeded') {
        void desktopShell.notifyTask(task.taskId, task.kind).catch(() => {})
      }
    }
    for (const id of watched) if (!live.has(id)) watched.delete(id)
  }, { immediate: true })

  onScopeDispose(() => {
    stop()
    if (busy.value) void desktopShell.taskProgress(false, null).catch(() => {})
  })
}
