/**
 * ASR 请求抽象：WAV 编码 + OpenAI 兼容 /audio/transcriptions 请求构造。
 *
 * 纯函数部分（encodeWav16k / buildAsrRequestParts）可直测；
 * recognizeWithAsr 是薄 fetch 封装，错误统一抛出带原因的消息。
 */

import type { SpeechInputConfig } from './speechInputConfig'

/** 将 16kHz 单声道 Float32 采样编码为标准 WAV（PCM16），可测纯函数。 */
export function encodeWav16k(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytesPerSample = 2
  const dataSize = samples.length * bytesPerSample
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  const writeAscii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }

  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * bytesPerSample, true) // byte rate
  view.setUint16(32, bytesPerSample, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeAscii(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
    offset += bytesPerSample
  }
  return new Uint8Array(buffer)
}

/** 线性插值重采样到 16kHz（目标采样率），可测纯函数。 */
export function resampleTo16k(input: Float32Array, srcRate: number): Float32Array {
  if (srcRate === 16_000) return input
  if (srcRate <= 0 || !Number.isFinite(srcRate)) return input
  const ratio = srcRate / 16_000
  const out = new Float32Array(Math.max(1, Math.round(input.length / ratio)))
  for (let i = 0; i < out.length; i += 1) {
    const pos = i * ratio
    const i0 = Math.min(input.length - 1, Math.floor(pos))
    const i1 = Math.min(input.length - 1, i0 + 1)
    const frac = pos - i0
    out[i] = input[i0] * (1 - frac) + input[i1] * frac
  }
  return out
}

export interface AsrRequestParts {
  method: 'POST'
  url: string
  filename: string
  mime: string
  formFields: { name: string; value: string }[]
}

/** 构造 OpenAI 兼容转写请求的元信息（不含文件体），可测纯函数。 */
export function buildAsrRequestParts(config: SpeechInputConfig, mime = 'audio/wav'): AsrRequestParts {
  const base = config.endpoint.replace(/\/+$/, '')
  const fields: { name: string; value: string }[] = [{ name: 'model', value: config.model || 'whisper-1' }]
  if (config.language) fields.push({ name: 'language', value: config.language })
  return {
    method: 'POST',
    url: `${base}/audio/transcriptions`,
    filename: `speech.${mime === 'audio/webm' ? 'webm' : 'wav'}`,
    mime,
    formFields: fields,
  }
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
  const started = Date.now()
  const parts = buildAsrRequestParts(config)
  const form = new FormData()
  form.append('file', new Blob([wavBytes as BlobPart], { type: parts.mime }), parts.filename)
  for (const field of parts.formFields) form.append(field.name, field.value)
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener('abort', abort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, 120_000)
  try {
    let response: Response
    try {
      response = await fetch(parts.url, {
        method: parts.method,
        headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : undefined,
        body: form,
        signal: controller.signal,
      })
    } catch (error) {
      throw asrError('network', `无法连接语音识别服务：${error instanceof Error ? error.message : String(error)}`)
    }

    if (!response.ok) {
      throw asrError('http', `语音识别服务返回 ${response.status}`, response.status)
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      throw asrError('payload', '语音识别服务返回了无法解析的内容')
    }

    const text = (payload && typeof payload === 'object' && 'text' in payload
      ? (payload as { text?: unknown }).text
      : null) as string | null
    if (typeof text !== 'string' || !text.trim()) {
      throw asrError('payload', '语音识别服务未返回识别文本')
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
