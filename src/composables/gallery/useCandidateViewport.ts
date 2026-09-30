import { reactive, ref } from 'vue'
export interface CandidatePose { scale: number; x: number; y: number }
export const initialCandidatePose = (): CandidatePose => ({ scale: 1, x: 0, y: 0 })
export function clampCandidatePose(pose: CandidatePose): CandidatePose {
  const scale = Math.min(4, Math.max(1, pose.scale))
  const bound = (scale - 1) / 2
  return { scale, x: Math.min(bound, Math.max(-bound, pose.x)), y: Math.min(bound, Math.max(-bound, pose.y)) }
}
export function useCandidateViewport() {
  const synchronized = ref(true), shared = ref(initialCandidatePose())
  const poses = reactive<Record<string, CandidatePose>>({})
  const poseFor = (id: string | number) => synchronized.value ? shared.value : poses[String(id)] || initialCandidatePose()
  function update(id: string | number, pose: CandidatePose) {
    const next = clampCandidatePose(pose)
    if (synchronized.value) shared.value = next
    else poses[String(id)] = next
  }
  function toggleSync(ids: readonly (string | number)[]) {
    if (synchronized.value) for (const id of ids) poses[String(id)] = { ...shared.value }
    else shared.value = { ...poseFor(ids[0] ?? '') }
    synchronized.value = !synchronized.value
  }
  function reset() {
    shared.value = initialCandidatePose()
    for (const id of Object.keys(poses)) delete poses[id]
  }
  return { synchronized, poseFor, update, toggleSync, reset }
}
