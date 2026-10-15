import type { PromptPlan } from '../types/prompt'
import { LIGHTING } from '../config/promptConstants.ts'
import { normalizeProseKey } from './promptPhraseTables.ts'
import { renderRandomVariationProse } from './randomVariationProse.ts'
import { renderCameraProse } from './promptCamera.ts'
import { inferBlueprintLighting } from './blueprintLighting.ts'
import { sceneLighting } from './sceneInference.ts'

/** Retain authored relationships while applying the current director controls. */
export function authoredAnimaCaption(plan: PromptPlan, caption: string): string {
  const light = LIGHTING.find(option => plan.lighting.some(token => normalizeProseKey(token) === normalizeProseKey(option.prompt || '')))
  const sourceLight = plan.scene ? sceneLighting(plan.scene) : inferBlueprintLighting({ lighting: plan.authoredLighting })
  const adjustedLight = light?.id === sourceLight ? caption : renderRandomVariationProse(caption, null, light?.id ?? null)
  const parts = [renderCameraProse(adjustedLight, [...plan.manual, ...plan.camera])]
  // Camera and light controls already have tags. Keep prose for authored visual relationships.
  const visual = plan.visualDescription.trim()
  // Random variations can already use this exact description as their caption.
  if (visual && normalizeProseKey(visual) !== normalizeProseKey(caption)) parts.push(visual)
  return parts.map(part => `${part.replace(/[.!?]+$/, '')}.`).join(' ')
}
