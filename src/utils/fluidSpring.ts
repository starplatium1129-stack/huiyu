import { cancelFrame, frame, spring, type FrameData } from 'motion'
import { listenMotionChanges, prefersReducedMotion } from './motionPreference'

/** Adapt Motion's generator to the mutable presentation captured by WAAPI owners. */
export class FluidSpring {
  velocity = 0
  target: number
  private trajectory?: { generator: ReturnType<typeof spring>; elapsed: number; value: number; velocity: number; target: number }
  constructor(public value: number, readonly frequency = 5, readonly damping = 1) { this.target = value }
  to(target: number) { this.target = target }
  snap(target = this.target) { this.value = this.target = target; this.velocity = 0; this.trajectory = undefined }
  step(seconds: number) {
    if (this.settled) return this.value
    let trajectory = this.trajectory
    if (!trajectory || trajectory.value !== this.value || trajectory.velocity !== this.velocity || trajectory.target !== this.target) {
      const frequency = 2 * Math.PI * this.frequency
      trajectory = this.trajectory = {
        generator: spring({ keyframes: [this.value, this.target], velocity: this.velocity,
          stiffness: frequency ** 2, damping: 2 * this.damping * frequency, mass: 1, restDelta: .001, restSpeed: .01 }),
        elapsed: 0, value: this.value, velocity: this.velocity, target: this.target,
      }
    }
    trajectory.elapsed += Math.max(0, seconds) * 1000
    const sample = trajectory.generator.next(trajectory.elapsed)
    this.value = trajectory.value = sample.value
    this.velocity = trajectory.velocity = trajectory.generator.velocity?.(trajectory.elapsed) ?? 0
    if (sample.done) this.snap()
    return this.value
  }
  get settled() { return this.value === this.target && this.velocity === 0 }
}

/** Use Motion's shared frame loop; hidden/reduced motion settles, disposal is terminal. */
export function createFluidMotion(values: number[], write: (values: number[]) => void, frequency = 5, damping = 1) {
  const springs = values.map(value => new FluidSpring(value, frequency, damping))
  let scheduled = false, last: number | null = null
  let active = false, disposed = false, revision = 0
  let complete: (() => void) | undefined
  const render = () => write(springs.map(spring => spring.value))
  function stop() {
    cancelFrame(tick)
    scheduled = false; last = null
  }
  function finish() {
    if (disposed || !active) return
    stop(); active = false
    springs.forEach(spring => spring.snap())
    const done = complete; complete = undefined
    render(); done?.()
  }
  function schedule() {
    if (disposed || !active || scheduled) return
    scheduled = true
    frame.update(tick, true)
  }
  function tick({ timestamp: now }: FrameData) {
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
  const stopListening = listenMotionChanges(preference)
  return {
    to(targets: number[], instant = false, done?: () => void) {
      if (disposed) return
      // Superseding a motion is cancellation, not completion. Its callback may
      // remove this surface or start another motion, even when this one snaps.
      complete = undefined
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
      stopListening()
    },
  }
}
