import { SHOT } from '../config/promptConstants.ts'
import { hasCameraPhrase, renderCameraProse } from './promptCamera.ts'
import { hasVariableLighting, renderLightingProse } from './promptLighting.ts'

export const hasVariableCamera = hasCameraPhrase
export const hasVariableLight = hasVariableLighting

/** Re-evaluate against current controls, including manual edits after a roll. */
export function renderRandomVariationProse(prose: string, shot: string | null, lighting: string | null, sourceLighting: string | null): string {
  const shotText = SHOT.find(option => option.id === shot)?.prompt
  const result = shotText ? renderCameraProse(prose, [shotText]) : prose
  return renderLightingProse(result, sourceLighting, lighting)
}
