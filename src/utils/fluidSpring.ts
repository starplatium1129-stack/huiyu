import { prefersReducedMotion } from './motionPreference'

/** Analytic, critically damped motion. Retargeting preserves position and velocity. */
export class FluidSpring {
  velocity = 0
  target: number
  constructor(public value: number, readonly frequency = 5) { this.target = value }
  to(target: number) { this.target = target }
  snap(target = this.target) { this.value = this.target = target; this.velocity = 0 }
  step(seconds: number) {
    const w = 2 * Math.PI * this.frequency
    const displacement = this.value - this.target
    const c = this.velocity + w * displacement
    const decay = Math.exp(-w * seconds)
    this.value = this.target + (displacement + c * seconds) * decay
    this.velocity = (this.velocity - w * c * seconds) * decay
    if (Math.abs(this.value - this.target) < .001 && Math.abs(this.velocity) < .01) this.snap()
    return this.value
  }
  get settled() { return this.value === this.target && this.velocity === 0 }
}

/** One frame loop per surface, asleep at rest; reduced motion takes effect mid-flight. */
export function createFluidMotion(values: number[], write: (values: number[]) => void, frequency = 5) {
  const springs = values.map(value => new FluidSpring(value, frequency))
  const media = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null
  let removeMediaListener: (() => void) | undefined
  let frame = 0, last = 0
  let complete: (() => void) | undefined
  const render = () => write(springs.map(spring => spring.value))
  function stop() { cancelAnimationFrame(frame); frame = 0; last = 0 }
  function finish() {
    stop(); springs.forEach(spring => spring.snap()); render()
    const done = complete; complete = undefined; done?.()
  }
  function tick(now: number) {
    if (typeof document !== 'undefined' && document.hidden) {
      finish()
      return
    }
    const dt = last ? (now - last) / 1000 : 1 / 60; last = now
    springs.forEach(spring => spring.step(dt)); render()
    if (springs.every(spring => spring.settled)) finish()
    else frame = requestAnimationFrame(tick)
  }
  function preference() { if (prefersReducedMotion() || (typeof document !== 'undefined' && document.hidden)) finish() }
  if (media) {
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', preference)
      removeMediaListener = () => media.removeEventListener('change', preference)
    } else if (typeof media.addListener === 'function') {
      media.addListener(preference)
      removeMediaListener = () => media.removeListener(preference)
    }
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', preference)
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('atelier:motion-preference', preference)
  }
  return {
    to(targets: number[], instant = false, done?: () => void) {
      complete = done
      springs.forEach((spring, index) => spring.to(targets[index]))
      if (instant || prefersReducedMotion() || (typeof document !== 'undefined' && document.hidden)) finish()
      else { render(); if (!frame) frame = requestAnimationFrame(tick) }
    },
    dispose() {
      stop(); complete = undefined
      removeMediaListener?.()
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', preference)
      }
      if (typeof window !== 'undefined') {
        window.removeEventListener('atelier:motion-preference', preference)
      }
    },
  }
}
