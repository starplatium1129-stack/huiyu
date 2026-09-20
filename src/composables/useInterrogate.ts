import { useTrackedTask } from '@/composables/useTaskCenter'
import { ref } from 'vue'

export type InterrogateMode = 'tag' | 'caption'
export interface InterrogateResult {
  engine: string
  model?: string
  mode: InterrogateMode
  threshold: number
  tags: string[]
  scores: Record<string, number>
  caption: string
  captionDerived?: string
  characterTags?: string[]
  rating?: Record<string, number>
  warning?: string
}

const API = '/api/interrogate'
const MAX_BYTES = 12 * 1024 * 1024

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('读取图片失败'))
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
    : status >= 500 ? '反推服务内部出错，WD14 模型可能尚未就绪，可稍后重试。'
    : status === 0 ? '无法连接网关，请确认服务已启动。'
    : '请稍后重试；若持续失败，检查网关与 WD14 反推模型。'
  // 后端给的中文文案优先，状态码提示作为补充，不重复拼接。
  return backendMessage ? `${backendMessage}（${hint}）` : `反推失败：${hint}`
}

export function useInterrogate() {
  const busy = ref(false)
  const error = ref<string | null>(null)
  const lastResult = ref<InterrogateResult | null>(null)

  async function interrogate(file: File, mode: InterrogateMode = 'tag', threshold = 0.35): Promise<InterrogateResult | null> {
    if (busy.value) return null
    busy.value = true
    error.value = null
    lastResult.value = null
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 120_000)
    try {
      if (!file) throw new Error('请选择图片')
      if (file.size > MAX_BYTES) throw new Error('图片超过 12MB 限制')
      if (!file.type.startsWith('image/')) throw new Error('仅支持图片文件')
      const dataUrl = await fileToDataUrl(file)
      // 后端接受 base64 或 dataURL，传 dataURL 更省一次前缀判断
      const res = await fetch(API, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl, mode: mode, threshold: threshold })
      })
      const json = (await res.json().catch(() => null)) as { ok?: boolean; data?: InterrogateResult; error?: string; message?: string } | null
      if (!res.ok || !json || json.ok !== true) {
        const backendMessage = (json && (json.error || json.message)) || ''
        throw new Error(interrogateFailure(res.status, backendMessage))
      }
      // 后端信封是 { ok:true, ...payload }，payload 直接平铺在顶层；
      // 兼容历史/未来可能的 { ok:true, data: {...} } 两种形态。
      const data = (json.data ?? json) as InterrogateResult
      if (data.engine === 'heuristic') {
        throw new Error(data.warning || '本地反推模型不可用，演示标签未写入工作台，请检查 WD14 模型后重试')
      }
      if (!Array.isArray(data.tags) || typeof data.caption !== 'string') throw new Error('反推服务返回了无效结果，请重试')
      lastResult.value = data
      return data
    } catch (e: unknown) {
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
      busy.value = false
    }
  }

  useTrackedTask(() => ({ kind: 'interrogate', title: '图片反推', route: '/prompt-builder', status: busy.value ? 'running' : error.value ? 'failed' : lastResult.value ? 'succeeded' : 'idle', message: error.value || (busy.value ? '正在读取图片特征…' : '反推结果已送回工作台') }))
  return { busy, error, lastResult, interrogate }
}
