import { useInterrogateReadiness } from './useInterrogateReadiness'
import { runtimeFetch } from '../platform/runtimeUrl.ts'
import { useTrackedTask } from './useTaskCenter.ts'
import { abortableTask } from '@/utils/abortableTask'
import { getCurrentScope, getCurrentInstance, onActivated, onDeactivated, onScopeDispose, ref } from 'vue'
import type { InterrogateMode, InterrogateResult } from '../api/interrogateResult.ts'
export type { InterrogateMode, InterrogateResult } from '../api/interrogateResult.ts'

// Both mounted entry points write the same reference draft. The latest request
// owns that draft, while separate application roots remain independent.
const activeRequests = new WeakMap<object, () => void>()

export function useInterrogate() {
  const readiness = useInterrogateReadiness()
  const appContext = getCurrentInstance()?.appContext
  const busy = ref(false)
  const error = ref<string | null>(null)
  const lastResult = ref<InterrogateResult | null>(null)

  const cancelled = ref(false)
  let activeController: AbortController | null = null
  let disposed = false, viewActive = true
  function cancel() {
    if (!activeController) return
    const controller = activeController
    activeController = null
    cancelled.value = true
    busy.value = false
    if (appContext && activeRequests.get(appContext) === cancel) activeRequests.delete(appContext)
    controller.abort()
  }
  if (appContext) {
    onDeactivated(() => { viewActive = false; cancel() })
    onActivated(() => { viewActive = true })
  }
  if (getCurrentScope()) onScopeDispose(() => { disposed = true; cancel() })

  async function interrogate(source: File | string | (() => Promise<File>), mode: InterrogateMode = 'tag', threshold = 0.17): Promise<InterrogateResult | null> {
    if (busy.value || disposed || !viewActive) return null
    if (appContext) activeRequests.get(appContext)?.()
    busy.value = true
    cancelled.value = false
    error.value = null
    lastResult.value = null
    const controller = new AbortController()
    activeController = controller
    if (appContext) activeRequests.set(appContext, cancel)
    const timeout = setTimeout(() => controller.abort(), 120_000)
    try {
      // Start user-activated clipboard reads before the first await. Consume
      // rejection immediately while readiness is pending; nothing is uploaded
      // until both this source and the latest local status have succeeded.
      const requestedSource = typeof source === 'function'
        ? source().then(file => ({ file }), failure => ({ failure })) : null
      if (!(await readiness.refresh(controller.signal))) {
        controller.signal.throwIfAborted()
        throw new Error(readiness.status.value.message)
      }
      if (activeController !== controller) return null
      let file: File
      // Clipboard permission/loading belongs to the same busy/cancel owner as
      // current-image loading, before any image can reach the POST.
      if (typeof source === 'function') {
        let abortLoading = () => {}
        try {
          file = await new Promise<File>((resolve, reject) => {
            abortLoading = () => reject(new DOMException('Aborted', 'AbortError'))
            controller.signal.addEventListener('abort', abortLoading, { once: true })
            requestedSource!.then(outcome => { if ('failure' in outcome) reject(outcome.failure); else resolve(outcome.file) })
          })
        } finally { controller.signal.removeEventListener('abort', abortLoading) }
      } else if (typeof source === 'string') {
        const response = await runtimeFetch(source, { signal: controller.signal })
        if (!response.ok) throw new Error('获取当前成片失败，请重试或上传图片')
        const blob = await response.blob()
        file = new File([blob], 'current_result.png', { type: blob.type || 'image/png' })
      } else file = source
      if (activeController !== controller) return null
      controller.signal.throwIfAborted()
      const { interrogateImageFile } = await abortableTask(() => import('../api/interrogateImage.ts'), controller.signal)
      if (activeController !== controller) return null
      controller.signal.throwIfAborted()
      const data = await interrogateImageFile(file, controller.signal, mode, threshold)
      if (activeController !== controller) return null
      controller.signal.throwIfAborted()
      lastResult.value = data
      return data
    } catch (e: unknown) {
      if (activeController !== controller) return null
      // fetch 的网络失败（网关没起）抛的是 TypeError，消息是浏览器的
      // "Failed to fetch"，同样属于「看不懂」，在这里一并换成可读文案。
      const isNetwork = e instanceof TypeError
      const message = controller.signal.aborted
        ? '反推超时，请重试'
        : isNetwork
        ? '无法连接反推服务，请重试'
        : (e instanceof Error ? e.message : String(e))
      error.value = message || '反推失败'
      throw new Error(error.value)
    } finally {
      clearTimeout(timeout)
      if (activeController === controller) {
        activeController = null
        busy.value = false
        if (appContext && activeRequests.get(appContext) === cancel) activeRequests.delete(appContext)
      }
    }
  }

  useTrackedTask(() => ({ kind: 'interrogate', title: '图片反推', route: '/prompt-builder', status: busy.value ? 'running' : cancelled.value ? 'cancelled' : error.value ? 'failed' : lastResult.value ? 'succeeded' : 'idle', message: error.value || (busy.value ? '正在反推图片…' : cancelled.value ? '图片反推已取消' : '反推结果已送回工作台') }), { cancel })
  return { busy, error, lastResult, interrogate, cancel }
}
