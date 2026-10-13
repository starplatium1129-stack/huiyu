import { computed, getCurrentScope, onScopeDispose, ref } from 'vue'
import { apiClient } from '@/api/client'

export interface InterrogateReadiness {
  state: 'idle' | 'checking' | 'ready' | 'missing' | 'unknown'
  message: string
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** The status endpoint inspects local files; it does not load PixAI or validate the GPU. */
export function decodeInterrogateReadiness(value: unknown): InterrogateReadiness {
  const envelope = record(value), pixai = record(envelope?.pixai)
  if (envelope?.ok !== true || envelope.local !== true || envelope.defaultEngine !== 'pixai'
    || pixai?.engine !== 'pixai' || pixai.model !== 'pixai-tagger-v1.0'
    || ['available', 'modelPresent', 'dependencyPresent'].some(key => typeof pixai[key] !== 'boolean')
    || (pixai.reason !== null && typeof pixai.reason !== 'string')) {
    throw new Error('反推状态返回无效，请更新本地网关后重新检查。')
  }
  if (pixai.available === true && pixai.modelPresent === true && pixai.dependencyPresent === true) {
    return { state: 'ready', message: '已找到本地模型' }
  }
  return { state: 'missing', message: pixai.modelPresent === false ? '尚未安装反推模型'
    : pixai.dependencyPresent === false ? '反推组件未准备好' : '反推暂不可用，请重新检查' }
}

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
      const result = await apiClient.request('/api/interrogate/status', { cache: 'no-store', cachePolicy: 'bypass', timeoutMs: 8000, signal: active.signal })
      if (disposed || controller !== active || active.signal.aborted) return false
      status.value = decodeInterrogateReadiness(result)
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
