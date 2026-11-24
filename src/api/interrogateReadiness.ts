import { apiClient } from './client'
import type { InterrogateAssistProvider } from './interrogateResult'

export type InterrogateAssistStatus =
  | { available: true; provider: InterrogateAssistProvider; model: string; label: string }
  | { available: false; provider: null; model: null; label: null }

export interface InterrogateReadiness {
  state: 'idle' | 'checking' | 'ready' | 'missing' | 'unknown'
  message: string
  assist?: InterrogateAssistStatus
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function decodeAssist(value: unknown): InterrogateAssistStatus | undefined {
  const assist = record(value)
  if (assist?.available === true && (assist.provider === 'chatgpt' || assist.provider === 'api')
    && typeof assist.model === 'string' && typeof assist.label === 'string') {
    return { available: true, provider: assist.provider, model: assist.model, label: assist.label }
  }
  if (assist?.available === false) return { available: false, provider: null, model: null, label: null }
}

/** The status endpoint inspects local files; it does not load PixAI or validate the GPU. */
function decodeInterrogateReadiness(value: unknown): InterrogateReadiness {
  const envelope = record(value), pixai = record(envelope?.pixai)
  if (envelope?.ok !== true || envelope.local !== true || envelope.defaultEngine !== 'pixai'
    || pixai?.engine !== 'pixai' || pixai.model !== 'pixai-tagger-v1.0'
    || ['available', 'modelPresent', 'dependencyPresent'].some(key => typeof pixai[key] !== 'boolean')
    || (pixai.reason !== null && typeof pixai.reason !== 'string')) {
    throw new Error('反推状态返回无效，请更新本地网关后重新检查。')
  }
  if (pixai.available === true && pixai.modelPresent === true && pixai.dependencyPresent === true) {
    return { state: 'ready', message: '已找到本地模型', assist: decodeAssist(envelope.assist) }
  }
  return { state: 'missing', message: pixai.modelPresent === false ? '尚未安装反推模型'
    : pixai.dependencyPresent === false ? '反推组件未准备好' : '反推暂不可用，请重新检查',
    assist: decodeAssist(envelope.assist) }
}

export async function readInterrogateReadiness(signal: AbortSignal, includePersonal = false): Promise<InterrogateReadiness> {
  const headers = includePersonal ? await (await import('./interrogateChatSettings')).interrogateChatHeaders(signal, false) : undefined
  return decodeInterrogateReadiness(await apiClient.request('/api/interrogate/status', {
    cache: 'no-store', cachePolicy: 'bypass', timeoutMs: 8000, signal, headers, redirect: 'error',
  }))
}
