import { SoullinkRuntime, deriveNeutralParams, deriveParameterSmoothing, type FACSKey, type ModelProfile, type PartialFACSLikeState, type SoullinkExternalPlan } from '@soullink-emotion/engine'
import type { AnimePose } from './types'
import { ANIME_EXPRESSIONS, ANIME_MOTIONS } from './capabilities'

const clamp = (n: number, min = -1, max = 1) => Math.max(min, Math.min(max, n))
const follow = (from: number, to: number, rate: number, dt: number) => from + (to - from) * (1 - Math.exp(-rate * dt))
const supported: FACSKey[] = ['headX', 'headY', 'headZ', 'bodyX', 'bodyZ', 'gazeX', 'gazeY',
  'eyeOpen', 'eyeBlinkL', 'eyeBlinkR', 'eyeSmile', 'eyeSquint', 'browInnerUp', 'browOuterUp', 'browDown', 'mouthSmile', 'mouthFrown', 'breath']
const faces: Record<string, PartialFACSLikeState> = {
  happy: { eyeOpen: .85, eyeSmile: .55, mouthSmile: .65, browOuterUp: .18 },
  gentle: { eyeOpen: .90, eyeSmile: .22, mouthSmile: .35, browInnerUp: .10 },
  shy: { eyeOpen: .83, eyeSmile: .18, mouthSmile: .30, gazeY: .12, headZ: .12 },
  sad: { eyeOpen: .75, browInnerUp: .42, mouthFrown: .38, headY: -.12 },
  serious: { eyeOpen: .91, browDown: .38, eyeSquint: .18 },
}
const actionBeats: Record<string, NonNullable<SoullinkExternalPlan['actionPlan']>> = {
  nod: [
    { time: 0, duration: .32, label: 'nod-down', intensity: .75, facs: { headY: -.30 } },
    { time: .32, duration: .55, label: 'nod-return', intensity: .65, facs: { headY: .16 } },
  ],
  'look-around': [
    { time: 0, duration: .70, label: 'look-left', intensity: .7, facs: { gazeX: -.50, headX: -.24 } },
    { time: .72, duration: .85, label: 'look-right', intensity: .7, facs: { gazeX: .45, headX: .24 } },
  ],
  headpat: [{ time: 0, duration: 1.5, label: 'headpat', intensity: 1,
    facs: { eyeBlinkL: 1, eyeBlinkR: 1, eyeSmile: .7, mouthSmile: .65, headY: -.15, headZ: .16 } }],
}

/** Reuse the installed performance engine, then adapt FACS to the PSD mesh.
 * Tracking is additive to emotion; authored reactions temporarily own attention.
 * Only this adapter advances its engine, on the stage's existing visible clock. */
export function createAnimePerformance(modelPath: string) {
  const profile: ModelProfile = {
    modelId: 'anime25d', displayName: '2.5D 桌宠', version: '1', schemaVersion: 2, modelPath,
    parameterMap: Object.fromEntries(supported.map(key => [key, { target: key }])),
    idleConfig: { gazeX: [-.16, .16], gazeY: [-.08, .08], headX: [-.09, .09],
      headY: [-.06, .06], headZ: [-.08, .08], bodyX: [-.05, .05] },
  }
  profile.neutralParams = deriveNeutralParams(profile)
  profile.parameterSmoothing = { ...deriveParameterSmoothing(profile), eyeOpen: 10, eyeSmile: 8,
    browInnerUp: 9, browOuterUp: 9, browDown: 9, mouthSmile: 10, mouthFrown: 10 }
  let speaking = false, audio = 0, peak = 0, manual = '', emotion = 'neutral'
  let clock = 0, actionUntil = 0, wasReduced = false
  const engine = new SoullinkRuntime({
    profile, motionStyle: { spontaneity: .50, gestureFrequency: .65, gazeStability: .80,
      blinkRate: .9, breathRate: .86, breathVariance: .25, microMotionGain: .55,
      idleActionGain: .65, avoidRepeatWindow: 5, speechAccentGain: .28 },
    personality: { expressiveness: .75, softness: .82, shyness: .45, gazeStability: .80 },
    audioLevelAnalyzer: { getLevel: () => audio, getPeak: () => peak, isAvailable: () => speaking },
  })
  // The host owns actual speech mouth samples. Never invent speech from an idle clock.
  engine.setLipSyncEnabled(false)
  engine.setProactiveRepeatEnabled(false)
  engine.setParameterGain(1)
  engine.setBodyMotionGain(.85)
  const state = { eyeX: 0, eyeY: 0, headX: 0, headY: 0, headZ: 0, body: 0, mouth: 0, breathHead: 0 }
  function applyExpression() { engine.setManualFACS(manual ? faces[manual] : {}) }
  function setEmotion(value: string) {
    const next = value in faces ? value : 'neutral'
    if (next === emotion) return
    emotion = next
    engine.triggerIntent({ emotion, intensity: .65, contextTags: ['chat'] }, clock)
    applyExpression()
  }
  return {
    setEmotion,
    setExpression(id: string) {
      if (id && !ANIME_EXPRESSIONS.some(item => item.id === id)) return false
      manual = id.replace('emotion:', '')
      actionUntil = 0
      applyExpression()
      return true
    },
    playMotion(id: string) {
      if (!ANIME_MOTIONS.some(item => item.id === id)) return
      actionUntil = clock + (id === 'nod' ? 1.25 : 2)
      engine.triggerIntent({ emotion: id === 'headpat' ? 'happy' : emotion, intensity: .6,
        contextTags: ['interaction'] }, clock, { actionPlan: actionBeats[id] })
      engine.clearManualFACS()
    },
    setSpeaking(value: boolean) { speaking = value; engine.setVoicePlaybackActive(value); if (!value) { audio = 0; peak = 0 } },
    setAudioLevel(level: number, nextPeak = level) { audio = clamp(level, 0, 1); peak = clamp(nextPeak, 0, 1) },
    sample(input: { time: number; dt: number; mouth: number; gazeX: number; gazeY: number; attention: number; reduced: boolean; presence: string }): AnimePose {
      clock = input.time
      if (actionUntil > 0 && clock >= actionUntil) { actionUntil = 0; applyExpression() }
      if (input.reduced !== wasReduced) { engine.setIdleEnabled(!input.reduced); wasReduced = input.reduced }
      const frame = engine.update(clock, input.dt)
      const f = frame.live2dParams
      const dt = input.dt, reduced = input.reduced
      const quiet = input.presence === 'quiet' ? .35 : 1
      const attention = clock < actionUntil ? 0 : input.attention
      const gx = clamp(input.gazeX * attention * .75 + f.gazeX * (1 - attention * .65))
      const gy = clamp(input.gazeY * attention * .60 + f.gazeY * (1 - attention * .65) - (input.presence === 'thinking' ? .12 : 0))
      // Eye saccades settle first; the head follows, then the torso. Separate time
      // constants keep a moving mouse responsive without moving the whole model at once.
      state.eyeX = follow(state.eyeX, gx, 22, dt); state.eyeY = follow(state.eyeY, gy, 22, dt)
      state.headX = follow(state.headX, gx * .46 + f.headX * .65, 4.8, dt)
      const listeningTilt = input.presence === 'listening' || input.presence === 'attentive' ? .07 : 0
      state.headY = follow(state.headY, -gy * .33 + f.headY * .65, 4.5, dt)
      state.headZ = follow(state.headZ, -gx * .10 + f.headZ * .65 + listeningTilt, 3.6, dt)
      state.body = follow(state.body, state.headX * .30 + f.bodyX * .55 + f.bodyZ * .30, 1.7, dt)
      state.mouth = follow(state.mouth, input.mouth, input.mouth > state.mouth ? 28 : 16, dt)
      state.breathHead = follow(state.breathHead, f.breath, 3, dt)
      const eye = clamp(f.eyeOpen - f.eyeSmile * .25 - f.eyeSquint * .15, 0, 1.12)
      return {
        angleX: reduced ? 0 : clamp(state.headX * quiet, -.6, .6),
        angleY: reduced ? 0 : clamp(state.headY * quiet, -.45, .45),
        angleZ: reduced ? 0 : clamp(state.headZ * quiet, -.35, .35),
        body: reduced ? 0 : clamp(state.body * quiet, -.3, .3),
        eyeX: reduced ? 0 : state.eyeX, eyeY: reduced ? 0 : state.eyeY,
        // Keep blink timing intact; expression smoothing must not shorten a blink.
        eyeOpenL: eye * (reduced ? 1 : 1 - frame.facs.eyeBlinkL), eyeOpenR: eye * (reduced ? 1 : 1 - frame.facs.eyeBlinkR),
        brow: clamp(f.browInnerUp * .65 + f.browOuterUp * .35 - f.browDown * .45),
        browAngSym: clamp(f.browDown * .40 - f.browInnerUp * .25),
        mouthOpen: clamp(state.mouth, 0, 1), mouthForm: clamp(f.mouthSmile - f.mouthFrown),
        breath: reduced ? 0 : f.breath * quiet,
        breathHead: reduced ? 0 : state.breathHead * quiet,
      }
    },
  }
}

export type AnimePerformance = ReturnType<typeof createAnimePerformance>
