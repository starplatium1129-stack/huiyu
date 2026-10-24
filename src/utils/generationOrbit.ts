/** The waiting canvas and image particles meet on this same continuous orbit. */
export interface GenerationOrbitPose {
  radius: number
  formed: number
  finishing: number
  time: number
  rotation: number
}
export interface GenerationOrbitSurface {
  snapshot: () => GenerationOrbitPose
  setOpacity: (opacity: number) => void
}
export function generationOrbitPose(width: number, height: number, progress: number, time: number, rotation: number): GenerationOrbitPose {
  const formed = smoothGenerationPhase(.08, .66, progress), finishing = smoothGenerationPhase(.65, .98, progress)
  return { radius: generationOrbitRadius(width, height, formed, finishing), formed, finishing, time, rotation }
}
export function generationOrbitRadius(width: number, height: number, formed: number, finishing: number) {
  return Math.min(width * .29, height * .3, 116) * (1 - formed * .1 - finishing * .28)
}
export function smoothGenerationPhase(start: number, end: number, value: number) {
  const t = Math.max(0, Math.min(1, (value - start) / (end - start)))
  return t * t * (3 - 2 * t)
}
export function generationOrbitPoint(angle: number, band: number, pose: GenerationOrbitPose) {
  const { radius, formed, finishing, time } = pose
  const tilt = (-.64 + band * .61) * (1 - finishing * .75) + Math.sin(time * .17 + band) * .075 * (1 - finishing)
  const x = Math.cos(angle) * radius * (.86 + band * .08)
  const y = Math.sin(angle) * radius * (.86 + band * .08) * (.31 + band * .035 + formed * .1 - finishing * .2)
    + Math.sin(angle * 2 + time * .12) * 2.5 * (1 - finishing)
  return { x: x * Math.cos(tilt) - y * Math.sin(tilt), y: x * Math.sin(tilt) + y * Math.cos(tilt) }
}
