import { ref } from 'vue'
export interface CandidatePose { scale: number; x: number; y: number }
export interface CandidateFit { width: number; height: number }
export const initialCandidatePose = (): CandidatePose => ({ scale: 1, x: 0, y: 0 })
export function clampCandidatePose(pose: CandidatePose, fit: CandidateFit = { width: 1, height: 1 }): CandidatePose {
  const scale = Math.min(4, Math.max(1, pose.scale))
  const x = Math.max(0, (fit.width * scale - 1) / 2), y = Math.max(0, (fit.height * scale - 1) / 2)
  return { scale, x: Math.min(x, Math.max(-x, pose.x)), y: Math.min(y, Math.max(-y, pose.y)) }
}
export function useCandidateViewport() {
  const synchronized = ref(true)
  let shared = initialCandidatePose()
  const poses = new Map<string, CandidatePose>(), renderers = new Map<string, (pose: CandidatePose) => void>()
  const poseFor = (id: string | number) => ({ ...(synchronized.value ? shared : poses.get(String(id)) || initialCandidatePose()) })
  function notify() { for (const [id, render] of renderers) render(poseFor(id)) }
  function bind(id: string | number, render: (pose: CandidatePose) => void) {
    const key = String(id)
    renderers.set(key, render); render(poseFor(id))
    return () => { if (renderers.get(key) === render) renderers.delete(key) }
  }
  function update(id: string | number, pose: CandidatePose) {
    const next = clampCandidatePose(pose)
    // Continuous viewing state belongs to the four image DOM owners, not the card tree.
    if (synchronized.value) { shared = next; notify() }
    else { poses.set(String(id), next); renderers.get(String(id))?.(next) }
  }
  function toggleSync(ids: readonly (string | number)[]) {
    if (synchronized.value) for (const id of ids) poses.set(String(id), { ...shared })
    else shared = poseFor(ids[0] ?? '')
    synchronized.value = !synchronized.value
    notify()
  }
  function reset() {
    shared = initialCandidatePose(); poses.clear(); notify()
  }
  return { synchronized, poseFor, update, toggleSync, reset, bind }
}
export type CandidateViewportState = ReturnType<typeof useCandidateViewport>
