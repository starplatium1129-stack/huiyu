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
  const activity = [pixai.loading === true ? '模型正在加载' : '', pixai.busy === true ? '正在处理图片' : '',
    pixai.cached === true ? '模型缓存已建立' : pixai.cached === false ? '模型尚未缓存' : ''].filter(Boolean).join('；')
  if (pixai.available === true && pixai.modelPresent === true && pixai.dependencyPresent === true) {
    return { state: 'ready', message: `PixAI 模型与依赖文件已发现；实际加载、CUDA 与反推效果仍需在使用时验证。${activity ? activity + '。' : ''}${pixai.reason ? `上次运行信息：${pixai.reason}` : ''}` }
  }
  const missing = [pixai.modelPresent === false ? '缺少完整 PixAI Tagger v1.0 模型文件' : '',
    pixai.dependencyPresent === false ? '缺少 timm 或 Torch 依赖文件' : '', pixai.reason || ''].filter(Boolean)
  return { state: 'missing', message: `${missing.join('；') || 'PixAI 本地运行环境未就绪'}。请按下方准备说明补齐后重新检查。` }
}

export function useInterrogateReadiness() {
  const status = ref<InterrogateReadiness>({ state: 'idle', message: '展开后检查本地 PixAI 模型与依赖。' })
  let controller: AbortController | null = null, disposed = false
  if (getCurrentScope()) onScopeDispose(() => { disposed = true; controller?.abort(); controller = null })
  async function refresh(signal?: AbortSignal): Promise<boolean> {
    if (disposed || signal?.aborted) return false
    controller?.abort()
    const active = new AbortController(); controller = active
    const abort = () => active.abort()
    signal?.addEventListener('abort', abort, { once: true })
    status.value = { state: 'checking', message: '正在检查本地 PixAI 模型与依赖…' }
    try {
      const result = await apiClient.request('/api/interrogate/status', { cache: 'no-store', cachePolicy: 'bypass', timeoutMs: 8000, signal: active.signal })
      if (disposed || controller !== active || active.signal.aborted) return false
      status.value = decodeInterrogateReadiness(result)
      return status.value.state === 'ready'
    } catch (error) {
      if (disposed || controller !== active) return false
      status.value = { state: 'unknown', message: active.signal.aborted ? '本次状态检查已取消，可重新检查。'
        : `暂时无法确认 PixAI 状态：${error instanceof Error ? error.message : String(error)} 请确认正在使用本机绘遇、网关已启动，再重新检查。` }
      return false
    } finally {
      signal?.removeEventListener('abort', abort)
      if (controller === active) controller = null
    }
  }
  return { status, available: computed(() => status.value.state === 'ready'), checking: computed(() => status.value.state === 'checking'), refresh }
}
