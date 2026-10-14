/**
 * 纯 TS 语音活动检测（VAD）切段器，无 DOM/无音频硬件依赖。
 *
 * 职责：把 16kHz 单声道 Float32 PCM 流切分成"活动语音段"，丢弃静音与
 * 短爆音，段首保留弱起音回填、段尾保留少量 padding，段长上限强制截断。
 *
 * 实现：按固定帧（默认 10ms）计算 RMS 能量，与自适应噪声底阈值比较；
 * 进入语音需连续 minSpeechMs，退出需连续 minSilenceMs 静音。
 * 全程确定性（除调用方输入的波形外无随机源）。
 */

export interface VadSegmenterConfig {
  /** PCM 采样率（Hz） */
  sampleRate: number
  /** 分析帧长度（ms） */
  frameMs: number
  /** 语音 RMS 阈值（0..1，归一化幅度） */
  threshold: number
  /** 最短语音长度（ms），短于它视为爆音/杂音丢弃 */
  minSpeechMs: number
  /** 段间静音长度（ms），连续静音达到它判定语音结束 */
  minSilenceMs: number
  /** 段尾保留的静音 padding（ms） */
  padMs: number
  /** 单段最大长度（ms），超过强制截断成新段 */
  maxSegmentMs: number
  /** 前 N 帧用于估算环境噪声底（ms），0 表示关闭自适应 */
  noiseFloorMs: number
}

export const DEFAULT_VAD_CONFIG: VadSegmenterConfig = {
  sampleRate: 16_000,
  frameMs: 10,
  threshold: 0.02,
  minSpeechMs: 250,
  minSilenceMs: 500,
  padMs: 200,
  maxSegmentMs: 15_000,
  noiseFloorMs: 300,
}

export interface VadSegmenter {
  /** 输入一段 PCM；内部按帧切分，产出段在 takeSegments 中取 */
  push(samples: Float32Array): void
  /** 取出全部已完成的语音段并清空（FIFO） */
  takeSegments(): Float32Array[]
  /** 当前是否有未完成的语音段 */
  inSpeech(): boolean
  /** 当前语音段已累积的时长（ms） */
  speechMs(): number
  /** 当前生效的能量阈值（校准完成后为估计值，否则为配置阈值） */
  effectiveThreshold(): number
  /** 清空内部状态与未完成段 */
  reset(): void
}

export function normalizeVadConfig(raw: Partial<VadSegmenterConfig>): VadSegmenterConfig {
  const base = { ...DEFAULT_VAD_CONFIG }
  const num = (value: unknown, fallback: number, min: number, max: number): number => {
    const n = Number(value)
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback
  }
  return {
    sampleRate: Math.round(num(raw.sampleRate, base.sampleRate, 8_000, 48_000)),
    frameMs: num(raw.frameMs, base.frameMs, 5, 100),
    threshold: num(raw.threshold, base.threshold, 0.001, 1),
    minSpeechMs: num(raw.minSpeechMs, base.minSpeechMs, 50, 5_000),
    minSilenceMs: num(raw.minSilenceMs, base.minSilenceMs, 50, 5_000),
    padMs: num(raw.padMs, base.padMs, 0, 1_000),
    maxSegmentMs: num(raw.maxSegmentMs, base.maxSegmentMs, 500, 60_000),
    noiseFloorMs: num(raw.noiseFloorMs, base.noiseFloorMs, 0, 5_000),
  }
}

/** 计算一段采样的 RMS（归一化幅度 0..1）。 */
export function rmsOf(samples: Float32Array, offset: number, length: number): number {
  let sum = 0
  const end = Math.min(samples.length, offset + length)
  for (let i = offset; i < end; i += 1) {
    const v = samples[i]
    sum += v * v
  }
  const count = end - offset
  return count > 0 ? Math.sqrt(sum / count) : 0
}

export function createVadSegmenter(rawConfig?: Partial<VadSegmenterConfig>): VadSegmenter {
  const config = normalizeVadConfig(rawConfig ?? {})
  const frameSamples = Math.max(1, Math.round((config.frameMs / 1000) * config.sampleRate))
  const minSpeechFrames = Math.max(1, Math.ceil(config.minSpeechMs / config.frameMs))
  const minSilenceFrames = Math.max(1, Math.ceil(config.minSilenceMs / config.frameMs))
  const minSegmentSamples = Math.round((config.minSpeechMs / 1000) * config.sampleRate)
  const padSamples = Math.round((config.padMs / 1000) * config.sampleRate)
  const maxSegmentSamples = Math.round((config.maxSegmentMs / 1000) * config.sampleRate)
  const noiseFloorFrames = Math.max(0, Math.round(config.noiseFloorMs / config.frameMs))
  // 语音起点的前导帧回填量：等价约 60ms 的弱起音缓冲，避免开头的辅音被吞。
  const backfillSamples = Math.min(minSpeechFrames, 6) * frameSamples

  // 输入余量：不足一帧时缓存到下一轮。
  let pending: number[] = []
  let active = false
  let speechSamples: number[] = []
  // 语音中最后一个语音帧的结束位置（用于段尾裁剪）。
  let lastVoiceEnd = 0
  let silenceFrames = 0
  let speechFramesSinceStart = 0
  let backfill: number[] = []
  let thresholdEstimate: number | null = null
  const calibrationRms: number[] = []
  const completed: Float32Array[] = []

  function effectiveThresholdValue(): number {
    return thresholdEstimate ?? config.threshold
  }

  function maybeFinalizeCalibration(): void {
    if (thresholdEstimate !== null) return
    if (noiseFloorFrames > 0 && calibrationRms.length < noiseFloorFrames) return
    if (calibrationRms.length > 0) {
      // 低百分位（p10）估计噪声底：开头就说话时，median 会被语音帧抬到
      // 高于语音本身，导致整段丢失；p10 几乎只反映底噪，语音帧污染极小。
      const sorted = [...calibrationRms].sort((a, b) => a - b)
      const floorEstimate = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.1))]
      // 噪声底的 2 倍，且不低于配置阈值。
      thresholdEstimate = Math.max(config.threshold, floorEstimate * 2)
    } else {
      thresholdEstimate = config.threshold
    }
  }

  function finishSegment(): void {
    // 段尾裁剪：保留到"最后一个语音帧 + padSamples"。
    const cut = Math.min(speechSamples.length, lastVoiceEnd + padSamples)
    const trimmed = speechSamples.slice(0, cut)
    if (trimmed.length >= minSegmentSamples) {
      completed.push(new Float32Array(trimmed))
    }
    speechSamples = []
    active = false
    silenceFrames = 0
    speechFramesSinceStart = 0
    lastVoiceEnd = 0
  }

  function pushFrame(frame: Float32Array): void {
    const rms = rmsOf(frame, 0, frame.length)
    const currentThreshold = effectiveThresholdValue()
    const voice = rms >= currentThreshold

    if (thresholdEstimate === null) {
      if (voice) {
        // 开口即打断校准：立即采用配置阈值，避免开头 300ms 的语音被
        // 当作噪声底（恒定 RMS 语音会让 median/p10 估计都失效）。
        thresholdEstimate = config.threshold
        calibrationRms.length = 0
      } else {
        if (noiseFloorFrames > 0 && calibrationRms.length < noiseFloorFrames) {
          calibrationRms.push(rms)
        }
        maybeFinalizeCalibration()
      }
    }

    if (!active) {
      if (voice) {
        // 起点：回填前导缓冲（弱起音），只回填一次后清空，避免重复累积。
        if (backfill.length > 0) {
          speechSamples.push(...backfill)
          backfill = []
        }
        speechSamples.push(...frame)
        speechFramesSinceStart += 1
        if (speechFramesSinceStart >= minSpeechFrames) {
          active = true
          lastVoiceEnd = speechSamples.length
        }
      } else {
        // 静音帧中断语音起点的连续计数；缓冲只保留最近 backfillSamples。
        speechFramesSinceStart = 0
        speechSamples = []
        backfill.push(...frame)
        if (backfill.length > backfillSamples) {
          backfill.splice(0, backfill.length - backfillSamples)
        }
      }
      return
    }

    // 语音进行中。
    speechSamples.push(...frame)
    if (voice) {
      silenceFrames = 0
      lastVoiceEnd = speechSamples.length
    } else {
      silenceFrames += 1
      if (silenceFrames >= minSilenceFrames) finishSegment()
    }

    // 单段长度上限：强制截断，避免一次说话过长整段全废。
    if (speechSamples.length >= maxSegmentSamples) finishSegment()
  }

  return {
    push(samples: Float32Array): void {
      // 循环逐个入队：spread 展开大数组会触发调用栈上限。
      for (let i = 0; i < samples.length; i += 1) pending.push(samples[i])
      const wholeFrames = Math.floor(pending.length / frameSamples)
      for (let index = 0; index < wholeFrames; index += 1) {
        pushFrame(new Float32Array(pending.slice(index * frameSamples, (index + 1) * frameSamples)))
      }
      pending.splice(0, wholeFrames * frameSamples)
      // 积压保护：超过 4 秒未消费的输入直接丢弃，避免内存膨胀。
      const maxPending = 4 * config.sampleRate
      if (pending.length > maxPending) {
        pending.splice(0, pending.length - maxPending)
      }
    },
    takeSegments(): Float32Array[] {
      return completed.splice(0, completed.length)
    },
    inSpeech(): boolean {
      return active || speechFramesSinceStart > 0
    },
    speechMs(): number {
      return (speechSamples.length / config.sampleRate) * 1000
    },
    effectiveThreshold(): number {
      return effectiveThresholdValue()
    },
    reset(): void {
      pending = []
      speechSamples = []
      completed.length = 0
      backfill = []
      silenceFrames = 0
      speechFramesSinceStart = 0
      lastVoiceEnd = 0
      active = false
      thresholdEstimate = null
      calibrationRms.length = 0
    },
  }
}
