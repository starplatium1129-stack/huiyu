/**
 * 语音输入采集 composable（长按说话 + 自动监听）。
 *
 * 两种模式：
 * - manual（长按说话）：按住 start() 采集，松开 stop() 用 VAD 切段并识别；
 * - auto（唤醒词连续对话）：start('auto') 后持续采集，VAD 每完成一段立即
 *   识别并回调，采集不断；stop() 停止并丢弃未完成段。
 *
 * 纯逻辑（VAD / 重采样 / WAV / ASR 请求）都在 src/utils 下，本文件只做
 * 浏览器音频管线与状态编排，不承载可测算法。
 */

import { ref, type Ref } from 'vue'
import { createVadSegmenter, rmsOf } from '@/utils/vadSegmenter'
import { resampleTo16k, encodeWav16k, recognizeWithAsr } from '@/utils/voiceApi'
import type { SpeechInputConfig } from '@/utils/speechInputConfig'

export type VoiceInputState = 'idle' | 'acquiring' | 'capturing' | 'recognizing' | 'error'
export type VoiceInputMode = 'manual' | 'auto'
export type VoiceTextSource = VoiceInputMode

export interface UseVoiceInputOptions {
  /** 实时读取当前语音输入配置（响应式） */
  config: () => SpeechInputConfig
  /** 识别结果回调；source 区分自动监听（唤醒/会话路由）与手动长按（直接确认） */
  onText?: (text: string, source: VoiceTextSource) => void
  onError?: (message: string) => void
  onStateChange?: (state: VoiceInputState, detail?: string) => void
}

export interface UseVoiceInput {
  state: Ref<VoiceInputState>
  errorMessage: Ref<string>
  /** 已有采集流的归一化 RMS 电平；不建立第二条麦克风/分析管线。 */
  level: Ref<number>
  /** 浏览器是否支持麦克风采集 */
  supported: boolean
  /** 自动监听是否运行中（auto 模式） */
  autoListening: Ref<boolean>
  start(mode?: VoiceInputMode): Promise<void>
  /** manual：停止采集并识别当前段；auto：停止采集并丢弃未完成段 */
  stop(): void
  /** 停止采集并丢弃当前段 */
  cancel(): void
  /** 释放媒体资源（组件卸载时调用） */
  release(): void
}

const TARGET_RATE = 16_000
/** 停止时补入的尾静音（ms），让 VAD 自然完结当前段 */
const TAIL_SILENCE_MS = 500
/** 合并段的总时长上限（ms），超出丢弃尾部 */
const MAX_COMBINED_MS = 30_000
/** 自动模式下识别队列积压上限（段数），超限丢弃最旧段 */
const MAX_PENDING_SEGMENTS = 4

export function useVoiceInput(options: UseVoiceInputOptions): UseVoiceInput {
  const state = ref<VoiceInputState>('idle')
  const errorMessage = ref('')
  const level = ref(0)
  const autoListening = ref(false)
  const supported = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)

  let stream: MediaStream | null = null
  let context: AudioContext | null = null
  let source: MediaStreamAudioSourceNode | null = null
  let processor: ScriptProcessorNode | null = null
  let muted: GainNode | null = null
  let vad: ReturnType<typeof createVadSegmenter> | null = null
  let capturing = false
  let mode: VoiceInputMode = 'manual'
  let recognizing = false
  let disposed = false
  let canceled = false
  let startToken = 0
  let recognitionController: AbortController | null = null
  const pendingSegments: Float32Array[] = []

  function setState(next: VoiceInputState, detail?: string): void {
    state.value = next
    if (detail !== undefined) errorMessage.value = detail
    options.onStateChange?.(next, detail)
  }

  function cleanupTracks(): void {
    level.value = 0
    if (stream) {
      for (const track of stream.getTracks()) track.stop()
      stream = null
    }
  }

  function teardownGraph(): void {
    if (processor) {
      processor.onaudioprocess = null
      try { processor.disconnect() } catch { /* 已断开 */ }
      processor = null
    }
    if (source) {
      try { source.disconnect() } catch { /* 已断开 */ }
      source = null
    }
    if (muted) {
      try { muted.disconnect() } catch { /* 已断开 */ }
      muted = null
    }
    if (context && context.state !== 'closed') {
      void context.close().catch(() => { /* 关闭失败可忽略 */ })
    }
    context = null
  }

  /** 识别一段语音（自动模式下串行调用，识别期间新段入队等待）。 */
  function recognizeSegment(segment: Float32Array, source: VoiceTextSource): void {
    const token = startToken
    const current = () => !disposed && !canceled && token === startToken
    const controller = new AbortController()
    recognitionController = controller
    const wav = encodeWav16k(segment, TARGET_RATE)
    setState('recognizing')
    if (!current()) return
    void recognizeWithAsr(options.config(), wav, controller.signal)
      .then(result => {
        if (!current()) return
        setState(mode === 'auto' ? 'capturing' : 'idle')
        if (current() && result.text) options.onText?.(result.text, source)
        if (current() && mode === 'auto') drainAutoQueue(token)
      })
      .catch(error => {
        if (!current()) return
        const message = error instanceof Error ? error.message : '语音识别失败'
        setState(mode === 'auto' ? 'capturing' : 'idle')
        if (current()) options.onError?.(message)
        if (current() && mode === 'auto') drainAutoQueue(token)
      })
      .finally(() => { if (recognitionController === controller) recognitionController = null })
  }

  /** 自动模式：按序处理积压段，全部处理后若仍在采集则恢复监听。 */
  function drainAutoQueue(token = startToken): void {
    if (disposed || canceled || token !== startToken) return
    recognizing = false
    if (disposed || !capturing) return
    const next = pendingSegments.shift()
    if (next) {
      recognizing = true
      recognizeSegment(next, 'auto')
    }
  }

  function handleManualStop(): void {
    if (!vad) return
    vad.push(new Float32Array(Math.round((TAIL_SILENCE_MS / 1000) * TARGET_RATE)))
    const segments = vad.takeSegments()
    if (segments.length === 0) {
      setState('idle')
      return
    }
    // 长按期间的多段按序合并（停顿会被 VAD 切成多段，合并回完整一句）。
    const maxSamples = Math.round((MAX_COMBINED_MS / 1000) * TARGET_RATE)
    const merged: number[] = []
    for (const segment of segments) {
      if (merged.length >= maxSamples) break
      for (let i = 0; i < segment.length && merged.length < maxSamples; i += 1) merged.push(segment[i])
    }
    if (merged.length === 0) {
      setState('idle')
      return
    }
    recognizeSegment(new Float32Array(merged), 'manual')
  }

  async function start(nextMode: VoiceInputMode = 'manual'): Promise<void> {
    if (disposed) return
    if (state.value === 'capturing' || state.value === 'acquiring' || state.value === 'recognizing') return
    const token = ++startToken
    canceled = false
    recognizing = false
    pendingSegments.length = 0
    mode = nextMode
    setState('acquiring')
    errorMessage.value = ''
    vad = createVadSegmenter({ sampleRate: TARGET_RATE })

    try {
      const policyDocument = typeof document === 'undefined' ? undefined : document as Document & {
        permissionsPolicy?: { allowsFeature(name: string): boolean }
        featurePolicy?: { allowsFeature(name: string): boolean }
      }
      const policy = policyDocument?.permissionsPolicy ?? policyDocument?.featurePolicy
      if (policy?.allowsFeature('microphone') === false) {
        throw new Error('当前页面的麦克风策略禁止采集，请重新加载语音页面；浏览器授权无法覆盖此限制')
      }
      const acquiredStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      if (disposed || canceled || token !== startToken) {
        for (const track of acquiredStream.getTracks()) track.stop()
        if (token === startToken) setState('idle')
        return
      }
      stream = acquiredStream
    } catch (error) {
      if (disposed || canceled || token !== startToken) {
        if (token === startToken) setState('idle')
        return
      }
      const name = error instanceof DOMException ? error.name : ''
      const message = name === 'NotAllowedError'
        ? '麦克风权限被拒绝，请在浏览器设置中允许后重试'
        : name === 'NotFoundError'
          ? '未找到可用的麦克风设备'
          : `无法访问麦克风：${error instanceof Error ? error.message : String(error)}`
      setState('error', message)
      options.onError?.(message)
      cleanupTracks()
      return
    }

    try {
      context = new AudioContext({ sampleRate: TARGET_RATE })
    } catch {
      context = new AudioContext()
    }
    try {
      source = context.createMediaStreamSource(stream)
      processor = context.createScriptProcessor(4096, 1, 1)
      muted = context.createGain()
      muted.gain.value = 0
      source.connect(processor)
      processor.connect(muted)
      muted.connect(context.destination)
    } catch (error) {
      const message = `无法创建音频处理链：${error instanceof Error ? error.message : String(error)}`
      setState('error', message)
      options.onError?.(message)
      cleanupTracks()
      teardownGraph()
      return
    }

    processor.onaudioprocess = (event: AudioProcessingEvent): void => {
      if (!capturing || !vad || disposed || token !== startToken) return
      const channel = event.inputBuffer.getChannelData(0)
      const rms = rmsOf(channel, 0, channel.length)
      level.value = Number.isFinite(rms) ? Math.min(1, rms * 3.5) : 0
      vad.push(resampleTo16k(channel, context?.sampleRate ?? TARGET_RATE))
      if (mode === 'auto' && !recognizing) {
        const segments = vad.takeSegments()
        for (const segment of segments) {
          if (pendingSegments.length >= MAX_PENDING_SEGMENTS) pendingSegments.shift()
          pendingSegments.push(segment)
        }
        drainAutoQueue()
      }
    }

    capturing = true
    autoListening.value = mode === 'auto'
    setState('capturing')
  }

  function stop(): void {
    if (!capturing) return
    capturing = false
    const wasAuto = mode === 'auto'
    if (wasAuto) {
      // 自动模式：停止监听，丢弃未完成段；已入队的段继续识别。
      vad = null
      mode = 'manual'
    } else {
      handleManualStop()
    }
    cleanupTracks()
    teardownGraph()
    if (wasAuto && !recognizing) {
      setState('idle')
    }
    autoListening.value = false
  }

  function cancel(): void {
    startToken += 1
    capturing = false
    recognizing = false
    canceled = true
    recognitionController?.abort()
    recognitionController = null
    pendingSegments.length = 0
    cleanupTracks()
    teardownGraph()
    autoListening.value = false
    setState('idle')
  }

  function release(): void {
    disposed = true
    cancel()
  }

  return { state, errorMessage, level, supported, autoListening, start, stop, cancel, release }
}
