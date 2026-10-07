import { resolveRuntimeUrl, runtimeResourceCors } from '../platform/runtimeUrl.ts'
import { ref } from 'vue'
import {
  SentenceBuffer, extractSpokenDialogue, inferEmotion, isAbortError,
} from '../utils/stream.ts'
import { voiceApi } from '../api/voiceApi.ts'
import { ApiClientError } from '../api/client.ts'
import { VoicePcmStream } from './voicePcmStream.ts'
import { VoiceReplayCache } from './voiceReplayCache.ts'

export interface VoiceAvailability {
  online: boolean
  voices?: Record<string, boolean>
  translation?: { ready: boolean }
  activeVoice?: string
  streamingPcm?: boolean
  error?: string
}

interface VoiceTurn {
  mid: string
  voice: string
  character: string
  session: number
  referenceEmotion: string
}

interface PreparedSentence {
  text: string
  language: 'ja' | 'zh'
  emotion: string
  consistency: 'locked' | 'adaptive'
}

interface SynthesizedClip {
  url: string
  emotion: string
  stream?: VoicePcmStream
}

interface QueuedClip extends SynthesizedClip {
  mid: string
  session: number
  /** 整句播放失败时的剩余重试次数；已经开播的句子不重复生成。 */
  retryLeft?: number
  recorded?: SynthesizedClip
  observed?: boolean
}

interface AudioWithSource extends HTMLAudioElement {
  __sourceNode?: MediaElementAudioSourceNode | null
}

interface StatusError extends Error {
  status?: number
  detail?: unknown
}

type AudioContextConstructor = new () => AudioContext

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const rawDetail = (error as StatusError).detail
  const detail = typeof rawDetail === 'string'
    ? rawDetail.replace(/\s+/g, ' ').trim().slice(0, 240)
    : ''
  return detail && !error.message.includes(detail) ? `${error.message}：${detail}` : error.message
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readVoiceAvailability(value: unknown): VoiceAvailability {
  if (!isRecord(value)) throw new Error('语音状态响应格式无效')
  const voices = isRecord(value.voices)
    ? Object.fromEntries(Object.entries(value.voices).map(([key, available]) => [key, Boolean(available)]))
    : {}
  const translation = isRecord(value.translation)
    ? { ready: Boolean(value.translation.ready) }
    : undefined
  return {
    online: Boolean(value.online),
    voices,
    translation,
    activeVoice: typeof value.activeVoice === 'string' ? value.activeVoice : undefined,
    streamingPcm: value.streamingPcm === true,
    error: typeof value.error === 'string' ? value.error : undefined,
  }
}

function removeAudioSource(audio: AudioWithSource) {
  try { audio.__sourceNode?.disconnect() } catch {}
  if (audio) audio.__sourceNode = null
}

export function useVoice(options: {
  enabled: () => boolean
  onStatus?: (text: string) => void
  onError?: (msg: string) => void
  onSpeaking?: (v: boolean, mid?: string) => void
  onExpression?: (emotion: string) => void
  onMouth?: (v: number) => void
  onAudioLevel?: (level: number, peak: number) => void
  onAudioReady?: (mid: string) => void
  onAudioCleared?: () => void
  onActivity?: (active: boolean) => void
}) {
  const { enabled, onStatus = () => {}, onError = () => {}, onSpeaking = () => {},
    onExpression = () => {}, onMouth = () => {}, onAudioLevel = () => {},
    onAudioReady = () => {}, onAudioCleared = () => {}, onActivity = () => {} } = options

  const availability = ref<VoiceAvailability>({ online: false, voices: {} })

  // 内部不需要响应式的可变状态
  // GPT-SoVITS is much more stable with a little sentence context. Holding a
  // short interjection for the following sentence avoids clipped, repeated
  // "诶…那个…" style fragments.
  // 单句上限收紧到 44 字：更长文本 cut5 内部分多段，GPT-SoVITS 更容易
  // 复读/结巴，且单句 GPU 时间随长度线性增长，是长语句等待和"反复说
  // 一个词"的主要来源之一。首句在句末累计 8 字即可放行：开场白通常短，
  // 等满 12 字才合成会让第一句语音明显滞后。
  const sentenceBuffer = new SentenceBuffer({ minimumLength: 12, maximumLength: 44, firstThreshold: 8 })
  let session = 0, controller: AbortController | null = null
  let translateChain: Promise<PreparedSentence | null> = Promise.resolve(null)
  let synthChain: Promise<void> = Promise.resolve()
  let pending = 0, queue: QueuedClip[] = [], playing = false
  let currentAudio: AudioWithSource | null = null, replayAudio: AudioWithSource | null = null
  let currentPcm: VoicePcmStream | null = null
  const messageAudio = new Map<string, SynthesizedClip[]>()
  const replayCache = new VoiceReplayCache()
  let audioContext: AudioContext | null = null, analyser: AnalyserNode | null = null
  let gainNode: GainNode | null = null, lipFrame = 0, lipSmooth = 0
  let prepareKey = '', preparing: Promise<boolean> | null = null
  let turn: VoiceTurn | null = null, _lastEmotion = 'neutral', _neutralStreak = 0
  let _warnedTranslation = false, _warnedAnalyser = false
  let cancelPlayback: (() => void) | null = null, cancelReplay: (() => void) | null = null
  let prepareRevision = 0, availabilityRevision = 0, destroyed = false, volume = 1
  let prepareController: AbortController | null = null

  async function refreshAvailability() {
    const revision = ++availabilityRevision
    try {
      const value = readVoiceAvailability(await voiceApi.getStatus())
      if (!destroyed && revision === availabilityRevision) availability.value = value
    } catch (e) { if (!destroyed && revision === availabilityRevision) availability.value = { online: false, voices: {}, error: errorMessage(e) } }
    return availability.value
  }

  function readyFor(voice: string) {
    return Boolean(availability.value.online && availability.value.voices?.[voice])
  }

  function prepare(voice: string, needsTranslation = true): Promise<boolean> {
    if (destroyed) return Promise.resolve(false)
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
      if (revision === prepareRevision && !destroyed && !isAbortError(e)) onStatus('声线会在首次播放时加载')
      return false
    }).finally(() => { if (revision === prepareRevision) { preparing = null; prepareController = null } })
    return preparing
  }

  function ensureAudioContext() {
    if (destroyed) return
    if (!audioContext) {
      try {
        const audioWindow = window as Window & typeof globalThis & {
          webkitAudioContext?: AudioContextConstructor
        }
        const AC: AudioContextConstructor | undefined = audioWindow.AudioContext || audioWindow.webkitAudioContext
        if (!AC) return
        audioContext = new AC()
        const ac = audioContext!
        analyser = ac.createAnalyser(); analyser.fftSize = 512; analyser.smoothingTimeConstant = 0.5
        gainNode = ac.createGain(); gainNode.gain.value = volume
        analyser.connect(gainNode); gainNode.connect(ac.destination)
      } catch { audioContext = null; analyser = null }
    }
    if (audioContext?.state === 'suspended') audioContext.resume().catch(() => {})
  }

  function isActive() { return Boolean(pending > 0 || playing || queue.length || replayAudio) }
  function ownsTurn(mid: string) { return turn?.mid === mid }
  function notifyActivity() { onActivity(isActive()) }

  function startTurn(meta: { mid: string; voice: string; character: string }) {
    if (destroyed) return
    stop({ preserveMessageAudio: true, silent: true })
    ensureAudioContext(); session++
    controller = new AbortController()
    sentenceBuffer.reset(); translateChain = Promise.resolve(null); synthChain = Promise.resolve()
    pending = 0; turn = { ...meta, session, referenceEmotion: '' }
    _lastEmotion = 'neutral'; _neutralStreak = 0
    prepare(meta.voice, true)
    if (enabled() && !readyFor(meta.voice)) onStatus(availability.value.online ? '当前角色声线未配置' : '语音服务未启动')
  }

  function append(text: string) {
    if (!turn || !enabled() || !readyFor(turn.voice)) return
    const activeTurn = turn
    sentenceBuffer.push(text, false).forEach(s => enqueue(s, activeTurn))
  }

  function finishTurn() {
    if (!turn || !enabled() || !readyFor(turn.voice)) return
    const activeTurn = turn
    sentenceBuffer.push('', true).forEach(s => enqueue(s, activeTurn))
  }

  function enqueue(sentence: string, meta: VoiceTurn) {
    const sess = meta.session
    if (sess !== session || !controller) return
    const signal = controller.signal; pending++; onStatus('语音合成中…'); notifyActivity()
    const prepared = (translateChain = translateChain
      .then(() => sess !== session || signal.aborted ? null : prepareSentence(sentence, meta, signal))
      .catch(e => { if (!isAbortError(e) && sess === session) onError('一句配音失败（不影响聊天）：' + errorMessage(e)); return null }))
    synthChain = synthChain.then(async () => {
      const req = await prepared
      if (!req || sess !== session || signal.aborted) return null
      return synthesize(req, meta, signal)
    }).then(item => {
      if (!item) return
      if (sess !== session) { item.stream?.cancel(); return }
      const clips = messageAudio.get(meta.mid) || []
      const stored = { url: item.stream ? '' : item.url, emotion: item.emotion || 'neutral' }
      clips.push(stored); messageAudio.set(meta.mid, clips)
      queue.push({ ...item, mid: meta.mid, session: sess, recorded: stored })
      if (!item.stream) onAudioReady(meta.mid)
      pump(sess); prefetch()
    }).catch(e => { if (!isAbortError(e) && sess === session) onError('一句配音失败（不影响聊天）：' + errorMessage(e)) })
    .finally(() => {
      if (sess !== session) return; pending = Math.max(0, pending - 1)
      if (pending === 0) onStatus(playing || queue.length ? '播放中…' : '')
      notifyActivity()
    })
  }

  async function prepareSentence(sourceText: string, meta: VoiceTurn, signal: AbortSignal): Promise<PreparedSentence | null> {
    const dialogue = extractSpokenDialogue(sourceText)
    const cleaned = dialogue.text.replace(/[「」『』"""']/g, '').trim()
    if (!cleaned) return null
    const directionText = dialogue.directions.join(' ')
    const rawEmotion = inferEmotion(directionText ? `${directionText} ${cleaned}` : cleaned, meta.character)
    let emotion: string
    if (rawEmotion === 'neutral') { _neutralStreak++; emotion = _neutralStreak >= 3 ? 'neutral' : _lastEmotion }
    else { _neutralStreak = 0; emotion = rawEmotion }
    _lastEmotion = emotion
    const firstReference = meta.referenceEmotion
    // Keep the neutral turn on the character's main reference clip.  The
    // backend falls back to profile.refAudioPath when `referenceEmotion` is
    // neutral; mapping it to gentle here would make ordinary chat inherit a
    // different timbre and make the UI's emotion label misleading.
    if (!meta.referenceEmotion) meta.referenceEmotion = rawEmotion
    let translated = '', translationFailed = false
    try {
      const result = await voiceApi.translate(cleaned, { signal })
      translated = result.translation.replace(/\n+/g, '。').trim()
    } catch (e) {
      if (isAbortError(e) || (e instanceof ApiClientError && e.kind === 'aborted')) throw e
      translationFailed = true
    }
    if (signal.aborted || meta.session !== session) return null
    if (translationFailed && !_warnedTranslation) { _warnedTranslation = true; onError('日文翻译不可用，本次改用中文发音。') }
    const emotionChanged = Boolean(firstReference && emotion !== firstReference)
    return {
      text: translated || cleaned,
      language: translated ? 'ja' : 'zh',
      emotion,
      // Keep a stable reference while a reply stays in one mood.  When the
      // classifier detects a real change (or an explicit stage direction),
      // switch to the current emotion reference so the spoken audio does not
      // remain gentle/neutral while the UI expression has already changed.
      consistency: (directionText && rawEmotion !== 'neutral') || emotionChanged ? 'adaptive' : 'locked',
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
      referenceEmotion: meta.referenceEmotion,
      consistency: request.consistency,
      speed: '1',
    })
    return '/api/tts?' + params.toString()
  }

  async function synthesize(request: PreparedSentence, meta: VoiceTurn, signal: AbortSignal): Promise<SynthesizedClip> {
    // Playback or next-sentence prefetch starts the request. Each player owns
    // its errors and cancellation; this step only selects the playback route.
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    const url = await requestTts(request, meta)
    return { url, emotion: request.emotion,
      ...(availability.value.streamingPcm ? { stream: new VoicePcmStream(url.replace('/api/tts?', '/api/tts-stream?')) } : {}) }
  }

  function observeStream(item: QueuedClip) {
    if (!item.stream || item.observed) return
    item.observed = true
    void item.stream.start().then(blob => {
      if (item.session !== session || !item.recorded || !messageAudio.get(item.mid)?.includes(item.recorded)) return
      replayCache.remember(item.mid, item.recorded, blob, item.url)
      onAudioReady(item.mid)
    }).catch(() => {}) // Playback reports a prefetched failure once it owns this clip.
  }
  function prefetch() { if (playing && queue[0]?.stream) observeStream(queue[0]) }

  function attachAnalyser(audio: AudioWithSource) {
    audio.volume = volume
    if (!audioContext || !analyser) return
    try {
      if (!audio.__sourceNode) { audio.__sourceNode = audioContext.createMediaElementSource(audio); audio.__sourceNode.connect(analyser) }
      audio.volume = 1 // The connected GainNode owns volume; avoid applying it twice.
    } catch {
      removeAudioSource(audio)
      if (!_warnedAnalyser) { _warnedAnalyser = true; onError('浏览器阻止了音频分析，口型同步本次不可用。') }
    }
  }

  function startLipSync() {
    if (lipFrame || !analyser || document.hidden || destroyed) return
    const samples = new Uint8Array(analyser.fftSize)
    const tick = () => {
      const audio = currentAudio || replayAudio; let target = 0
      let peak = 0
      if ((audio && !audio.paused && !audio.ended) || currentPcm?.playing) {
        analyser!.getByteTimeDomainData(samples); let sum = 0
        for (const s of samples) {
          const n = (s - 128) / 128
          sum += n * n
          peak = Math.max(peak, Math.abs(n))
        }
        // GPT-SoVITS WAV peaks are comparatively quiet after browser mixing.
        // Keep real RMS data, but calibrate it into Cubism's 0..1 mouth range.
        target = Math.min(1, Math.sqrt(sum / samples.length) * 6.5)
      }
      lipSmooth += (target - lipSmooth) * 0.35
      if (lipSmooth < 0.015) lipSmooth = 0
      onMouth(lipSmooth)
      onAudioLevel(lipSmooth, Math.min(1, peak * 2.2))
      if ((audio && !audio.ended) || currentPcm || lipSmooth > 0.01) lipFrame = requestAnimationFrame(tick)
      else stopLipSync()
    }
    lipFrame = requestAnimationFrame(tick)
  }

  function stopLipSync() {
    if (lipFrame) cancelAnimationFrame(lipFrame)
    lipFrame = 0; lipSmooth = 0; onMouth(0); onAudioLevel(0, 0)
  }
  function setVolume(value: number) {
    volume = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1
    if (audioContext && gainNode) gainNode.gain.linearRampToValueAtTime(volume, audioContext.currentTime + 0.05)
    for (const audio of [currentAudio, replayAudio]) if (audio) audio.volume = audio.__sourceNode ? 1 : volume
  }
  function onVisibilityChange() { if (document.hidden) stopLipSync(); else if (currentAudio || currentPcm || replayAudio) startLipSync() }
  document.addEventListener('visibilitychange', onVisibilityChange)

  function pump(sess: number) {
    if (playing || !queue.length || sess !== session) return
    const item = queue.shift()
    if (!item) return
    playing = true
    if (item.stream && audioContext && analyser) {
      const stream = item.stream
      currentPcm = stream; observeStream(item)
      cancelPlayback = () => stream.cancel()
      onStatus('语音合成中…'); notifyActivity()
      void stream.play(audioContext, analyser, () => {
        if (sess !== session || currentPcm !== stream) return
        onExpression(item.emotion); onSpeaking(true, item.mid); onStatus('播放中…'); startLipSync()
      }).catch(e => {
        if (sess !== session || currentPcm !== stream || isAbortError(e)) return
        // Retain a manual whole-clip retry, never the incomplete PCM data.
        if (item.recorded && !item.recorded.url && messageAudio.get(item.mid)?.includes(item.recorded)) {
          item.recorded.url = item.url; onAudioReady(item.mid)
        }
        onError('一句配音失败：' + errorMessage(e))
      })
        .finally(() => {
          if (sess !== session || currentPcm !== stream) return
          currentPcm = null; playing = false; cancelPlayback = null
          if (!queue.length) { onSpeaking(false, item.mid); onExpression('neutral'); onStatus(pending ? '语音合成中…' : '') }
          pump(sess); prefetch(); notifyActivity()
        })
      prefetch(); return
    }
    if (item.stream) {
      item.stream.cancel()
      if (item.recorded) item.recorded.url = item.url
      onAudioReady(item.mid)
    }
    const audio = new Audio() as AudioWithSource
    audio.crossOrigin = runtimeResourceCors() ?? null
    audio.src = resolveRuntimeUrl(item.url)
    currentAudio = audio; attachAnalyser(audio)
    onExpression(item.emotion); onSpeaking(true, item.mid); onStatus('播放中…'); notifyActivity()
    let finished = false, started = false
    let waitExtensions = 0, loadTimer = 0
    // 公网分享下生成排队可能超过 90 秒。请求还活着（NETWORK_LOADING）时不判死：
    // 判死会触发重试，未命中缓存时等于把整句重新生成一遍，等待翻倍。
    // 只有连接已死（error 事件）或拖过总上限才放弃，放弃时也不再重试。
    const scheduleTimeout = () => {
      loadTimer = window.setTimeout(() => {
        if (finished || started || sess !== session) return
        if (audio.readyState < 2 && audio.networkState === 2 && waitExtensions < 2) {
          waitExtensions++
          onStatus(waitExtensions === 1 ? '语音生成较慢，继续等待…' : '语音生成很慢，还在排队…')
          scheduleTimeout()
          return
        }
        finish(false, 'timeout')
      }, 90_000)
    }
    const finish = (succeeded: boolean, reason?: 'timeout' | 'error') => {
      if (finished) return; finished = true
      clearTimeout(loadTimer)
      audio.removeEventListener('playing', onPlaying)
      audio.removeEventListener('ended', done); audio.removeEventListener('error', onErrorEvent)
      // 必须清掉旧元素：公网慢速下旧请求可能仍在下载，play() 已调用，
      // 数据一到浏览器会自动开播，与重试的新元素同时响（"反复说一个词"）。
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      removeAudioSource(audio)
      if (sess !== session) return
      cancelPlayback = null
      if (currentAudio === audio) currentAudio = null; playing = false
      if (succeeded) {
        if (!queue.length) { onSpeaking(false, item.mid); onExpression('neutral'); onStatus(pending > 0 ? '语音合成中…' : '') }
        pump(sess); notifyActivity()
      } else {
        // 只有"加载阶段失败"（HTTP/网络错误，还没出声）给一次重试机会；
        // 已开始播放后断流或超时一律不重试，避免整句从头重复播报。
        const retryable = !started && reason !== 'timeout' && item.retryLeft !== 0 && sess === session
        if (retryable) {
          onStatus('语音加载失败，重试…')
          queue.unshift({ ...item, retryLeft: (item.retryLeft ?? 1) - 1 })
        } else {
          onSpeaking(false, item.mid); onExpression('neutral'); onStatus('')
          if (reason === 'timeout') onError('语音生成超时，请点击"重播"再试。')
          else if (!started) onError('语音播放失败，请点击"重播"再试。')
        }
        pump(sess); notifyActivity()
      }
    }
    function onPlaying() { started = true; clearTimeout(loadTimer) }
    function done() { finish(true) }
    function onErrorEvent() { finish(false, 'error') }
    audio.addEventListener('playing', onPlaying)
    audio.addEventListener('ended', done); audio.addEventListener('error', onErrorEvent)
    cancelPlayback = () => finish(false)
    scheduleTimeout()
    audio.play().then(() => { if (!finished && sess === session) startLipSync() }).catch(() => {
      if (finished || sess !== session) return
      onError('浏览器阻止了自动播放，请点击消息下方的"重播"。'); done()
    })
  }

  async function playMessage(mid: string): Promise<boolean> {
    const clips = (messageAudio.get(mid) || []).filter(clip => clip.url)
    if (!clips.length) return false
    stop({ preserveMessageAudio: true, silent: true }); ensureAudioContext()
    const rs = session; onSpeaking(true, mid); onStatus('重播中…'); notifyActivity()
    for (const clip of clips) {
      if (rs !== session) return false
      const audio = new Audio() as AudioWithSource
      audio.crossOrigin = runtimeResourceCors() ?? null
      audio.src = resolveRuntimeUrl(clip.url)
      const release = replayCache.pin(clip)
      replayAudio = audio; attachAnalyser(audio); onExpression(clip.emotion || 'neutral')
      notifyActivity()
      await new Promise<void>(res => {
        let finished = false
        const timeout = window.setTimeout(() => done(), 270_000)
        const done = () => {
          if (finished) return
          finished = true
          clearTimeout(timeout)
          audio.removeEventListener('ended', done); audio.removeEventListener('error', done)
          audio.pause()
          audio.removeAttribute('src')
          audio.load()
          if (replayAudio === audio) { replayAudio = null; cancelReplay = null }
          removeAudioSource(audio); release(); res()
        }
        cancelReplay = done
        audio.addEventListener('ended', done); audio.addEventListener('error', done)
        audio.play().then(() => { if (!finished && rs === session) startLipSync() }).catch(done)
      })
    }
    if (rs === session) { replayAudio = null; onSpeaking(false, mid); onExpression('neutral'); onStatus(''); stopLipSync(); notifyActivity() }
    return rs === session
  }

  function hasAudio(mid: string) { return Boolean(messageAudio.get(mid)?.some(clip => clip.url)) }

  function clearMessages(mids: string[]) {
    const changed = mids.some(mid => hasAudio(mid))
    mids.forEach(mid => { const c = messageAudio.get(mid) || []; c.forEach(cl => replayCache.remove(cl)); messageAudio.delete(mid) })
    if (changed) onAudioCleared()
  }

  function stop(opts: { preserveMessageAudio?: boolean; silent?: boolean } = {}) {
    session++; controller?.abort(); controller = null; turn = null
    prepareRevision++; prepareKey = ''; preparing = null
    prepareController?.abort(); prepareController = null
    cancelPlayback?.(); cancelPlayback = null
    cancelReplay?.(); cancelReplay = null
    sentenceBuffer.reset(); translateChain = Promise.resolve(null); synthChain = Promise.resolve(); pending = 0
    queue.forEach(it => it.stream?.cancel()); queue = []
    if (currentAudio) { currentAudio.pause(); removeAudioSource(currentAudio); currentAudio.removeAttribute('src') }
    if (replayAudio) { replayAudio.pause(); removeAudioSource(replayAudio); replayAudio.removeAttribute('src') }
    currentPcm = null; currentAudio = null; replayAudio = null; playing = false; stopLipSync()
    _lastEmotion = 'neutral'; _neutralStreak = 0
    onSpeaking(false); onExpression('neutral')
    if (!opts.silent) onStatus('')
    if (!opts.preserveMessageAudio) clearMessages([...messageAudio.keys()])
    notifyActivity()
  }

  function destroy() {
    destroyed = true; availabilityRevision++
    document.removeEventListener('visibilitychange', onVisibilityChange)
    stop({ preserveMessageAudio: false, silent: true })
    if (gainNode) { try { gainNode.disconnect() } catch {}; gainNode = null }
    if (audioContext) audioContext.close().catch(() => {}); audioContext = null; analyser = null
  }

  return { availability, refreshAvailability, readyFor, prepare, ensureAudioContext, isActive, ownsTurn, startTurn, append, finishTurn, stop, destroy, playMessage, hasAudio, clearMessages, setVolume }
}
