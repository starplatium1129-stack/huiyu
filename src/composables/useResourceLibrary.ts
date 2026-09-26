import { computed, ref } from 'vue'
import { resourceApi, type ResourceApi } from '../api/resourceApi'
import { isLocalStudioHost } from '../utils/runtimeEnvironment'
import type { ResourceAction, ResourceStatus } from '../../types/resources'

export function useResourceLibrary(api: ResourceApi = resourceApi, isLocal = isLocalStudioHost()) {
  const status = ref<ResourceStatus | null>(null)
  const error = ref('')
  const loading = ref(false)
  const submitting = ref(false)
  const selectedId = ref('')
  let generation = 0
  let poll: ReturnType<typeof setTimeout> | undefined
  let request: AbortController | null = null
  let command: AbortController | null = null
  let stopped = false
  const busy = computed(() => submitting.value || status.value?.busy === true)
  const selected = computed(() => status.value?.releases.find(item => item.id === selectedId.value) || null)
  const enabled = computed(() => isLocal && status.value?.managementEnabled === true && !busy.value && !error.value)
  const canImport = computed(() => enabled.value && !!selected.value && (selected.value.source === 'offline' || selected.value.downloaded))
  const canDownload = computed(() => enabled.value && selected.value?.source === 'http')
  const messages: Record<string, string> = { running: '正在处理资源', cancelling: '正在安全取消', completed: '资源操作已完成',
    failed: '资源操作失败', cancelled: '已取消，可继续恢复', interrupted: '上次操作被中断，可继续恢复' }
  const taskMessage = computed(() => status.value?.task ? messages[status.value.task.state] : '')

  function schedule() {
    clearTimeout(poll)
    if (!stopped && isLocal) poll = setTimeout(() => void refresh(), status.value?.busy ? 750 : 5000)
  }
  async function refresh(fresh = false) {
    if (!isLocal || stopped || loading.value || submitting.value) return
    const ticket = generation
    request = new AbortController()
    loading.value = true
    try {
      const result = await api.status(fresh, request.signal)
      if (ticket !== generation || stopped) return
      status.value = result
      error.value = ''
      if (!result.releases.some(item => item.id === selectedId.value)) selectedId.value = result.releases[0]?.id || ''
    } catch {
      if (ticket === generation && !stopped) error.value = '资源状态暂时无法读取，请重新检查。'
    } finally {
      if (ticket === generation) { loading.value = false; request = null; schedule() }
    }
  }
  async function run(action: ResourceAction) {
    if (!enabled.value || (action === 'import' && !canImport.value) || (action === 'download' && !canDownload.value)) return
    if (action === 'rollback' && !status.value?.canRollback) return
    generation++
    request?.abort(); request = null; loading.value = false
    clearTimeout(poll)
    command = new AbortController()
    submitting.value = true
    try {
      const result = await api.start(action, selectedId.value || undefined, command.signal)
      if (stopped) return
      if (status.value) status.value = { ...status.value, busy: true, mounted: false, task: result.task }
      error.value = ''
    } catch {
      if (!stopped) error.value = '操作结果尚未确认，正在重新读取任务状态。请勿重复提交。'
    } finally {
      submitting.value = false; command = null
      // A lost POST response can still mean the task started. Inspect it; never auto-retry a write.
      if (!stopped) await refresh()
    }
  }
  async function cancel() {
    const task = status.value?.task
    if (!isLocal || !task || !status.value?.busy || submitting.value) return
    generation++
    request?.abort(); request = null; loading.value = false
    clearTimeout(poll)
    submitting.value = true
    command = new AbortController()
    try {
      const result = await api.cancel(task.id, command.signal)
      if (!stopped && status.value) status.value = { ...status.value, task: result.task }
    } catch { if (!stopped) error.value = '取消尚未确认，请检查任务状态。' }
    finally { submitting.value = false; command = null; if (!stopped) await refresh() }
  }
  function stop() { stopped = true; generation++; clearTimeout(poll); request?.abort(); command?.abort(); loading.value = false }
  return { isLocal, status, error, loading, submitting, selectedId, selected, busy, enabled, canImport, canDownload,
    taskMessage, refresh, run, cancel, start() { stopped = false; void refresh() }, stop }
}
