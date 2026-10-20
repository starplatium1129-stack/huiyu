/**
 * 本机网关识别。网关转发 OpenAI 兼容转写请求，
 * 页面只连接应用自己的运行时，不直接连接服务商。
 */

import { speechInputEndpointError, type SpeechInputConfig } from '@/utils/speechInputConfig'
import { runtimeFetch } from '@/platform/runtimeUrl'
import { apiClient } from '@/api/client'

export async function probeSpeechService(config: SpeechInputConfig, signal?: AbortSignal): Promise<{ state: 'ok' | 'unknown'; message: string }> {
  return apiClient.request('/api/speech-input/probe', {
    method: 'POST', timeoutMs: 12_000, signal,
    body: { endpoint: config.endpoint, model: config.model, apiKey: config.apiKey, language: config.language },
    validate: value => value.ok === true && ['ok', 'unknown'].includes(String(value.state)) && typeof value.message === 'string',
  })
}

export interface AsrResult {
  text: string
  /** 识别耗时（ms） */
  latencyMs: number
}

export interface AsrError extends Error {
  kind: 'network' | 'http' | 'payload' | 'canceled' | 'timeout'
  status?: number
}

function asrError(kind: AsrError['kind'], message: string, status?: number): AsrError {
  const error = new Error(message) as AsrError
  error.kind = kind
  if (status !== undefined) error.status = status
  return error
}

/**
 * 调用 ASR 端点识别一段 WAV。signal 支持取消，120 秒期限覆盖响应正文读取。
 * 抛出的错误带 kind/status，UI 可据此分类展示。
 */
export async function recognizeWithAsr(
  config: SpeechInputConfig,
  wavBytes: Uint8Array,
  signal?: AbortSignal,
): Promise<AsrResult> {
  if (signal?.aborted) throw asrError('canceled', '语音识别已取消')
  const configError = speechInputEndpointError(config.endpoint)
  if (configError) throw asrError('payload', configError)
  const started = Date.now()
  const form = new FormData()
  form.append('file', new Blob([wavBytes as BlobPart], { type: 'audio/wav' }), 'speech.wav')
  for (const key of ['endpoint', 'model', 'apiKey', 'language'] as const) form.append(key, config[key])
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, 120_000)
  try {
    let response: Response
    try {
      response = await runtimeFetch('/api/speech-input/transcribe', {
        method: 'POST',
        body: form,
        signal: controller.signal,
      })
    } catch (error) {
      throw asrError('network', `无法连接语音识别服务：${error instanceof Error ? error.message : String(error)}`)
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw asrError('payload', '语音识别服务返回了无法解析的内容')
    }

    const value = payload && typeof payload === 'object' ? payload as Record<string, unknown> : null
    if (!response.ok || value?.ok === false) {
      const message = typeof value?.error === 'string' ? value.error : `语音识别服务返回 ${response.status}`
      throw asrError(value?.code === 'SPEECH_TIMEOUT' ? 'timeout' : 'http', message, response.status)
    }
    const text = (payload && typeof payload === 'object' && 'text' in payload
      ? (payload as { text?: unknown }).text
      : null) as string | null
    if (typeof text !== 'string' || !text.trim()) {
      throw asrError('payload', '没有识别到文字，请靠近麦克风说话后重试。')
    }
    return { text: text.trim(), latencyMs: Date.now() - started }
  } catch (error) {
    if (signal?.aborted) throw asrError('canceled', '语音识别已取消')
    if (timedOut) throw asrError('timeout', '语音识别超时，请稍后重试')
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
