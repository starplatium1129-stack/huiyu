/** Existing particle-only slow-frame fallback, with bounded hysteresis and recovery. */
export function createParticleQuality() {
  let scale = 1, slowFrames = 0, stableMs = 0, cooldownMs = 0
  function resetHistory() { slowFrames = 0; stableMs = 0; cooldownMs = 0 }
  return {
    get scale() { return scale },
    resetHistory,
    frame(elapsed: number): boolean {
      // Hidden/suspended time is not a rendering-load sample.
      if (!Number.isFinite(elapsed) || elapsed <= 0 || elapsed > 250) { resetHistory(); return false }
      cooldownMs = Math.max(0, cooldownMs - elapsed)
      slowFrames = elapsed > 28 ? slowFrames + 1 : Math.max(0, slowFrames - 2)
      stableMs = elapsed < 20 ? stableMs + elapsed : 0
      if (slowFrames >= 20 && scale > .48 && cooldownMs === 0) {
        scale = Math.max(.48, scale * .7)
        slowFrames = 0; stableMs = 0; cooldownMs = 2000
        return true
      }
      if (stableMs >= 5000 && scale < 1 && cooldownMs === 0) {
        scale = Math.min(1, scale / .7)
        slowFrames = 0; stableMs = 0; cooldownMs = 5000
        return true
      }
      return false
    },
  }
}
