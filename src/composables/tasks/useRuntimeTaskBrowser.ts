import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { readRuntimeTaskPage } from '@/api/runtimeTasks'
import { runtimeTasks } from '@/stores/runtimeTaskState'
import { getDesktopRuntime, onDesktopRuntime } from '@/platform/desktop/runtime'
import type { TaskPage, TaskSummary } from '../../../types/tasks'

const PAGE_SIZE = 30
export function useRuntimeTaskBrowser(active: () => boolean) {
  const selected = ref<'all' | 'active' | 'attention' | 'inbox'>('all')
  const page = shallowRef<TaskPage | null>(null), cursors = ref<number[]>([]), activePage = ref(0)
  const loading = ref(false), error = ref('')
  let controller: AbortController | undefined
  const live = computed(() => new Map(runtimeTasks.value.map(task => [task.taskId, task])))
  const matches = (task: TaskSummary) => selected.value === 'all' || (selected.value === 'active' ? !task.upstreamSettled
    : selected.value === 'inbox' ? task.resultRefs.length && !['saved', 'discarded'].includes(task.deliveryState)
      : task.recoveryState !== 'normal' || task.status === 'failed')
  const activeItems = computed(() => runtimeTasks.value.filter(task => !task.upstreamSettled))
  const visible = computed(() => selected.value === 'active'
    ? activeItems.value.slice(activePage.value * PAGE_SIZE, (activePage.value + 1) * PAGE_SIZE)
    : (page.value?.items ?? []).map(task => {
      const current = live.value.get(task.taskId)
      return current && current.revision >= task.revision ? current : task
    }).filter(matches))
  const pageNumber = computed(() => (selected.value === 'active' ? activePage.value : cursors.value.length) + 1)
  const hasPrevious = computed(() => pageNumber.value > 1)
  const hasNext = computed(() => selected.value === 'active'
    ? activeItems.value.length > (activePage.value + 1) * PAGE_SIZE : page.value?.nextCursor != null)
  async function load(nextCursors = cursors.value, reset = false) {
    controller?.abort()
    if (!active() || selected.value === 'active') { loading.value = false; return }
    const request = new AbortController(); controller = request
    loading.value = true; error.value = ''
    try {
      const result = await readRuntimeTaskPage(selected.value, { before: nextCursors.at(-1),
        through: reset ? undefined : page.value?.throughRevision, limit: PAGE_SIZE, signal: request.signal })
      if (request.signal.aborted) return
      page.value = result; cursors.value = [...nextCursors]
    } catch (reason) {
      if (!request.signal.aborted) error.value = reason instanceof Error ? reason.message : '任务历史读取失败，请重试'
    } finally { if (controller === request) loading.value = false }
  }
  function refresh() { return load([], true) }
  function next() {
    if (loading.value || !hasNext.value) return
    if (selected.value === 'active') activePage.value++
    else if (page.value?.nextCursor != null) void load([...cursors.value, page.value.nextCursor])
  }
  function previous() {
    if (loading.value || !hasPrevious.value) return
    if (selected.value === 'active') activePage.value--
    else void load(cursors.value.slice(0, -1))
  }
  watch([active, selected], ([opened, filter], previous) => {
    controller?.abort(); loading.value = false
    if (filter !== previous?.[1]) { page.value = null; cursors.value = []; activePage.value = 0; error.value = '' }
    if (opened) void load()
  }, { immediate: true })
  watch(() => activeItems.value.length, count => { activePage.value = Math.min(activePage.value, Math.max(0, Math.ceil(count / PAGE_SIZE) - 1)) })
  const identity = () => getDesktopRuntime().bootstrap?.runtime?.workspace?.runtimeEpoch || ''
  let currentEpoch = identity()
  const stopRuntime = onDesktopRuntime(() => {
    const nextEpoch = identity()
    if (!nextEpoch || nextEpoch === currentEpoch) return
    currentEpoch = nextEpoch; controller?.abort(); page.value = null; cursors.value = []; activePage.value = 0
    if (active()) void refresh()
  })
  onScopeDispose(() => { controller?.abort(); stopRuntime() })
  return { selected, visible, loading, error, pageNumber, hasPrevious, hasNext, refresh, next, previous }
}
