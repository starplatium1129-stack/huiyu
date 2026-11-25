/** The waiting stardust cloud and image texture particles share this continuous gathering field. */
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
  const formed = smoothGenerationPhase(.06, .72, progress), finishing = smoothGenerationPhase(.68, .99, progress)
  const radius = Math.min(width * .34, height * .38, 136) * (1 - formed * .14 - finishing * .28)
  return { radius, formed, finishing, time, rotation }
}
export function smoothGenerationPhase(start: number, end: number, value: number) {
  const t = Math.max(0, Math.min(1, (value - start) / (end - start)))
  return t * t * (3 - 2 * t)
}
export function generationOrbitPoint(angle: number, _band: number, pose: GenerationOrbitPose, radial = .65, phase = 0) {
  const { radius, finishing, time } = pose
  const r = radius * (.14 + radial * .92)
  const aspectX = 1.14 - finishing * .12
  const aspectY = .84 + finishing * .1
  const flutter = (3.2 + radial * 5.2) * (1 - finishing * .45)
  const swirl = angle + radial * 1.15
  return {
    x: Math.cos(swirl) * r * aspectX + Math.sin(time * .75 + phase + radial * 3) * flutter,
    y: Math.sin(swirl) * r * aspectY + Math.cos(time * .58 + phase * 1.3 - radial * 2.4) * flutter,
  }
}
