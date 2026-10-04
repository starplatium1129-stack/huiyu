import { LIGHTING, SHOT } from '../config/promptConstants.ts'

// Known photographic phrases only. Looking back/selfie describe actions/props.
// A lantern alone names a prop; only its explicit light is replaceable.
const camera = /\b(?:extreme[ _-]close[ _-]up|close[ _-]up|medium[ _-]shot|wide[ _-]shot|full[ _-]body|waist[ _-]up|low[ _-]angle|high[ _-]angle|side[ _-]view)\b/gi
const light = /\b(?:golden[ _-]hour|window[ _-]light|backlighting|moonlight|(?:lantern|warm)[ _-]light(?:ing)?|overcast)\b/gi

export function hasVariableCamera(prose: string): boolean { return new RegExp(camera).test(prose) }
export function hasVariableLight(prose: string): boolean { return new RegExp(light).test(prose) }

/** Re-evaluate against current controls, including manual edits after a roll. */
export function renderRandomVariationProse(prose: string, shot: string | null, lighting: string | null): string {
  const shotText = SHOT.find(option => option.id === shot)?.prompt
  const lightText = LIGHTING.find(option => option.id === lighting)?.prompt
  let result = shotText ? prose.replace(camera, shotText) : prose
  if (lightText) result = result.replace(light, lightText)
  return result
}
