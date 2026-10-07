import type { PromptPlan } from '../types/prompt'
import { LIGHTING, SHOT } from '../config/promptConstants.ts'
import { cameraPhrase, animaLightPhrase, normalizeProseKey } from './promptPhraseTables.ts'
import { hasVariableCamera, hasVariableLight, renderRandomVariationProse } from './randomVariationProse.ts'

/** Retain authored relationships while applying the current director controls. */
export function authoredAnimaCaption(plan: PromptPlan, caption: string): string {
  const shot = SHOT.find(option => plan.camera.some(token => normalizeProseKey(token) === normalizeProseKey(option.prompt || '')))
  const light = LIGHTING.find(option => plan.lighting.some(token => normalizeProseKey(token) === normalizeProseKey(option.prompt || '')))
  const parts = [renderRandomVariationProse(caption, shot?.id ?? null, light?.id ?? null)]
  // Replace known phrases in place; append only when the authored caption has no such direction.
  if (shot?.prompt && !hasVariableCamera(caption)) parts.push(`Frame it with ${cameraPhrase(shot.prompt)}`)
  if (light?.prompt && !hasVariableLight(caption)) parts.push(`Light it with ${animaLightPhrase(light.prompt)}`)
  const visual = plan.visualDescription.trim()
  // Random variations can already use this exact description as their caption.
  if (visual && normalizeProseKey(visual) !== normalizeProseKey(caption)) parts.push(visual)
  return parts.map(part => `${part.replace(/[.!?]+$/, '')}.`).join(' ')
}
