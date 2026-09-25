import { ref, onBeforeUnmount, getCurrentInstance } from 'vue'

export interface VoiceMeterOptions {
  fftSize?: number
  smoothing?: number
}

/**
 * useVoiceMeter —— 基于 Web Audio API 的实时音频电平采集 Composable
 */
export function useVoiceMeter(options: VoiceMeterOptions = {}) {
  const level = ref(0)
  const isListening = ref(false)

  let audioCtx: AudioContext | null = null
  let analyser: AnalyserNode | null = null
  let sourceNode: MediaStreamAudioSourceNode | null = null
  let rafId: number | null = null
  let dataArray: Uint8Array | null = null

  function cleanupAudio(): void {
    if (rafId !== null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
    if (sourceNode) {
      sourceNode.disconnect()
      sourceNode = null
    }
    if (analyser) {
      analyser.disconnect()
      analyser = null
    }
    if (audioCtx && audioCtx.state !== 'closed') {
      audioCtx.close().catch(() => {})
      audioCtx = null
    }
    isListening.value = false
    level.value = 0
  }

  function sampleLoop(): void {
    if (!analyser || !dataArray) return

    analyser.getByteTimeDomainData(dataArray as Uint8Array<ArrayBuffer>)

    // 计算均方根 (RMS) 能量
    let sumSquares = 0
    const len = dataArray.length
    for (let i = 0; i < len; i++) {
      const normalized = (dataArray[i] - 128) / 128
      sumSquares += normalized * normalized
    }
    const rms = Math.sqrt(sumSquares / len)

    // 映射到 0~1 的动态范围
    level.value = Math.min(1, rms * 3.5)

    rafId = requestAnimationFrame(sampleLoop)
  }

  function attachStream(stream: MediaStream): void {
    cleanupAudio()

    if (typeof window === 'undefined') return
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    if (!AudioContextClass) return

    audioCtx = new AudioContextClass()
    analyser = audioCtx.createAnalyser()
    analyser.fftSize = options.fftSize || 256
    analyser.smoothingTimeConstant = options.smoothing ?? 0.8

    sourceNode = audioCtx.createMediaStreamSource(stream)
    sourceNode.connect(analyser)

    dataArray = new Uint8Array(analyser.frequencyBinCount)
    isListening.value = true
    sampleLoop()
  }

  function setManualLevel(val: number): void {
    level.value = Math.max(0, Math.min(1, val))
  }

  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      cleanupAudio()
    })
  }

  return {
    level,
    isListening,
    attachStream,
    detachStream: cleanupAudio,
    setManualLevel,
  }
}
