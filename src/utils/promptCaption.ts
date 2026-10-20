import type { PromptPlan } from '../types/prompt'
import { normalizeProseKey } from './promptPhraseTables.ts'
import { renderCameraProse } from './promptCamera.ts'
import { lightingOverride, renderLightingProse } from './promptLighting.ts'

/** Retain authored relationships while applying the current director controls. */
export function authoredSceneCaption(plan: PromptPlan, caption: string, includeVisual = true): string {
  const light = lightingOverride(plan)
  const adjustedLight = light ? renderLightingProse(caption, light.source, light.target) : caption
  const parts = [renderCameraProse(adjustedLight, [...plan.manual, ...plan.camera])]
  // Camera and light controls already have tags. Keep prose for authored visual relationships.
  const visual = plan.visualDescription.trim()
  // Random variations can already use this exact description as their caption.
  if (includeVisual && visual && normalizeProseKey(visual) !== normalizeProseKey(caption)) parts.push(visual)
  return parts.map(part => `${part.replace(/[.!?]+$/, '')}.`).join(' ')
}
