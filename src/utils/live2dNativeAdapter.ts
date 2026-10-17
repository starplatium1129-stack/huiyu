import type { NativeAnimationDirective, NativeMotionPriority } from '@soullink-emotion/engine'

export interface NativeAnimationModel {
  motion?(group: string, index: number, priority?: number): Promise<boolean> | boolean
  expression?(name: string): Promise<boolean> | boolean
}

interface VerifiedNativeMotion {
  group: string
  index: number
  priority: NativeMotionPriority
  maxDurationMs: number
  suppressParamIds: readonly string[]
}

interface NativeAnimationPolicy {
  expressions: readonly string[]
  motions: readonly VerifiedNativeMotion[]
}

export type NativeAnimationPolicies = Readonly<Record<string, NativeAnimationPolicy>>

// Nene's expression1-5 are outfits, and Natsume has no Expressions. Existing
// Tap/Idle/Start/Leave motions are interaction or lifecycle assets, not verified
// emotion motions, so both emotion allowlists intentionally start empty.
const LIVE2D_NATIVE_POLICIES: NativeAnimationPolicies = {
  nene: { expressions: [], motions: [] },
  natsume: { expressions: [], motions: [] },
}

const PRIORITIES: Record<NativeMotionPriority, number> = {
  idle: 1,
  normal: 2,
  force: 3,
}

export function createLive2dNativeAdapter(policies: NativeAnimationPolicies = LIVE2D_NATIVE_POLICIES) {
  let lastToken = -1
  let generation = 0
  let releaseTimer: ReturnType<typeof globalThis.setTimeout> | null = null
  let suppressed = new Set<string>()

  function clearActive() {
    if (releaseTimer !== null) clearTimeout(releaseTimer)
    releaseTimer = null
    suppressed = new Set()
  }

  function reset() {
    generation += 1
    lastToken = -1
    clearActive()
  }

  async function apply(
    directive: NativeAnimationDirective | null,
    model: NativeAnimationModel,
    character: string,
  ): Promise<boolean> {
    if (!directive) {
      clearActive()
      return false
    }
    if (directive.token === lastToken) return false
    lastToken = directive.token
    clearActive()

    const policy = policies[character]
    if (!policy) return false
    if (directive.expression && !policy.expressions.includes(directive.expression)) return false

    const motion = directive.motion
    if (motion && typeof motion.index !== 'number') return false
    const verifiedMotion = motion
      ? policy.motions.find(item => item.group === motion.group && item.index === motion.index)
      : null
    if (motion && !verifiedMotion) return false
    if (!directive.expression && !verifiedMotion) return false

    const requestGeneration = generation
    try {
      if (directive.expression) {
        if (typeof model.expression !== 'function') return false
        if (await Promise.resolve(model.expression(directive.expression)) !== true) return false
      }
      if (verifiedMotion) {
        if (typeof model.motion !== 'function') return false
        const priority = PRIORITIES[verifiedMotion.priority]
        const started = await Promise.resolve(model.motion(verifiedMotion.group, verifiedMotion.index, priority))
        if (started !== true || requestGeneration !== generation) return false
        suppressed = new Set(verifiedMotion.suppressParamIds)
        releaseTimer = globalThis.setTimeout(clearActive, verifiedMotion.maxDurationMs)
      }
      return requestGeneration === generation
    } catch {
      clearActive()
      return false
    }
  }

  return {
    apply,
    activeSuppressedParamIds: (): ReadonlySet<string> => suppressed,
    reset,
  }
}
