import { ref } from 'vue'
import { voiceApi } from '../api/voiceApi.ts'
import { ApiClientError } from '../api/client.ts'
import { isAbortError } from '../utils/stream.ts'

export interface VoiceAvailability {
  online: boolean; available?: boolean
  voices?: Record<string, boolean>
  translation?: { ready: boolean }
  activeVoice?: string
  streamingPcm?: boolean
  error?: string
}

interface StatusError extends Error {
  status?: number
  detail?: unknown
}

export function voiceErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const rawDetail = (error as StatusError).detail
  const detail = typeof rawDetail === 'string'
    ? rawDetail.replace(/\s+/g, ' ').trim().slice(0, 240)
    : ''
  return detail && !error.message.includes(detail) ? `${error.message}：${detail}` : error.message
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }

function readVoiceAvailability(value: unknown): VoiceAvailability {
  if (!isRecord(value)) throw new Error('语音状态响应格式无效')
  const voices = isRecord(value.voices)
    ? Object.fromEntries(Object.entries(value.voices).map(([key, available]) => [key, Boolean(available)]))
    : {}
  const translation = isRecord(value.translation)
    ? { ready: Boolean(value.translation.ready) }
    : undefined
  return {
    online: Boolean(value.online), available: value.available === true,
    voices,
    translation,
    activeVoice: typeof value.activeVoice === 'string' ? value.activeVoice : undefined,
    streamingPcm: value.streamingPcm === true,
    error: typeof value.error === 'string' ? value.error : undefined,
  }
}

export function useVoicePreparation(enabled: () => boolean, onStatus: (text: string) => void, onError: (message: string) => void) {
  const availability = ref<VoiceAvailability>({ online: false, voices: {} })
  let prepareKey = '', preparing: Promise<boolean> | null = null
  let prepareController: AbortController | null = null
  let prepareRevision = 0, availabilityRevision = 0, destroyed = false

  async function refreshAvailability() {
    const revision = ++availabilityRevision
    try {
      const value = readVoiceAvailability(await voiceApi.getStatus())
      if (!destroyed && revision === availabilityRevision) availability.value = value
    } catch (e) { if (!destroyed && revision === availabilityRevision) availability.value = { online: false, voices: {}, error: voiceErrorMessage(e) } }
    return availability.value
  }

  function readyFor(voice: string) {
    return Boolean((availability.value.online || availability.value.available) && availability.value.voices?.[voice])
  }

  function prepare(voice: string, needsTranslation = true): Promise<boolean> {
    if (destroyed || !enabled()) return Promise.resolve(false)
    if (!readyFor(voice)) return Promise.resolve(false)
    const translationReady = !needsTranslation || Boolean(availability.value.translation?.ready)
    const key = voice + ':' + needsTranslation
    if (preparing && prepareKey === key) return preparing
    if (!preparing && availability.value.activeVoice === voice && translationReady) { prepareKey = key; return Promise.resolve(true) }
    const revision = ++prepareRevision
    prepareController?.abort()
    prepareController = new AbortController()
    prepareKey = key
    onStatus(needsTranslation ? '正在预热声线与翻译…' : '正在预热角色声线…')
    preparing = voiceApi.prepare({ voice, translation: needsTranslation }, { signal: prepareController.signal }).then(() => {
      if (revision !== prepareRevision || destroyed) return false
      availability.value.activeVoice = voice
      if (needsTranslation) availability.value.translation = { ...(availability.value.translation ?? {}), ready: true }
      onStatus(''); return true
    }).catch((e) => {
      if (revision === prepareRevision && !destroyed && !isAbortError(e)) {
        if (e instanceof ApiClientError && ['COMFY_RELEASE_UNCONFIRMED', 'DRAWING_BUSY', 'VOICE_BUSY', 'TTS_UNAVAILABLE', 'TTS_FAILED', 'TERMINATION_UNCONFIRMED'].includes(e.code || '')) onError(e.message)
        else onStatus('声线会在首次播放时加载')
      }
      return false
    }).finally(() => { if (revision === prepareRevision) { preparing = null; prepareController = null } })
    return preparing
  }

  function cancelPreparation() {
    prepareRevision++; prepareKey = ''; preparing = null
    prepareController?.abort(); prepareController = null
  }
  function dispose() { destroyed = true; availabilityRevision++; cancelPreparation() }
  return { availability, refreshAvailability, readyFor, prepare, cancelPreparation, dispose,
    matches: (voice: string, translation: boolean) => prepareKey === voice + ':' + translation }
}
