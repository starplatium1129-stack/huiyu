import type { PromptPlan } from '../types/prompt'
import { normalizeProseKey } from './promptPhraseTables.ts'
import { renderCameraProse } from './promptCamera.ts'
import { lightingOverride, renderLightingProse } from './promptLighting.ts'
import { mutualGroupWithCategory } from './promptDiagnostics.ts'
import { compositionIntent } from './blueprintComposition.ts'

/** A changed primary pose invalidates its old action sentence, including its support/contact.
 * Do not invent a replacement relation (e.g. sitting on a desk -> standing on a desk).
 * Group scenes and arbitrary free descriptions need authored edits rather than subject guessing.
 */
export function withoutReplacedPose(manual: string[], caption: string, scene: PromptPlan['scene']): string {
  const selected = manual.map(mutualGroupWithCategory).find(hit => hit?.category === 'pose')
  if (!selected || compositionIntent(scene) !== 'single') return caption
  const poses: Array<[RegExp, string]> = [
    [/\b(?:stands|standing)\b/i, 'standing'],
    [/\b(?:sits|sitting|seated)\b/i, 'sitting'],
    [/\b(?:lies|lying|reclines|reclining)\b/i, 'lying'],
    [/\b(?:kneels|kneeling|on all fours)\b/i, 'kneeling'],
    [/\b(?:squats|squatting|crouches|crouching)\b/i, 'squatting'],
  ]
  return (caption.match(/[^.!?]+[.!?]*/g) || []).filter(sentence => !poses.some(([phrase, token]) =>
    phrase.test(sentence) && mutualGroupWithCategory(token)?.group !== selected.group)).join(' ').trim()
}

/** Retain authored relationships while applying the current director controls. */
export function authoredSceneCaption(plan: PromptPlan, caption: string, includeVisual = true): string {
  const light = lightingOverride(plan)
  const pose = !includeVisual && plan.scene ? withoutReplacedPose(plan.manual, caption, plan.scene) : caption
  const adjustedLight = light ? renderLightingProse(pose, light.source, light.target) : pose
  const parts = [renderCameraProse(adjustedLight, [...plan.manual, ...plan.camera])]
  // Camera and light controls already have tags. Keep prose for authored visual relationships.
  const visual = plan.visualDescription.trim()
  // Random variations can already use this exact description as their caption.
  if (includeVisual && visual && normalizeProseKey(visual) !== normalizeProseKey(caption)) parts.push(visual)
  return parts.filter(part => part.trim()).map(part => `${part.trim().replace(/[.!?]+$/, '')}.`).join(' ')
}
