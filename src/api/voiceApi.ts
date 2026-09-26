import type { TranslateRequest, TtsRequest, VoicePrepareRequest } from '../../types/voice.ts'
import { ApiClientError, apiClient, type ApiClient, type ApiResponseObject, type FetchImplementation } from './client.ts'
import { runtimeFetch } from '../platform/runtimeUrl.ts'
import type { TranslateResult, TtsStatus, VoicePrepareResult } from '../types/api.ts'

export const VOICE_API_TIMEOUTS = {
  status: 10_000,
  prepare: 200_000,
  translate: 200_000,
  synthesize: 240_000,
} as const

export interface VoiceCallOptions { signal?: AbortSignal }
export type VoicePreparePayload = Required<VoicePrepareRequest>
export type VoiceSynthesisPayload = Required<TtsRequest> & { consistency: 'locked' }
export interface VoiceAudioResult { blob: Blob; queueWaitMs: number }

/** TTS returns audio, while the shared JSON client handles status and translation. */
async function synthesizeVoice(fetchAudio: FetchImplementation, payload: VoiceSynthesisPayload, options: VoiceCallOptions): Promise<VoiceAudioResult> {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (options.signal?.aborted) throw new ApiClientError('请求已取消', { kind: 'aborted' })
  options.signal?.addEventListener('abort', abort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, VOICE_API_TIMEOUTS.synthesize)
  try {
    const response = await fetchAudio('/api/tts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: controller.signal,
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as unknown
      const error = isObject(body) ? body : {}
      const detail = typeof error.detail === 'string' ? error.detail : ''
      const message = response.status === 502 && /ECONNREFUSED|9880/.test(detail)
        ? 'GPT-SoVITS 未启动（127.0.0.1:9880 拒绝连接）。到控制面板点「启动语音」。'
        : [typeof error.error === 'string' ? error.error : '', detail].filter(Boolean).join('：') || `语音生成失败 (${response.status})`
      throw new ApiClientError(message, { kind: 'http', status: response.status, detail, responseBody: error })
    }
    const blob = await response.blob()
    if (!blob.size) throw new ApiClientError('语音服务返回了空音频', { kind: 'invalid-response', status: response.status })
    const wait = Number(response.headers.get('X-Voice-Queue-Wait'))
    return { blob, queueWaitMs: Number.isFinite(wait) && wait > 0 ? wait : 0 }
  } catch (error) {
    if (timedOut) throw new ApiClientError('语音生成超时，请稍后重试', { kind: 'timeout' })
    if (options.signal?.aborted) throw new ApiClientError('请求已取消', { kind: 'aborted' })
    if (error instanceof ApiClientError) throw error
    throw new ApiClientError('语音服务连接失败', { kind: 'network', detail: error instanceof Error ? error.message : String(error) })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

function isObject(value: unknown): value is ApiResponseObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTtsStatus(value: ApiResponseObject): boolean {
  return typeof value.online === 'boolean' && isObject(value.voices)
    && Object.values(value.voices).every(item => typeof item === 'boolean')
}

function isPrepare(value: ApiResponseObject): boolean {
  return value.ok === true && typeof value.voice === 'string' && typeof value.translation === 'boolean'
}

function isTranslation(value: ApiResponseObject): boolean {
  return typeof value.translation === 'string'
}

export interface VoiceApi {
  getStatus(options?: VoiceCallOptions): Promise<TtsStatus>
  prepare(payload: VoicePreparePayload, options?: VoiceCallOptions): Promise<VoicePrepareResult>
  translate(text: string, options?: VoiceCallOptions): Promise<TranslateResult>
  synthesize(payload: VoiceSynthesisPayload, options?: VoiceCallOptions): Promise<VoiceAudioResult>
}

export function createVoiceApi(client: ApiClient = apiClient, fetchAudio: FetchImplementation = runtimeFetch): VoiceApi {
  return {
    getStatus(options = {}) {
      return client.request<TtsStatus>('/api/tts-status', {
        cache: 'no-store', signal: options.signal, timeoutMs: VOICE_API_TIMEOUTS.status,
        validate: isTtsStatus,
      })
    },
    prepare(payload, options = {}) {
      return client.request<VoicePrepareResult>('/api/voice/prepare', {
        method: 'POST', cache: 'no-store', body: payload, signal: options.signal,
        timeoutMs: VOICE_API_TIMEOUTS.prepare, validate: isPrepare,
      })
    },
    translate(text, options = {}) {
      const body: TranslateRequest = { text }
      return client.request<TranslateResult>('/api/translate', {
        method: 'POST', cache: 'no-store', body, signal: options.signal,
        timeoutMs: VOICE_API_TIMEOUTS.translate, validate: isTranslation,
      })
    },
    synthesize(payload, options = {}) {
      return synthesizeVoice(fetchAudio, payload, options)
    },
  }
}

export const voiceApi = createVoiceApi()
