import type { Ref } from 'vue'
import type { VadSegmenter } from '@/utils/vadSegmenter'
import { normalizeSpeechInputConfig, isSpeechInputReady, type SpeechInputConfig } from '@/utils/speechInputConfig'
import { encodeWav16k, resampleTo16k } from '@/utils/pcmWav'

export type VoiceInputState = 'idle' | 'acquiring' | 'capturing' | 'recognizing' | 'error'
export type VoiceInputMode = 'manual' | 'auto'
export type VoiceTextSource = VoiceInputMode
export interface UseVoiceInputOptions {
  config: () => SpeechInputConfig
  onText?: (text: string, source: VoiceTextSource) => void
  onError?: (message: string) => void
  onStateChange?: (state: VoiceInputState, detail?: string) => void
}
export interface UseVoiceInput {
  state: Ref<VoiceInputState>
  errorMessage: Ref<string>
  level: Ref<number>
  supported: boolean
  autoListening: Ref<boolean>
  start(mode?: VoiceInputMode): Promise<void>
  stop(): void
  cancel(): void
  release(): void
}

const TARGET_RATE = 16_000
const MAX_MANUAL_SAMPLES = 30 * TARGET_RATE
const MAX_PENDING_SEGMENTS = 4

/** One microphone owner per interaction. Manual recording preserves quiet words
 * and pauses; only continuous listening uses VAD to decide when to transcribe. */
export function createVoiceInputRecorder(options: UseVoiceInputOptions, refs: Pick<UseVoiceInput, 'state' | 'errorMessage' | 'level' | 'autoListening'>, supported: boolean): UseVoiceInput & { start(mode?: VoiceInputMode, prepared?: { context: AudioContext; resumed: Promise<void> }): Promise<void> } {
  const { state, errorMessage, level, autoListening } = refs
  let stream: MediaStream | null = null, context: AudioContext | null = null
  let source: MediaStreamAudioSourceNode | null = null, processor: ScriptProcessorNode | null = null, muted: GainNode | null = null
  let vad: VadSegmenter | null = null
  let mode: VoiceInputMode = 'manual', capturing = false, recognizing = false, disposed = false, generation = 0
  let recognitionController: AbortController | null = null
  let recordingTimer: ReturnType<typeof setTimeout> | undefined
  const pendingSegments: Float32Array[] = [], manualFrames: Float32Array[] = []
  let manualSamples = 0, manualPeak = 0
  let captureConfig = normalizeSpeechInputConfig(null)

  function setState(next: VoiceInputState, detail?: string) {
    state.value = next
    if (detail !== undefined) errorMessage.value = detail
    options.onStateChange?.(next, detail)
  }

  function cleanup() {
    clearTimeout(recordingTimer); recordingTimer = undefined
    level.value = 0
    if (processor) { processor.onaudioprocess = null; processor.disconnect(); processor = null }
    source?.disconnect(); source = null
    muted?.disconnect(); muted = null
    if (stream) {
      for (const track of stream.getTracks()) { track.removeEventListener('ended', onTrackEnded); track.stop() }
      stream = null
    }
    const previous = context; context = null
    if (previous && previous.state !== 'closed') void previous.close().catch(() => {})
    capturing = false; autoListening.value = false
  }

  function cancel() {
    generation++
    recognitionController?.abort(); recognitionController = null
    recognizing = false
    pendingSegments.length = 0; manualFrames.length = 0; manualSamples = 0; manualPeak = 0; vad = null
    cleanup()
    setState('idle')
  }

  function fail(message: string) { cancel(); setState('error', message); options.onError?.(message) }
  function onTrackEnded() { if (capturing) fail('麦克风已断开或被系统停止，请检查设备后重试。') }

  function recognizeSegment(segment: Float32Array, voiceSource: VoiceTextSource) {
    const token = generation, controller = new AbortController()
    const current = () => !disposed && token === generation && !controller.signal.aborted
    recognitionController = controller; recognizing = true
    setState('recognizing')
    const settings = captureConfig
    void import('@/api/speechInputApi').then(audio => {
      if (!current()) return null
      return audio.recognizeWithAsr(settings, encodeWav16k(segment, TARGET_RATE), controller.signal)
    })
      .then(result => {
        if (!current() || !result) return
        recognizing = false; recognitionController = null
        options.onText?.(result.text, voiceSource)
        if (!current()) return
        if (capturing && mode === 'auto') { setState('capturing'); drainAutoQueue() }
        else setState('idle')
      })
      .catch(error => { if (current()) fail(error instanceof Error ? error.message : '语音识别失败，请重试。') })
  }

  function drainAutoQueue() {
    if (disposed || !capturing || recognizing) return
    const segment = pendingSegments.shift()
    if (segment) recognizeSegment(segment, 'auto')
  }

  async function start(nextMode: VoiceInputMode = 'manual', prepared?: { context: AudioContext; resumed: Promise<void> }) {
    if (disposed || ['capturing', 'recognizing'].includes(state.value)) return
    context = prepared?.context ?? null
    if (!supported) { fail('当前页面无法使用麦克风，请在桌面客户端或本机浏览器中打开。'); return }
    captureConfig = normalizeSpeechInputConfig(options.config())
    if (!isSpeechInputReady(captureConfig)) { fail('请先启用语音输入并保存有效的识别服务地址。'); return }
    const token = ++generation
    const current = () => !disposed && token === generation
    mode = nextMode; pendingSegments.length = 0; manualFrames.length = 0; manualSamples = 0; manualPeak = 0
    vad = null
    setState('acquiring', '')
    let acquisitionTimer: ReturnType<typeof setTimeout> | undefined
    let resumeTimer: ReturnType<typeof setTimeout> | undefined
    try {
      const policyDocument = document as Document & { permissionsPolicy?: { allowsFeature(name: string): boolean }; featurePolicy?: { allowsFeature(name: string): boolean } }
      if ((policyDocument.permissionsPolicy ?? policyDocument.featurePolicy)?.allowsFeature('microphone') === false) {
        throw new Error('当前页面禁止使用麦克风，请重新加载聊天页面后重试。')
      }
      // Resume within the user's gesture, before waiting for microphone permission.
      const audioContext = prepared?.context ?? new AudioContext()
      context = audioContext
      const resumed = prepared?.resumed ?? audioContext.resume()
      void resumed.catch(() => {})
      const acquisition = navigator.mediaDevices.getUserMedia({ audio: {
        channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      } })
      void acquisition.then(acquired => {
        if (current()) stream = acquired
        else for (const track of acquired.getTracks()) track.stop()
      }, () => {})
      const [acquired, detection] = await Promise.all([
        Promise.race([acquisition, new Promise<never>((_, reject) => {
          acquisitionTimer = setTimeout(() => reject(new Error('等待麦克风授权超时，请允许麦克风访问后重试。')), 30_000)
        })]),
        import('@/utils/vadSegmenter'),
      ])
      clearTimeout(acquisitionTimer)
      if (!current()) { for (const track of acquired.getTracks()) track.stop(); return }
      stream = acquired
      vad = mode === 'auto' ? detection.createVadSegmenter({ sampleRate: TARGET_RATE }) : null
      await Promise.race([resumed, new Promise<never>((_, reject) => {
        resumeTimer = setTimeout(() => reject(new Error('音频采集未启动，请重新按住说话。')), 5000)
      })])
      if (!current()) return
      if (audioContext.state !== 'running') throw new Error('音频采集未启动，请重新按住说话。')
      source = audioContext.createMediaStreamSource(acquired)
      processor = audioContext.createScriptProcessor(4096, 1, 1)
      muted = audioContext.createGain(); muted.gain.value = 0
      source.connect(processor); processor.connect(muted); muted.connect(audioContext.destination)
      for (const track of acquired.getAudioTracks()) track.addEventListener('ended', onTrackEnded)
      processor.onaudioprocess = event => {
        if (!capturing || !current()) return
        const input = event.inputBuffer.getChannelData(0)
        const rms = detection.rmsOf(input, 0, input.length)
        level.value = Number.isFinite(rms) ? Math.min(1, rms * 3.5) : 0
        const samples = resampleTo16k(input, audioContext.sampleRate)
        if (mode === 'manual') {
          const frame = samples.slice(0, Math.max(0, MAX_MANUAL_SAMPLES - manualSamples))
          manualFrames.push(frame); manualSamples += frame.length; manualPeak = Math.max(manualPeak, rms)
          if (manualSamples >= MAX_MANUAL_SAMPLES) stop()
        } else if (vad) {
          vad.push(samples)
          for (const segment of vad.takeSegments()) {
            if (pendingSegments.length >= MAX_PENDING_SEGMENTS) pendingSegments.shift()
            pendingSegments.push(segment)
          }
          drainAutoQueue()
        }
      }
      capturing = true; autoListening.value = mode === 'auto'
      setState('capturing')
      if (mode === 'manual') recordingTimer = setTimeout(stop, 30_000)
    } catch (error) {
      if (!current()) return
      const name = error instanceof DOMException ? error.name : ''
      fail(name === 'NotAllowedError' ? '麦克风权限被拒绝，请允许桌面客户端或浏览器使用麦克风后重试。'
        : name === 'NotFoundError' ? '未找到麦克风，请连接设备并检查系统输入设置。'
        : name === 'NotReadableError' ? '无法读取麦克风，请检查设备是否被其他程序独占。'
        : error instanceof Error ? error.message : '无法启动麦克风，请检查设备后重试。')
    } finally { clearTimeout(acquisitionTimer); clearTimeout(resumeTimer) }
  }

  function stop() {
    if (!capturing) return
    if (mode === 'auto') { cancel(); return }
    cleanup()
    if (!manualSamples || manualPeak <= 0.00001) { fail('没有收到麦克风声音，请检查系统输入设备和音量后重试。'); return }
    const segment = new Float32Array(manualSamples)
    let offset = 0
    for (const frame of manualFrames) { segment.set(frame, offset); offset += frame.length }
    manualFrames.length = 0; manualSamples = 0; manualPeak = 0
    recognizeSegment(segment, 'manual')
  }

  function release() { if (disposed) return; disposed = true; cancel() }
  return { state, errorMessage, level, supported, autoListening, start, stop, cancel, release }
}
