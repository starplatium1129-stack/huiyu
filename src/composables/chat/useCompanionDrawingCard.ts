import { onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, shallowRef, watch } from 'vue'
import { changeCompanionDrawingItem, companionDrawingBatch, readCompanionDrawingPrompt, type CompanionBatch } from '@/api/companionDrawingApi'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'

export const drawingBatchActive = (batch: CompanionBatch | null) => batch?.state === 'running' || batch?.state === 'cancelling'

export function useCompanionDrawingCard(batchId: string) {
  const root = ref<HTMLElement>()
  const batch = shallowRef<CompanionBatch | null>(null)
  const editor = shallowRef<{ index: number; revision: number; prompt: string } | null>(null)
  const error = ref('')
  const busy = ref(false)
  const loading = ref(true)
  const visible = ref(false)
  let observer: IntersectionObserver | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let reading: AbortController | undefined
  let action: AbortController | undefined
  let active = true

  function stopReading() {
    clearTimeout(timer)
    reading?.abort()
    reading = undefined
  }
  function follow() {
    clearTimeout(timer)
    if (active && visible.value && !document.hidden && !busy.value && drawingBatchActive(batch.value)) {
      timer = setTimeout(() => { void reload() }, 2000)
    }
  }
  async function reload() {
    if (!active || !visible.value || document.hidden || busy.value) return
    stopReading()
    const current = reading = new AbortController()
    try {
      const latest = await companionDrawingBatch(batchId, 'GET', current.signal)
      if (current.signal.aborted) return
      batch.value = latest
      error.value = latest ? '' : '原出图卡暂不可用'
    } catch (reason) {
      if (!current.signal.aborted) error.value = reason instanceof Error ? reason.message : '出图进度暂不可用'
    } finally {
      if (reading === current) {
        reading = undefined
        loading.value = false
        if (!error.value) follow()
      }
    }
  }
  async function act(operation: (signal: AbortSignal) => Promise<void>) {
    if (busy.value || !active) return false
    stopReading()
    const current = action = new AbortController()
    busy.value = true
    error.value = ''
    try {
      await operation(current.signal)
      return !current.signal.aborted
    } catch (reason) {
      if (!current.signal.aborted) error.value = reason instanceof Error ? reason.message : '操作未确认，请刷新出图卡核对'
      return false
    } finally {
      if (action === current) {
        action = undefined
        busy.value = false
        if (!error.value) follow()
      }
    }
  }
  async function control(method: 'PATCH' | 'DELETE') {
    await act(async signal => {
      const latest = await companionDrawingBatch(batchId, method, signal)
      signal.throwIfAborted()
      batch.value = latest
      editor.value = null
    })
  }
  async function edit(index: number) {
    return act(async signal => {
      const latest = await readCompanionDrawingPrompt(batchId, index, signal)
      signal.throwIfAborted()
      if (latest) editor.value = { index, ...latest }
    })
  }
  async function update(index: number, operation: 'edit' | 'rerun', prompt?: string) {
    const expectedRevision = prompt !== undefined ? editor.value?.revision : batch.value?.revision
    if (expectedRevision === undefined) return false
    return act(async signal => {
      const latest = await changeCompanionDrawingItem(batchId, index, { operation, expectedRevision, prompt }, signal)
      signal.throwIfAborted()
      batch.value = latest
      editor.value = null
    })
  }
  function onVisibility() {
    if (document.hidden) stopReading()
    else void reload()
  }
  watch([visible, runtimeResourceIdentity], ([isVisible, owner], [, previousOwner]) => {
    if (owner !== previousOwner) {
      action?.abort()
      action = undefined
      busy.value = false
      batch.value = null
      editor.value = null
      error.value = ''
      loading.value = true
    }
    if (isVisible) void reload()
    else stopReading()
  })
  onMounted(() => {
    document.addEventListener('visibilitychange', onVisibility)
    observer = new IntersectionObserver(entries => {
      visible.value = entries.some(entry => entry.isIntersecting)
    }, { rootMargin: '160px' })
    if (root.value) observer.observe(root.value)
  })
  onActivated(() => { active = true; void reload() })
  onDeactivated(() => { active = false; stopReading() })
  onBeforeUnmount(() => {
    active = false
    observer?.disconnect()
    stopReading()
    action?.abort()
    document.removeEventListener('visibilitychange', onVisibility)
  })
  return { root, batch, editor, error, busy, loading, reload, control, edit, update }
}
