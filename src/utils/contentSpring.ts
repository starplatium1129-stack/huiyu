import { FluidSpring } from './fluidSpring'
import { SURFACE_DAMPING, SURFACE_FREQUENCY } from './controlSprings'
import { prefersReducedMotion } from './motionPreference'

export type SpringPresentation = { values: number[]; velocities: number[] }
export type ContentSpring = ReturnType<typeof createContentSpring>

/** Reading surfaces share the small-overlay spring, without scaling text. Sample
 * once for the compositor; capture both position and velocity before DOM remaps. */
export function createContentSpring(
  element: HTMLElement, initial: number[], frame: (values: number[]) => Keyframe,
  options: { velocities?: number[]; opacity?: number; frequency?: number; damping?: number } = {},
) {
  const springs = initial.map((value, index) => {
    const alpha = index === options.opacity
    const spring = new FluidSpring(value, options.frequency ?? (alpha ? 8 : SURFACE_FREQUENCY), options.damping ?? (alpha ? 1 : SURFACE_DAMPING))
    spring.velocity = options.velocities?.[index] ?? 0
    return spring
  })
  let effect: Animation | undefined, origin: SpringPresentation
  let samples: number[][] = []
  let done: (() => void) | undefined
  let revision = 0
  const snapshot = (): SpringPresentation => ({ values: springs.map(s => s.value), velocities: springs.map(s => s.velocity) })
  const capture = () => {
    if (effect) springs.forEach((spring, index) => {
      spring.value = origin.values[index]; spring.velocity = origin.velocities[index]
      const seconds = Math.max(0, Number(effect!.currentTime) || 0) / 1000
      spring.step(seconds)
      // Native keyframes interpolate samples linearly. Adopt that exact pose,
      // keeping the analytic velocity, even for a large interrupted card move.
      const cursor = Math.min(seconds * 60, samples.length - 1), frame = Math.floor(cursor)
      const value = samples[frame][index] + ((samples[frame + 1]?.[index] ?? samples[frame][index]) - samples[frame][index]) * (cursor - frame)
      spring.value = index === options.opacity ? Math.max(0, Math.min(1, value)) : value
    })
    return snapshot()
  }
  const cancel = () => { revision++; done = undefined; effect?.cancel(); effect = undefined }
  const finish = () => {
    const callback = done
    cancel(); springs.forEach(spring => spring.snap()); callback?.()
  }
  return {
    capture, cancel, finish,
    to(targets: number[], complete?: () => void) {
      capture(); cancel(); done = complete
      springs.forEach((spring, index) => spring.to(targets[index]))
      if (document.hidden || prefersReducedMotion() || typeof element.animate !== 'function') { finish(); return }
      origin = snapshot()
      const copies = springs.map(spring => {
        const copy = new FluidSpring(spring.value, spring.frequency, spring.damping)
        copy.velocity = spring.velocity; copy.to(spring.target)
        return copy
      })
      samples = [origin.values]
      for (let index = 0; index < 90 && copies.some(spring => !spring.settled); index++) {
        samples.push(copies.map(spring => spring.step(1 / 60)))
      }
      const frames = samples.map(frame)
      const token = revision
      try {
        effect = element.animate(frames, { duration: Math.max(1, (frames.length - 1) * 1000 / 60), fill: 'both', easing: 'linear' })
        void effect.finished.then(() => { if (token === revision) finish() }, () => { if (token === revision) finish() })
      } catch { finish() }
    },
  }
}
