import { reactive, shallowReactive } from 'vue'
import { resolveRuntimeUrl, runtimeResourceCors } from '../../platform/runtimeUrl.ts'
import { isAbortError } from '../../utils/stream.ts'
import type { VoicePcmStream } from '../voicePcmStream.ts'
import { VoiceReplayCache } from '../voiceReplayCache.ts'
import { playVoiceAudio, removeAudioSource, type AudioWithSource, type AudioEndReason } from '../voiceAudioPlayback.ts'
import { cancelSystemSpeech, playSystemSpeech } from '../voiceSpeechSynthesis.ts'
import { voiceErrorMessage } from '../useVoicePreparation.ts'

export interface ReplayClip {
  url: string
  emotion: string
  speechText?: string
  speechVoice?: string
  speechLanguage?: 'zh' | 'ja'
}

export interface SynthesizedClip extends ReplayClip {
  stream?: VoicePcmStream
}

interface QueuedClip extends SynthesizedClip {
  mid: string
  session: number
  audio?: AudioWithSource
  /** 整句播放失败时的剩余重试次数；已经开播的句子不重复生成。 */
  retryLeft?: number
  recorded?: ReplayClip
  observed?: boolean
}

type AudioContextConstructor = new () => AudioContext

function playbackError(reason: AudioEndReason): string {
  if (reason === 'load-timeout') return '语音生成超时，请点击重播再试。'
  if (reason === 'play-timeout') return '语音播放超时，请点击重播再试。'
  if (reason === 'blocked') return '浏览器阻止了声音播放，请点击消息下方的重播。'
  if (reason === 'load-error') return '语音加载失败，请点击重播再试。'
  if (reason === 'play-error') return '语音播放中断，请点击重播再试。'
  return ''
}

export function createVoicePlaybackEngine(options: {
  getSession: () => number
  hasPending: () => boolean
  isDestroyed: () => boolean
  stopForReplay: () => void
  notifyActivity: () => void
  onStatus: (text: string) => void
  onError: (msg: string) => void
  onSpeaking: (v: boolean, mid?: string) => void
  onExpression: (emotion: string) => void
  onMouth: (v: number) => void
  onAudioLevel: (level: number, peak: number) => void
}) {
  const {
    getSession, hasPending, isDestroyed, stopForReplay, notifyActivity,
    onStatus, onError, onSpeaking, onExpression, onMouth, onAudioLevel,
  } = options

  let queue: QueuedClip[] = []
  let playing = false
  let currentAudio: AudioWithSource | null = null
  let replayAudio: AudioWithSource | null = null
  let currentPcm: VoicePcmStream | null = null
  // Track replay records per message without proxying audio or stream resources.
  const messageAudio = shallowReactive(new Map<string, ReplayClip[]>())
  const replayCache = new VoiceReplayCache()
  let audioContext: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let gainNode: GainNode | null = null
  let lipFrame = 0
  let lipSmooth = 0
  let _warnedAnalyser = false
  let cancelPlayback: (() => void) | null = null
  let cancelReplay: (() => void) | null = null
  let volume = 1

  function ensureAudioContext() {
    if (isDestroyed()) return
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
      } catch { releaseAudioContext() }
    }
    if (audioContext?.state === 'suspended') audioContext.resume().catch(() => {})
  }

  function releaseAudioContext() {
    try { analyser?.disconnect() } catch {}
    try { gainNode?.disconnect() } catch {}
    if (audioContext) void audioContext.close().catch(() => {})
    audioContext = null; analyser = null; gainNode = null
  }

  function isPlaying() { return playing }
  function isPlayingOrQueued() { return Boolean(playing || queue.length) }
  function isBusy() { return Boolean(playing || queue.length || replayAudio) }

  function observeStream(item: QueuedClip) {
    if (!item.stream || item.observed) return
    item.observed = true
    void item.stream.start().then(blob => {
      if (item.session !== getSession() || !item.recorded || !messageAudio.get(item.mid)?.includes(item.recorded)) return
      replayCache.remember(item.mid, item.recorded, blob, item.url)
    }).catch(() => {}) // Playback reports a prefetched failure once it owns this clip.
  }

  function prefetch() {
    const next = playing ? queue[0] : undefined
    if (!next || next.speechText) return
    if (next.stream) { observeStream(next); return }
    if (!next.audio) { next.audio = createAudio(next.url); next.audio.load() }
  }

  function createAudio(url: string): AudioWithSource {
    const audio = new Audio() as AudioWithSource
    audio.preload = 'auto'
    audio.crossOrigin = runtimeResourceCors() ?? null
    audio.src = resolveRuntimeUrl(url)
    return audio
  }

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
    if (lipFrame || !analyser || document.hidden || isDestroyed()) return
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

  function enqueueSynthesized(item: SynthesizedClip, mid: string, sess: number) {
    const clips = messageAudio.get(mid) || reactive<ReplayClip[]>([])
    const stored = reactive<ReplayClip>({
      url: item.stream ? '' : item.url,
      emotion: item.emotion || 'neutral',
      ...(item.speechText ? { speechText: item.speechText, speechVoice: item.speechVoice, speechLanguage: item.speechLanguage } : {}),
    })
    clips.push(stored); messageAudio.set(mid, clips)
    queue.push({ ...item, mid, session: sess, recorded: stored })
    pump(sess); prefetch()
  }

  function pump(sess: number) {
    if (playing || !queue.length || sess !== getSession()) return
    const item = queue.shift()
    if (!item) return
    playing = true
    onSpeaking(false); onExpression('neutral'); stopLipSync()
    if (item.speechText) {
      const speech = playSystemSpeech({
        text: item.speechText,
        voice: item.speechVoice || 'nene',
        language: item.speechLanguage || 'zh',
        volume,
        onStarted: () => {
          if (sess === getSession()) {
            onExpression(item.emotion); onSpeaking(true, item.mid); onStatus('系统朗读中…')
          }
        },
        onMouth,
        onAudioLevel,
      })
      cancelPlayback = speech.cancel
      onStatus('系统朗读中…'); notifyActivity()
      void speech.result.then(reason => {
        if (sess !== getSession()) return
        cancelPlayback = null; playing = false; stopLipSync()
        if (reason === 'play-error') onError('系统朗读失败，可在控制室「语音配置」切换语音引擎。')
        if (!queue.length || reason !== 'ended') {
          onSpeaking(false, item.mid); onExpression('neutral'); onStatus(hasPending() ? '语音合成中…' : '')
        }
        pump(sess); prefetch(); notifyActivity()
      })
      return
    }
    if (item.stream && audioContext && analyser) {
      const stream = item.stream
      currentPcm = stream; observeStream(item)
      cancelPlayback = () => stream.cancel()
      onStatus('语音合成中…'); notifyActivity()
      void stream.play(audioContext, analyser, () => {
        if (sess !== getSession() || currentPcm !== stream) return
        onExpression(item.emotion); onSpeaking(true, item.mid); onStatus('播放中…'); startLipSync()
      }).catch(e => {
        if (sess !== getSession() || currentPcm !== stream || isAbortError(e)) return
        // Retain a manual whole-clip retry, never the incomplete PCM data.
        if (item.recorded && !item.recorded.url && messageAudio.get(item.mid)?.includes(item.recorded)) {
          item.recorded.url = item.url
        }
        onError('一句配音失败：' + voiceErrorMessage(e))
      })
        .finally(() => {
          if (sess !== getSession() || currentPcm !== stream) return
          currentPcm = null; playing = false; cancelPlayback = null
          if (!queue.length) { onSpeaking(false, item.mid); onExpression('neutral'); onStatus(hasPending() ? '语音合成中…' : '') }
          pump(sess); prefetch(); notifyActivity()
        })
      prefetch(); return
    }
    if (item.stream) {
      item.stream.cancel()
      if (item.recorded) item.recorded.url = item.url
    }
    const audio = item.audio || createAudio(item.url)
    currentAudio = audio; attachAnalyser(audio)
    onStatus('语音合成中…'); notifyActivity()
    const playback = playVoiceAudio(audio, {
      onStarted: () => { if (sess === getSession() && currentAudio === audio) { onExpression(item.emotion); onSpeaking(true, item.mid); onStatus('播放中…'); startLipSync() } },
      onSlow: extension => { if (sess === getSession() && currentAudio === audio) onStatus(extension === 1 ? '语音生成较慢，继续等待…' : '语音生成很慢，还在排队…') },
    })
    cancelPlayback = playback.cancel
    void playback.result.then(reason => {
      if (sess !== getSession() || currentAudio !== audio) return
      cancelPlayback = null
      currentAudio = null; playing = false; stopLipSync()
      // Only a loading/network failure gets one retry. An interrupted sentence
      // that already started must never be synthesized and spoken from the top.
      if (reason === 'load-error' && item.retryLeft !== 0) {
        onStatus('语音加载失败，重试…')
        queue.unshift({ ...item, audio: undefined, retryLeft: (item.retryLeft ?? 1) - 1 })
      } else {
        const message = playbackError(reason)
        if (message) onError(message)
        if (!queue.length || reason !== 'ended') {
          onSpeaking(false, item.mid); onExpression('neutral'); onStatus(hasPending() ? '语音合成中…' : '')
        }
      }
      pump(sess); prefetch(); notifyActivity()
    })
  }

  async function playMessage(mid: string): Promise<boolean> {
    const clips = (messageAudio.get(mid) || []).filter(clip => Boolean(clip.url || clip.speechText))
    if (!clips.length) return false
    stopForReplay(); ensureAudioContext()
    const rs = getSession(); let succeeded = true
    for (const clip of clips) {
      if (rs !== getSession()) return false
      if (clip.speechText) {
        onSpeaking(false); onExpression('neutral'); stopLipSync(); onStatus('重播系统朗读…'); notifyActivity()
        const speech = playSystemSpeech({
          text: clip.speechText,
          voice: clip.speechVoice || 'nene',
          language: clip.speechLanguage || 'zh',
          volume,
          onStarted: () => {
            if (rs === getSession()) {
              onExpression(clip.emotion || 'neutral'); onSpeaking(true, mid); onStatus('重播中…')
            }
          },
          onMouth,
          onAudioLevel,
        })
        cancelReplay = speech.cancel
        const reason = await speech.result
        if (rs !== getSession()) return false
        cancelReplay = null
        if (reason !== 'ended') { succeeded = false; if (reason === 'play-error') onError('系统朗读失败。'); break }
        continue
      }
      const audio = new Audio() as AudioWithSource
      audio.crossOrigin = runtimeResourceCors() ?? null
      audio.src = resolveRuntimeUrl(clip.url)
      const release = replayCache.pin(clip)
      replayAudio = audio; attachAnalyser(audio)
      onSpeaking(false); onExpression('neutral'); stopLipSync(); onStatus('正在加载重播语音…'); notifyActivity()
      const playback = playVoiceAudio(audio, {
        onStarted: () => { if (rs === getSession() && replayAudio === audio) { onExpression(clip.emotion || 'neutral'); onSpeaking(true, mid); onStatus('重播中…'); startLipSync() } },
        onSlow: () => { if (rs === getSession() && replayAudio === audio) onStatus('重播语音加载较慢，继续等待…') },
        onCleanup: release,
      })
      cancelReplay = playback.cancel
      const reason = await playback.result
      if (rs !== getSession()) return false
      if (replayAudio === audio) { replayAudio = null; cancelReplay = null }
      if (reason !== 'ended') { succeeded = false; const message = playbackError(reason); if (message) onError(message); break }
    }
    if (rs === getSession()) { replayAudio = null; onSpeaking(false, mid); onExpression('neutral'); onStatus(''); stopLipSync(); notifyActivity() }
    return succeeded && rs === getSession()
  }

  function hasAudio(mid: string) { return Boolean(messageAudio.get(mid)?.some(clip => Boolean(clip.url || clip.speechText))) }

  function clearMessages(mids: string[]) {
    mids.forEach(mid => { const c = messageAudio.get(mid) || []; c.forEach(cl => replayCache.remove(cl)); messageAudio.delete(mid) })
  }

  function stopPlayback(opts: { preserveMessageAudio?: boolean; silent?: boolean } = {}) {
    cancelPlayback?.(); cancelPlayback = null
    cancelReplay?.(); cancelReplay = null
    cancelSystemSpeech()
    queue.forEach(it => {
      it.stream?.cancel()
      if (it.audio) { it.audio.pause(); it.audio.removeAttribute('src'); it.audio.load() }
    }); queue = []
    if (currentAudio) { currentAudio.pause(); removeAudioSource(currentAudio); currentAudio.removeAttribute('src') }
    if (replayAudio) { replayAudio.pause(); removeAudioSource(replayAudio); replayAudio.removeAttribute('src') }
    currentPcm = null; currentAudio = null; replayAudio = null; playing = false; stopLipSync()
    onSpeaking(false); onExpression('neutral')
    if (!opts.silent) onStatus('')
    if (!opts.preserveMessageAudio) clearMessages([...messageAudio.keys()])
  }

  function destroy() {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    releaseAudioContext()
  }

  return {
    ensureAudioContext,
    isPlaying,
    isPlayingOrQueued,
    isBusy,
    enqueueSynthesized,
    playMessage,
    hasAudio,
    clearMessages,
    setVolume,
    stopPlayback,
    destroy,
  }
}
