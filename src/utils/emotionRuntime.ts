import type {
  AudioLevelAnalyzer,
  ModelProfile,
  MotionStyleOptions,
  NativeAnimationDirective,
  SoullinkRuntime,
} from '@soullink-emotion/engine'

const NENE_SOULLINK_PROFILE: ModelProfile = {
  modelId: 'nene', displayName: '绫地宁宁', version: '1', schemaVersion: 2,
  modelPath: '/assets/live2d-current/nene/nene.model3.json',
  parameterMap: {
    browInnerUp: { targets: ['ParamBrowLY', 'ParamBrowRY'], scale: 0.28, min: -1, max: 1 },
    browDown: { targets: ['ParamBrowLForm', 'ParamBrowRForm'], scale: -0.42, min: -1, max: 1 },
    eyeSmile: { targets: ['ParamEyeLSmile', 'ParamEyeRSmile'], scale: 0.78, min: 0, max: 1 },
    mouthSmile: { target: 'ParamMouthForm', scale: 0.72, min: -1, max: 1 },
    gazeX: { target: 'ParamEyeBallX', scale: 0.72, min: -1, max: 1 },
    gazeY: { target: 'ParamEyeBallY', scale: 0.55, min: -1, max: 1 },
    headX: { target: 'ParamAngleX', scale: 22, min: -30, max: 30 },
    headY: { target: 'ParamAngleY', scale: 18, min: -30, max: 30 },
    headZ: { target: 'ParamAngleZ', scale: 16, min: -30, max: 30 },
    bodyX: { target: 'ParamBodyAngleX', scale: 5, min: -10, max: 10 },
    bodyY: { target: 'ParamBodyAngleY', scale: 4, min: -10, max: 10 },
    bodyZ: { target: 'ParamBodyAngleZ', scale: 4, min: -10, max: 10 },
    breath: { target: 'ParamBreath', scale: 0.45, offset: 0.3, min: 0, max: 1 },
  },
  idleConfig: {
    gazeX: [-0.22, 0.22], gazeY: [-0.12, 0.12], headX: [-0.16, 0.16],
    headY: [-0.1, 0.1], headZ: [-0.08, 0.08], bodyX: [-0.08, 0.08],
    bodyY: [-0.06, 0.06], bodyZ: [-0.06, 0.06], breath: [0.35, 0.8],
  },
  parameterSmoothing: {
    ParamAngleX: 7, ParamAngleY: 7, ParamAngleZ: 7,
    ParamBodyAngleX: 5, ParamBodyAngleY: 5, ParamBodyAngleZ: 5,
    ParamEyeBallX: 8, ParamEyeBallY: 8,
  },
  nativeAnimations: { expressions: [], motions: [] },
  expressionMap: {},
  motionMap: {},
}

const NENE_SOULLINK_MOTION_STYLE: MotionStyleOptions = {
  spontaneity: 0.55, gestureFrequency: 0.72, gazeStability: 0.72,
  blinkRate: 0.9, breathRate: 0.92, breathVariance: 0.28,
  microMotionGain: 0.62, idleActionGain: 0.48, avoidRepeatWindow: 4,
  speechAccentGain: 0.38,
}

const NATSUME_SOULLINK_PROFILE: ModelProfile = {
  modelId: 'natsume', displayName: '四季夏目', version: '1', schemaVersion: 2,
  modelPath: '/assets/live2d-current/natsume/natsume.model3.json',
  parameterMap: {
    browInnerUp: { targets: ['ParamBrowLY', 'ParamBrowRY'], scale: 0.18, min: -1, max: 1 },
    browDown: { targets: ['ParamBrowLForm', 'ParamBrowRForm'], scale: -0.25, min: -1, max: 1 },
    gazeX: { target: 'ParamEyeBallX', scale: 0.58, min: -1, max: 1 },
    gazeY: { target: 'ParamEyeBallY', scale: 0.44, min: -1, max: 1 },
    headX: { target: 'ParamAngleX', scale: 18, min: -30, max: 30 },
    headY: { target: 'ParamAngleY', scale: 14, min: -30, max: 30 },
    headZ: { target: 'ParamAngleZ', scale: 12, min: -30, max: 30 },
    bodyX: { target: 'ParamBodyAngleX', scale: 3.5, min: -10, max: 10 },
    bodyY: { target: 'ParamBodyAngleY', scale: 3, min: -10, max: 10 },
    bodyZ: { target: 'ParamBodyAngleZ', scale: 3, min: -10, max: 10 },
  },
  idleConfig: {
    gazeX: [-0.18, 0.18], gazeY: [-0.1, 0.1], headX: [-0.12, 0.12],
    headY: [-0.08, 0.08], headZ: [-0.07, 0.07], bodyX: [-0.05, 0.05],
    bodyY: [-0.04, 0.04], bodyZ: [-0.04, 0.04],
  },
  parameterSmoothing: {
    ParamAngleX: 6, ParamAngleY: 6, ParamAngleZ: 6,
    ParamBodyAngleX: 4, ParamBodyAngleY: 4, ParamBodyAngleZ: 4,
    ParamEyeBallX: 8, ParamEyeBallY: 8,
  },
  nativeAnimations: { expressions: [], motions: [] },
  expressionMap: {},
  motionMap: {},
}

const NATSUME_SOULLINK_MOTION_STYLE: MotionStyleOptions = {
  spontaneity: 0.38, gestureFrequency: 0.46, gazeStability: 0.82,
  blinkRate: 0.78, breathRate: 0.72, breathVariance: 0.18,
  microMotionGain: 0.36, idleActionGain: 0.24, avoidRepeatWindow: 5,
  speechAccentGain: 0.2,
}

export type ChatEmotion = 'neutral' | 'shy' | 'happy' | 'sad' | 'serious' | 'gentle'

export interface VADVector {
  valence: number
  arousal: number
  dominance: number
}

export interface EmotionRuntimeConfig {
  emotionVAD: Record<ChatEmotion, VADVector>
  emotionParams: Record<ChatEmotion, Record<string, number>>
  reactionParams: Record<string, number>
  reactionDuration?: number
  decayRate?: number
  approachRate?: number
  soullink?: {
    profile: ModelProfile
    motionStyle: MotionStyleOptions
  }
}

export interface PushEmotionOptions {
  holdSeconds?: number
  holdTurns?: number
}

export interface EmotionRuntime {
  activate(): Promise<void>
  pushEmotion(emotion: string, options?: PushEmotionOptions): void
  onUserMessage(): void
  setSpeaking(value: boolean): void
  setAudioLevel(level: number, peak?: number): void
  update(deltaSeconds: number): void
  targets(): Record<string, number>
  performanceTargets(): Record<string, number>
  performanceFrame(): {
    live2dParams: Record<string, number>
    nativeAnimation: NativeAnimationDirective | null
  }
  intensity(): number
  lastEmotion(): string
  reset(): void
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** 情绪逼近过渡速率（原死常量 0.86）与保持时长（秒，原死常量 23）。 */
const NUDGE_TRANSITION_AMOUNT = 0.86
const NUDGE_HOLD_SECONDS = 23

function lerpVAD(from: VADVector, to: VADVector, amount: number): VADVector {
  const mix = (a: number, b: number) => clamp(a + (b - a) * amount, -1, 1)
  return { valence: mix(from.valence, to.valence), arousal: mix(from.arousal, to.arousal), dominance: mix(from.dominance, to.dominance) }
}

export const NENE_RUNTIME_CONFIG: EmotionRuntimeConfig = {
  emotionVAD: {
    neutral:  { valence: 0, arousal: 0, dominance: 0 },
    shy:      { valence: 0.42, arousal: -0.2, dominance: -0.5 },
    happy:    { valence: 0.75, arousal: 0.55, dominance: 0.25 },
    sad:      { valence: -0.65, arousal: -0.25, dominance: -0.4 },
    serious:  { valence: -0.15, arousal: 0.35, dominance: 0.4 },
    gentle:   { valence: 0.35, arousal: -0.35, dominance: 0.1 },
  },
  emotionParams: {
    neutral: {},
    shy: {
      ParamCheek: 0.95,
      ParamCheek5: 1,
      ParamEyeLSmile: 0.5,
      ParamEyeRSmile: 0.5,
      ParamBrowLY: 0.25,
      ParamBrowRY: 0.25,
      ParamMouthForm: -0.25,
    },
    happy: {
      ParamCheek1: 0.6,
      ParamEyeLSmile: 0.9,
      ParamEyeRSmile: 0.9,
      ParamBrowLAngle: 0.35,
      ParamBrowRAngle: 0.35,
      ParamMouthForm: 0.8,
    },
    sad: {
      ParamCheek7: 1,
      ParamBrowLY: -0.55,
      ParamBrowRY: -0.55,
      ParamBrowLForm: 0.6,
      ParamBrowRForm: 0.6,
      ParamMouthForm: -0.65,
    },
    serious: {
      ParamBrowLForm: -0.5,
      ParamBrowRForm: -0.5,
      ParamBrowLAngle: -0.4,
      ParamBrowRAngle: -0.4,
      ParamMouthForm: -0.4,
    },
    gentle: {
      ParamEyeLSmile: 0.65,
      ParamEyeRSmile: 0.65,
      ParamBrowLY: 0.18,
      ParamBrowRY: 0.18,
      ParamMouthForm: 0.45,
    },
  },
  reactionParams: {
    ParamCheek8: 1,
    ParamBrowLY: 0.2,
    ParamBrowRY: 0.2,
  },
  reactionDuration: 1.1,
  soullink: {
    profile: NENE_SOULLINK_PROFILE,
    motionStyle: NENE_SOULLINK_MOTION_STYLE,
  },
}

export const NATSUME_RUNTIME_CONFIG: EmotionRuntimeConfig = {
  emotionVAD: {
    neutral:  { valence: 0, arousal: 0, dominance: 0 },
    shy:      { valence: 0.42, arousal: -0.2, dominance: -0.5 },
    happy:    { valence: 0.75, arousal: 0.55, dominance: 0.25 },
    sad:      { valence: -0.65, arousal: -0.25, dominance: -0.4 },
    serious:  { valence: -0.15, arousal: 0.35, dominance: 0.4 },
    gentle:   { valence: 0.35, arousal: -0.35, dominance: 0.1 },
  },
  emotionParams: {
    neutral: {},
    shy: {
      ParamCheek: 0.7,
      ParamBrowLY: 0.15,
      ParamBrowRY: 0.15,
    },
    happy: {
      ParamCheek: 0.4,
      ParamBrowLAngle: 0.2,
      ParamBrowRAngle: 0.2,
    },
    sad: {
      ParamBrowLY: -0.3,
      ParamBrowRY: -0.3,
      ParamBrowLForm: 0.3,
      ParamBrowRForm: 0.3,
    },
    serious: {
      ParamBrowLForm: -0.3,
      ParamBrowRForm: -0.3,
      ParamBrowLAngle: -0.25,
      ParamBrowRAngle: -0.25,
    },
    gentle: {
      ParamBrowLY: 0.1,
      ParamBrowRY: 0.1,
      ParamCheek: 0.25,
    },
  },
  reactionParams: {
    ParamCheek: 0.6,
    ParamBrowLY: 0.15,
    ParamBrowRY: 0.15,
  },
  reactionDuration: 1.1,
  soullink: {
    profile: NATSUME_SOULLINK_PROFILE,
    motionStyle: NATSUME_SOULLINK_MOTION_STYLE,
  },
}

export const EMOTION_RUNTIME_CONFIGS: Readonly<Record<string, EmotionRuntimeConfig>> = {
  nene: NENE_RUNTIME_CONFIG,
  natsume: NATSUME_RUNTIME_CONFIG,
}

export function getEmotionRuntimeConfig(profileId: string): EmotionRuntimeConfig | undefined {
  return EMOTION_RUNTIME_CONFIGS[profileId]
}

export function createEmotionRuntime(config: EmotionRuntimeConfig): EmotionRuntime {
  const { emotionVAD, emotionParams, reactionParams, reactionDuration = 1.1, decayRate = 0.02, approachRate = 1.35 } = config
  let soullink: SoullinkRuntime | null = null
  let soullinkLoading: Promise<void> | null = null
  const baseline = { ...emotionVAD.neutral }
  const current: VADVector = { ...baseline }
  const target: VADVector = { ...baseline }
  let holdSeconds = 0
  let last = 'neutral'
  let speaking = false
  let presentIntensity = 0
  let reactionActive = false
  let reactionElapsed = 0
  let elapsedSeconds = 0
  let soullinkTargets: Record<string, number> = {}
  let soullinkNativeAnimation: NativeAnimationDirective | null = null
  let nativeEmotionActive = false
  let audioLevel = 0
  let audioPeak = 0
  const audioAnalyzer: AudioLevelAnalyzer = {
    getLevel: () => audioLevel,
    getPeak: () => audioPeak,
    isAvailable: () => speaking,
    reset: () => { audioLevel = 0; audioPeak = 0 },
  }

  function pushSoullinkEmotion(emotion: ChatEmotion) {
    if (!soullink) return
    const vad = emotionVAD[emotion]
    if (emotion === 'neutral') {
      nativeEmotionActive = false
      soullinkNativeAnimation = null
      soullink.applyVADTarget(vad, 1)
      return
    }
    nativeEmotionActive = true
    soullink.triggerIntent({
      emotion,
      naturalEmotion: emotion,
      naturalVAD: vad,
      intensity: 0.82,
      contextTags: ['chat'],
    }, elapsedSeconds, { vadTarget: vad })
  }

  function nudge(emotion: ChatEmotion) {
    const preset = emotionVAD[emotion] ?? emotionVAD.neutral
    // 2026-08-16 审计：原 `clamp(0.28 + 0.58 * 1, ...)` 与 `5 + 1 * 18` 是死魔法
    // 常量（与参数无关的恒等式），所有情绪以相同速率/时长安插过渡。改为命名常量
    // 便于后续按情绪/配置差异化（逼近速率已有 soullink targetApproachRate）。
    const amount = NUDGE_TRANSITION_AMOUNT
    target.valence = clamp(target.valence + (preset.valence - target.valence) * amount, -1, 1)
    target.arousal = clamp(target.arousal + (preset.arousal - target.arousal) * amount, -1, 1)
    target.dominance = clamp(target.dominance + (preset.dominance - target.dominance) * amount, -1, 1)
    holdSeconds = Math.max(holdSeconds, NUDGE_HOLD_SECONDS)
    if (emotion !== 'neutral') presentIntensity = 1
  }

  return {
    async activate() {
      if (!config.soullink || soullink) return
      if (soullinkLoading) return soullinkLoading
      soullinkLoading = import('@soullink-emotion/engine').then(({ SoullinkRuntime: Runtime }) => {
        soullink = new Runtime({
          profile: config.soullink!.profile,
          motionStyle: config.soullink!.motionStyle,
          audioLevelAnalyzer: audioAnalyzer,
          personality: { expressiveness: 0.76, softness: 0.82, shyness: 0.72, gazeStability: 0.76 },
          emotionPersonality: {
            reactivity: 0.78,
            targetApproachRate: 1.25,
            decayRate: 0.06,
            emotionHoldSeconds: 5.5,
            ambientDriftStrength: 0.12,
          },
        })
      }).finally(() => { soullinkLoading = null })
      return soullinkLoading
    },
    pushEmotion(emotion: string, options?: PushEmotionOptions) {
      if (emotion === 'neutral') {
        nudge('neutral')
        pushSoullinkEmotion('neutral')
        holdSeconds = 0
        return
      }
      const next = emotion in emotionVAD ? emotion as ChatEmotion : 'neutral'
      last = next
      nudge(next)
      if (options?.holdSeconds !== undefined && options.holdSeconds > 0) {
        holdSeconds = Math.max(holdSeconds, options.holdSeconds)
      } else if (options?.holdTurns !== undefined && options.holdTurns > 0) {
        holdSeconds = Math.max(holdSeconds, options.holdTurns * 12)
      }
      pushSoullinkEmotion(next)
    },
    onUserMessage() {
      reactionActive = true
      reactionElapsed = 0
      soullink?.applyVADDelta({ arousal: 0.12, dominance: -0.04 }, 0.7)
    },
    setSpeaking(value: boolean) {
      speaking = value
      if (!value) audioAnalyzer.reset?.()
      soullink?.setVoicePlaybackActive(value)
    },
    setAudioLevel(level: number, peak = level) {
      audioLevel = clamp(Number(level) || 0, 0, 1)
      audioPeak = clamp(Number(peak) || 0, 0, 1)
    },
    update(deltaSeconds: number) {
      const dt = Math.min(0.12, Math.max(0, deltaSeconds))
      elapsedSeconds += dt
      const approach = 1 - Math.exp(-dt * approachRate)
      holdSeconds = Math.max(0, holdSeconds - dt)
      const decay = holdSeconds > 0 ? 0 : 1 - Math.exp(-dt * decayRate)
      Object.assign(current, lerpVAD(current, target, approach))
      Object.assign(target, lerpVAD(target, baseline, decay))
      presentIntensity = holdSeconds > 0
        ? 1
        : Math.max(0, presentIntensity * Math.exp(-dt * 0.9))
      if (presentIntensity < 0.001) presentIntensity = 0
      if (reactionActive) {
        reactionElapsed += dt
        if (reactionElapsed >= reactionDuration) reactionActive = false
      }
      if (soullink) {
        const frame = soullink.update(elapsedSeconds, dt)
        soullinkTargets = frame.live2dParams
        soullinkNativeAnimation = nativeEmotionActive ? frame.nativeAnimation : null
      }
    },
    targets() {
      const params: Record<string, number> = {}
      const base = emotionParams[last as ChatEmotion] ?? {}
       // Speech should keep the semantic emotion visible. The measured audio
       // layer adds small accents; it must not flatten the face into neutral.
       const emotionWeight = speaking ? 0.82 : 1
      for (const [id, value] of Object.entries(base)) {
        const scaled = clamp(value * presentIntensity * emotionWeight, -1, 1)
        if (scaled !== 0) params[id] = scaled
      }
      if (reactionActive) {
        const pulse = Math.sin(Math.min(1, reactionElapsed / reactionDuration) * Math.PI)
        for (const [id, value] of Object.entries(reactionParams)) {
          const merged = clamp((params[id] ?? 0) + value * pulse, -1, 1)
          if (merged !== 0) params[id] = merged
        }
      }
      return params
    },
    performanceTargets() {
      return { ...soullinkTargets }
    },
    performanceFrame() {
      return {
        live2dParams: { ...soullinkTargets },
        nativeAnimation: soullinkNativeAnimation,
      }
    },
    intensity() {
      return presentIntensity
    },
    lastEmotion() {
      return last
    },
    reset() {
      Object.assign(current, baseline)
      Object.assign(target, baseline)
      holdSeconds = 0
      last = 'neutral'
      speaking = false
      presentIntensity = 0
      reactionActive = false
      reactionElapsed = 0
      soullinkTargets = {}
      soullinkNativeAnimation = null
      nativeEmotionActive = false
      soullink?.reset(elapsedSeconds)
    },
  }
}
