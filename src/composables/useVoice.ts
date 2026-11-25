import {
  SentenceBuffer, extractSpokenDialogue, inferEmotion, isAbortError,
} from '../utils/stream.ts'
import { voiceApi } from '../api/voiceApi.ts'
import { ApiClientError } from '../api/client.ts'
import { createVoicePlaybackEngine, type SynthesizedClip } from './voice/voicePlaybackEngine.ts'

export type { VoiceAvailability } from './useVoicePreparation.ts'
import { useVoicePreparation, voiceErrorMessage } from './useVoicePreparation.ts'

interface VoiceTurn {
  mid: string
  voice: string
  character: string
  session: number
  referenceEmotion: string
  /** Explicit mood from [mood=...] protocol tag or companion performance cue. */
  explicitEmotion: string
}

interface PreparedSentence {
  text: string
  language: 'ja' | 'zh'
  emotion: string
  referenceEmotion: string
  consistency: 'locked' | 'adaptive'
}

export function useVoice(options: {
  enabled: () => boolean
  onStatus?: (text: string) => void
  onError?: (msg: string) => void
  onSpeaking?: (v: boolean, mid?: string) => void
  onExpression?: (emotion: string) => void
  onMouth?: (v: number) => void
  onAudioLevel?: (level: number, peak: number) => void
  onActivity?: (active: boolean) => void
}) {
  const { enabled, onStatus = () => {}, onError = () => {}, onSpeaking = () => {},
    onExpression = () => {}, onMouth = () => {}, onAudioLevel = () => {}, onActivity = () => {} } = options

  const preparation = useVoicePreparation(enabled, onStatus, onError)
  const { availability, refreshAvailability, readyFor, prepare } = preparation

  // 内部不需要响应式的可变状态
  // GPT-SoVITS is much more stable with a little sentence context. Holding a
  // short interjection for the following sentence avoids clipped, repeated
  // "诶…那个…" style fragments.
  // 后端已改用 cut2（整句直推不按日语顿号切碎）；单句上限设为 56 字，既避免普通
  // 长句在逗号处被硬切两半导致前后语气割裂，也防止超长段拖慢 GPU 或复读。
  // 首句在句末累计 8 字即可放行，减少开场白首句等待延迟。
  const sentenceBuffer = new SentenceBuffer({ minimumLength: 12, maximumLength: 56, firstThreshold: 8 })
  let session = 0, controller: AbortController | null = null
  let translateChain: Promise<PreparedSentence | null> = Promise.resolve(null)
  let synthChain: Promise<void> = Promise.resolve()
  let pending = 0
  let turn: VoiceTurn | null = null, _lastEmotion = 'neutral', _neutralStreak = 0
  let _warnedTranslation = false
  let destroyed = false

  const engine = createVoicePlaybackEngine({
    getSession: () => session,
    hasPending: () => pending > 0,
    isDestroyed: () => destroyed,
    stopForReplay: () => stop({ preserveMessageAudio: true, silent: true }),
    notifyActivity,
    onStatus,
    onError,
    onSpeaking,
    onExpression,
    onMouth,
    onAudioLevel,
  })

  function isActive() { return Boolean(pending > 0 || engine.isBusy()) }
  function ownsTurn(mid: string) { return turn?.mid === mid }
  function notifyActivity() { onActivity(isActive()) }

  function wantsJapanese(voice: string) {
    const status = availability.value
    return enabled() && Boolean(voice) && status.needsTranslation !== false && status.voices?.[voice] !== false
  }

  function startTurn(meta: { mid: string; voice: string; character: string; emotion?: string; deferPreparation?: boolean }) {
    if (destroyed) return
    stop({ preserveMessageAudio: true, silent: true, preservePreparation: !meta.deferPreparation && enabled() && preparation.matches(meta.voice, true) })
    if (!meta.voice) return
    if (enabled()) engine.ensureAudioContext(); session++
    controller = new AbortController()
    sentenceBuffer.reset(); translateChain = Promise.resolve(null); synthChain = Promise.resolve()
    const initialEmotion = meta.emotion?.trim().toLowerCase() || ''
    pending = 0
    turn = {
      mid: meta.mid,
      voice: meta.voice,
      character: meta.character,
      session,
      referenceEmotion: initialEmotion,
      explicitEmotion: initialEmotion,
    }
    _lastEmotion = initialEmotion || 'neutral'; _neutralStreak = 0
    if (!meta.deferPreparation) prepare(meta.voice, availability.value.needsTranslation !== false)
    if (enabled() && !readyFor(meta.voice)) {
      if (availability.value.engineId === 'off') onStatus('语音朗读已关闭')
      else onStatus(availability.value.online || availability.value.available ? '当前角色声线未配置' : '语音服务未启动')
    }
  }

  function setTurnEmotion(emotion: string, explicit = false) {
    if (!turn || !explicit) return
    const next = emotion.trim().toLowerCase()
    if (!next) return
    turn.explicitEmotion = next
    turn.referenceEmotion = next
    _lastEmotion = next
    _neutralStreak = 0
  }

  function append(text: string) {
    if (!turn || !enabled() || !readyFor(turn.voice)) return
    const activeTurn = turn
    sentenceBuffer.push(text, false).forEach(s => enqueue(s, activeTurn))
  }

  function appendJapanese(text: string) {
    // The chat gateway confirmed Japanese speech for this turn. The voice
    // endpoint still validates the selected voice, even before status returns.
    if (!turn || !enabled()) return
    const activeTurn = turn
    sentenceBuffer.push(text, true).forEach(sentence => enqueue(sentence, activeTurn, true))
  }

  function finishTurn() {
    if (!turn || !enabled() || !readyFor(turn.voice)) return
    const activeTurn = turn
    sentenceBuffer.push('', true).forEach(s => enqueue(s, activeTurn))
  }

  function enqueue(sentence: string, meta: VoiceTurn, directJapanese = false) {
    const sess = meta.session
    if (sess !== session || !controller) return
    const signal = controller.signal; pending++; if (!engine.isPlaying()) onStatus('语音合成中…'); notifyActivity()
    const prepared = (translateChain = translateChain
      .then(() => sess !== session || signal.aborted ? null : prepareSentence(sentence, meta, signal, directJapanese))
      .catch(e => { if (!isAbortError(e) && sess === session) onError('一句配音失败（不影响聊天）：' + voiceErrorMessage(e)); return null }))
    synthChain = synthChain.then(async () => {
      const req = await prepared
      if (!req || sess !== session || signal.aborted) return null
      return synthesize(req, meta, signal)
    }).then(item => {
      if (!item) return
      if (sess !== session) { item.stream?.cancel(); return }
      engine.enqueueSynthesized(item, meta.mid, sess)
    }).catch(e => { if (!isAbortError(e) && sess === session) onError('一句配音失败（不影响聊天）：' + voiceErrorMessage(e)) })
      .finally(() => {
        if (sess !== session) return; pending = Math.max(0, pending - 1)
        if (pending === 0 && !engine.isPlayingOrQueued()) onStatus('')
        notifyActivity()
      })
  }

  async function prepareSentence(sourceText: string, meta: VoiceTurn, signal: AbortSignal, directJapanese: boolean): Promise<PreparedSentence | null> {
    const dialogue = extractSpokenDialogue(sourceText)
    const cleaned = dialogue.text.replace(/[「」『』"""']/g, '').trim()
    if (!cleaned) return null
    const directionText = dialogue.directions.join(' ')
    const directionEmotion = directionText ? inferEmotion(directionText, meta.character) : 'neutral'
    const hasExplicitDirection = directionEmotion !== 'neutral'
    let emotion: string
    if (hasExplicitDirection) {
      emotion = directionEmotion
      _neutralStreak = 0
    } else if (meta.explicitEmotion) {
      emotion = meta.explicitEmotion
      _neutralStreak = 0
    } else {
      const rawEmotion = inferEmotion(cleaned, meta.character)
      if (rawEmotion === 'neutral') {
        _neutralStreak++
        emotion = _neutralStreak >= 3 ? 'neutral' : _lastEmotion
      } else {
        _neutralStreak = 0
        emotion = rawEmotion
      }
    }
    _lastEmotion = emotion
    // Lock the acoustic reference WAV for the whole turn so GPT-SoVITS does not
    // abruptly jump voice/timbre mid-reply on stray keywords. Only an explicit
    // [mood=...] tag or an explicit stage direction updates the turn reference.
    if (hasExplicitDirection) {
      meta.referenceEmotion = directionEmotion
    } else if (meta.explicitEmotion) {
      meta.referenceEmotion = meta.explicitEmotion
    } else if (!meta.referenceEmotion) {
      meta.referenceEmotion = emotion
    }
    const lockedReference = meta.referenceEmotion || emotion
    const needsTranslate = !directJapanese && availability.value.needsTranslation !== false
    let translated = '', translationFailed = false
    if (needsTranslate) {
      try {
        const result = await voiceApi.translate(cleaned, { signal })
        translated = result.translation.replace(/\n+/g, '。').trim()
      } catch (e) {
        if (isAbortError(e) || (e instanceof ApiClientError && e.kind === 'aborted')) throw e
        translationFailed = true
      }
      if (signal.aborted || meta.session !== session) return null
      if (translationFailed && !_warnedTranslation) { _warnedTranslation = true; onError('日文翻译不可用，本次改用中文发音。') }
    }
    return {
      text: translated || cleaned,
      language: directJapanese || translated ? 'ja' : 'zh',
      emotion,
      referenceEmotion: lockedReference,
      consistency: 'locked',
    }
  }

  async function requestTts(request: PreparedSentence, meta: VoiceTurn): Promise<string> {
    // Canonical whole-clip address remains available for replay and GPT.
    // VoxCPM2 uses the PCM route below to start playback before synthesis ends.
    const params = new URLSearchParams({
      voice: meta.voice,
      text: request.text,
      language: request.language,
      emotion: request.emotion,
      referenceEmotion: request.referenceEmotion,
      consistency: request.consistency,
      speed: '1',
    })
    return '/api/tts?' + params.toString()
  }

  async function synthesize(request: PreparedSentence, meta: VoiceTurn, signal: AbortSignal): Promise<SynthesizedClip> {
    // Playback or next-sentence prefetch starts the request. Each player owns
    // its errors and cancellation; this step only selects the playback route.
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    if (availability.value.engineId === 'system') {
      return {
        url: '',
        emotion: request.emotion,
        speechText: request.text,
        speechVoice: meta.voice,
        speechLanguage: request.language,
      }
    }
    const url = await requestTts(request, meta)
    if (!availability.value.streamingPcm) return { url, emotion: request.emotion }
    // A missing streaming chunk can still play the same sentence through the whole-clip route.
    const pcm = await import('./voicePcmStream.ts').catch(() => null)
    signal.throwIfAborted()
    return { url, emotion: request.emotion,
      ...(pcm ? { stream: new pcm.VoicePcmStream(url.replace('/api/tts?', '/api/tts-stream?')) } : {}) }
  }

  function stop(opts: { preserveMessageAudio?: boolean; silent?: boolean; preservePreparation?: boolean } = {}) {
    session++; controller?.abort(); controller = null; turn = null
    if (!opts.preservePreparation) preparation.cancelPreparation()
    sentenceBuffer.reset(); translateChain = Promise.resolve(null); synthChain = Promise.resolve(); pending = 0
    _lastEmotion = 'neutral'; _neutralStreak = 0
    engine.stopPlayback(opts)
    notifyActivity()
  }

  function destroy() {
    destroyed = true; preparation.dispose()
    stop({ preserveMessageAudio: false, silent: true, preservePreparation: true })
    engine.destroy()
  }

  return {
    availability,
    refreshAvailability,
    readyFor,
    prepare,
    ensureAudioContext: engine.ensureAudioContext,
    isActive,
    ownsTurn,
    wantsJapanese,
    startTurn,
    setTurnEmotion,
    append,
    appendJapanese,
    finishTurn,
    stop,
    destroy,
    playMessage: engine.playMessage,
    hasAudio: engine.hasAudio,
    clearMessages: engine.clearMessages,
    setVolume: engine.setVolume,
  }
}
