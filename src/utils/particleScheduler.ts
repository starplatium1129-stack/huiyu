type ParticleFrame = (now: number) => void
interface ScheduledParticle { frame: ParticleFrame; interval: number; nextAt: number }

const particles = new Map<number, ScheduledParticle>()
let nextId = 0
let rafId: number | null = null
let visibilityBound = false

function schedule(): void {
  if (rafId !== null || !particles.size || (typeof document !== 'undefined' && document.hidden)) return
  rafId = requestAnimationFrame(tick)
}
function visibility(): void {
  if (document.hidden) {
    if (rafId !== null) cancelAnimationFrame(rafId)
    rafId = null
  } else {
    // Resume from now; do not replay deadlines accumulated while hidden.
    for (const item of particles.values()) item.nextAt = 0
    schedule()
  }
}
function tick(now: number): void {
  rafId = null
  if (document.hidden) return
  // Registration/removal during a callback belongs to the next frame.
  for (const [id, item] of [...particles]) {
    if (particles.get(id) !== item) continue
    if (item.interval && now + 0.5 < item.nextAt) continue
    if (item.interval) {
      item.nextAt = item.nextAt ? item.nextAt + item.interval : now + item.interval
      if (item.nextAt < now - item.interval) item.nextAt = now + item.interval
    }
    item.frame(now)
  }
  schedule()
}
/** One RAF drives every particle canvas; throttled layers skip frames. */
export function registerParticleFrame(frame: ParticleFrame, fps = 30): () => void {
  if (!visibilityBound && typeof document !== 'undefined') {
    visibilityBound = true
    document.addEventListener('visibilitychange', visibility)
  }
  const id = ++nextId
  const interval = fps <= 0 ? 0 : 1000 / Math.max(12, fps)
  particles.set(id, { frame, interval, nextAt: 0 })
  schedule()
  return () => {
    particles.delete(id)
    if (particles.size) return
    if (rafId !== null) cancelAnimationFrame(rafId)
    rafId = null
    if (visibilityBound) document.removeEventListener('visibilitychange', visibility)
    visibilityBound = false
  }
}
