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

/** One frame loop per surface; hidden/reduced motion settles, disposal is terminal. */
export function createFluidMotion(values: number[], write: (values: number[]) => void, frequency = 5) {
  const springs = values.map(value => new FluidSpring(value, frequency))
  const media = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
  let frame: number | null = null, last: number | null = null
  let active = false, disposed = false, revision = 0
  let complete: (() => void) | undefined
  const render = () => write(springs.map(spring => spring.value))
  function stop() {
    if (frame !== null) cancelAnimationFrame(frame)
    frame = null; last = null
  }
  function finish() {
    if (disposed || !active) return
    stop(); active = false
    springs.forEach(spring => spring.snap())
    const done = complete; complete = undefined
    render(); done?.()
  }
  function schedule() {
    if (disposed || !active || frame !== null) return
    try { frame = requestAnimationFrame(tick) } catch { finish() }
  }
  function tick(now: number) {
    frame = null
    if (disposed || !active) return
    const current = revision
    const dt = last === null ? 1 / 60 : Math.max(0, (now - last) / 1000)
    last = now
    springs.forEach(spring => spring.step(dt)); render()
    // A write callback may dispose or retarget the surface synchronously.
    if (disposed || !active || revision !== current) return
    if (springs.every(spring => spring.settled)) finish()
    else schedule()
  }
  function preference() { if (prefersReducedMotion() || document.hidden) finish() }
  const modern = typeof media?.addEventListener === 'function'
  if (modern) media?.addEventListener('change', preference)
  else media?.addListener?.(preference)
  document.addEventListener('visibilitychange', preference)
  window.addEventListener('atelier:motion-preference', preference)
  return {
    to(targets: number[], instant = false, done?: () => void) {
      if (disposed) return
      const superseded = complete
      complete = undefined
      if (instant) superseded?.()
      revision++; active = true; complete = done
      springs.forEach((spring, index) => spring.to(targets[index]))
      if (instant || prefersReducedMotion() || document.hidden || typeof requestAnimationFrame !== 'function') finish()
      else { render(); schedule() }
    },
    settle: finish,
    dispose() {
      if (disposed) return
      disposed = true; active = false; revision++
      stop(); complete = undefined
      if (modern) media?.removeEventListener('change', preference)
      else media?.removeListener?.(preference)
      document.removeEventListener('visibilitychange', preference)
      window.removeEventListener('atelier:motion-preference', preference)
    },
  }
}
