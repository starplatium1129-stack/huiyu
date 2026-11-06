import { computed, getCurrentScope, onScopeDispose, ref } from 'vue'
import { readInterrogateReadiness, type InterrogateReadiness } from '@/api/interrogateReadiness'

export function useInterrogateReadiness() {
  const status = ref<InterrogateReadiness>({ state: 'idle', message: '尚未检查' })
  let controller: AbortController | null = null, disposed = false
  if (getCurrentScope()) onScopeDispose(() => { disposed = true; controller?.abort(); controller = null })
  async function refresh(signal?: AbortSignal): Promise<boolean> {
    if (disposed || signal?.aborted) return false
    controller?.abort()
    const active = new AbortController(); controller = active
    const abort = () => active.abort()
    signal?.addEventListener('abort', abort, { once: true })
    status.value = { state: 'checking', message: '检查中…' }
    try {
      const result = await readInterrogateReadiness(active.signal)
      if (disposed || controller !== active || active.signal.aborted) return false
      status.value = result
      return status.value.state === 'ready'
    } catch (error) {
      if (disposed || controller !== active) return false
      if (!active.signal.aborted) console.warn('[interrogate] Readiness check failed', error)
      status.value = { state: 'unknown', message: active.signal.aborted ? '检查已取消' : '暂时无法检查，请重试' }
      return false
    } finally {
      signal?.removeEventListener('abort', abort)
      if (controller === active) controller = null
    }
  }
  return { status, available: computed(() => status.value.state === 'ready'), checking: computed(() => status.value.state === 'checking'), refresh }
}
