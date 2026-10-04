import { runtimeFetch } from '../platform/runtimeUrl.ts'
import { useTrackedTask } from './useTaskCenter.ts'
import { getCurrentScope, getCurrentInstance, onActivated, onDeactivated, onScopeDispose, ref } from 'vue'
import { decodeInterrogateResult, type InterrogateMode, type InterrogateResult } from '../api/interrogateResult.ts'
export type { InterrogateMode, InterrogateResult } from '../api/interrogateResult.ts'

const API = '/api/interrogate'
const MAX_BYTES = 20 * 1024 * 1024
// Both mounted entry points write the same reference draft. The latest request
// owns that draft, while separate application roots remain independent.
const activeRequests = new WeakMap<object, () => void>()

function fileToDataUrl(file: File, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    const cleanup = () => signal.removeEventListener('abort', abort)
    const abort = () => {
      cleanup()
      reader.abort()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    reader.onload = () => { cleanup(); resolve(String(reader.result || '')) }
    reader.onerror = () => { cleanup(); reject(new Error('读取图片失败')) }
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
    reader.readAsDataURL(file)
  })
}

/**
 * 反推失败的可读文案（2026-08-30 UX 审计）。
 *
 * 此前非 2xx 一律 `throw new Error('反推失败：' + res.status)`——用户看到的是
 * 一个 HTTP 状态码，既不知道为什么，也不知道该怎么办。后端已经在信封里带了
 * 中文的 error 文案，这里把它保留下来，再按状态码补一句可操作的下一步。
 *
 * 刻意不复用 sdError 的分类器：那一套是出图语义（WebUI/Comfy、采样器、LoRA），
 * 用在反推上会给出「关闭高清修复」这类驴唇不对马嘴的建议。
 */
function interrogateFailure(status: number, backendMessage: string): string {
  const hint =
    status === 413 ? '图片体积超出网关上限，换一张小一些的图重试。'
    : status === 429 ? '反推请求太频繁，稍等几秒再试。'
    : status === 400 ? '请求被网关拒绝，通常是图片格式或体积不合要求。'
    : status === 404 ? '反推接口不可用，请确认网关已启动到最新版本。'
    : status >= 500 ? '请检查 PixAI 模型、GPU 显存与本地推理依赖后重试。'
    : status === 0 ? '无法连接网关，请确认服务已启动。'
    : '请稍后重试；若持续失败，检查网关与 PixAI 反推模型。'
  // 后端给的中文文案优先，状态码提示作为补充，不重复拼接。
  return backendMessage ? `${backendMessage}（${hint}）` : `反推失败：${hint}`
}

export function useInterrogate() {
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
      let file: File
      // Clipboard permission/loading belongs to the same busy/cancel owner as
      // current-image loading, before any image can reach the POST.
      if (typeof source === 'function') {
        let abortLoading = () => {}
        try {
          file = await new Promise<File>((resolve, reject) => {
            abortLoading = () => reject(new DOMException('Aborted', 'AbortError'))
            controller.signal.addEventListener('abort', abortLoading, { once: true })
            source().then(resolve, reject)
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
      if (!file) throw new Error('请选择图片')
      if (file.size > MAX_BYTES) throw new Error('图片超过 20MB 限制')
      if (!file.type.startsWith('image/')) throw new Error('仅支持图片文件')
      const dataUrl = await fileToDataUrl(file, controller.signal)
      if (activeController !== controller) return null
      controller.signal.throwIfAborted()
      // 后端接受 base64 或 dataURL，传 dataURL 更省一次前缀判断
      const res = await runtimeFetch(API, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl, mode: mode, threshold: threshold })
      })
      const json: unknown = await res.json().catch(() => null)
      if (activeController !== controller) return null
      controller.signal.throwIfAborted()
      const envelope = json && typeof json === 'object' && !Array.isArray(json) ? json as Record<string, unknown> : null
      if (!res.ok || !envelope || envelope.ok !== true) {
        const backendMessage = typeof envelope?.error === 'string' ? envelope.error
          : typeof envelope?.message === 'string' ? envelope.message : ''
        throw new Error(interrogateFailure(res.status, backendMessage))
      }
      const data = decodeInterrogateResult(envelope, mode)
      lastResult.value = data
      return data
    } catch (e: unknown) {
      if (activeController !== controller) return null
      // fetch 的网络失败（网关没起）抛的是 TypeError，消息是浏览器的
      // "Failed to fetch"，同样属于「看不懂」，在这里一并换成可读文案。
      const isNetwork = e instanceof TypeError
      const message = controller.signal.aborted
        ? '反推超时，请检查本地模型状态后重试'
        : isNetwork
        ? interrogateFailure(0, '')
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

  useTrackedTask(() => ({ kind: 'interrogate', title: '图片反推', route: '/prompt-builder', status: busy.value ? 'running' : cancelled.value ? 'cancelled' : error.value ? 'failed' : lastResult.value ? 'succeeded' : 'idle', message: error.value || (busy.value ? 'PixAI 正在反推；首次需加载模型，后续复用 GPU 常驻模型' : cancelled.value ? '图片反推已取消' : '反推结果已送回工作台') }), { cancel })
  return { busy, error, lastResult, interrogate, cancel }
}
