import type { PromptPlan } from '../types/prompt'
import { LIGHTING } from '../config/promptConstants.ts'
import { normalizeKey } from './promptPrimitives.ts'
import { inferBlueprintLighting } from './blueprintLighting.ts'
import { sceneLighting } from './sceneInference.ts'

// Only named primary-light controls are replaceable. Rim/fill light, lamps,
// candles, reflections and manual/exact tokens retain their authored roles.
const lightIds: Record<string, string> = {
  golden_hour: 'golden', golden_hour_lighting: 'golden', golden_light: 'golden',
  window_light: 'window', backlight: 'back', backlighting: 'back', backlit: 'back',
  moonlight: 'moon', warm_light: 'lantern', warm_lighting: 'lantern', overcast: 'overcast',
}
const sourcePhrases: Record<string, RegExp> = {
  golden: /\b(?:warm[ _-]+)?(?:golden[ _-]hour(?:[ _-](?:sunlight|light(?:ing)?))?|golden[ _-]light)\b/gi,
  window: /\bwindow[ _-]light(?:ing)?\b/gi,
  back: /\b(?:backlight(?:ing)?|backlit)\b/gi,
  moon: /\b(?:(?:cool|cold|silver|silvery|pale|blue)[ _-]+)?moon(?:light|lit)\b/gi,
  lantern: /\bwarm[ _-]light(?:ing)?\b/gi,
  overcast: /\b(?:(?:diffused|soft)[ _-]+)?overcast[ _-]light(?:ing)?\b/gi,
}

export function lightingTokenId(token: string): string | null {
  return lightIds[normalizeKey(token)] ?? null
}

function authoredLightingId(plan: Pick<PromptPlan, 'scene' | 'authoredLighting'>): string | null {
  return plan.scene ? sceneLighting(plan.scene) : inferBlueprintLighting({ lighting: plan.authoredLighting })
}

export function lightingOverride(plan: Pick<PromptPlan, 'scene' | 'authoredLighting' | 'lighting' | 'lightingSource'>) {
  if (plan.lightingSource === 'scene') return null
  const source = authoredLightingId(plan)
  const selected = LIGHTING.find(option => plan.lighting.some(token => normalizeKey(token) === normalizeKey(option.prompt || '')))
  return source && selected?.prompt && source !== selected.id ? { source, target: selected.id } : null
}

/** Update the known source phrase, leaving independent emitters and relationships intact. */
export function renderLightingProse(prose: string, source: string | null, target: string | null): string {
  const phrase = source ? sourcePhrases[source] : null
  const selected = LIGHTING.find(option => option.id === target)?.prompt
  if (!phrase || !selected || source === target) return prose
  const replacement = selected === 'golden hour' ? 'golden-hour light' : selected === 'overcast' ? 'diffused overcast light' : selected
  const adjective: Record<string, string> = {
    golden: 'sunlit', window: 'window-lit', back: 'backlit',
    moon: 'moonlit', lantern: 'warmly lit', overcast: 'softly lit',
  }
  return prose.replace(phrase, match => /(?:moonlit|backlit)$/i.test(match) ? adjective[target!] : replacement)
}

export function hasVariableLighting(prose: string, source: string | null): boolean {
  return Boolean(source && sourcePhrases[source] && new RegExp(sourcePhrases[source]).test(prose))
}
