import type { PopularCharacter, PopularOutfit } from '@/types/character'
import { substituteScenarioPrompt, type ScenarioCharacter } from '@/config/scenarios'

/** Replace authored placeholders, preserving act-specific props and actions. */
export function scenarioCastPrompt(template: string, base: ScenarioCharacter, cast?: PopularCharacter, outfit?: PopularOutfit): string {
  if (!cast || !outfit) return substituteScenarioPrompt(template, base)
  const lines = template.split('\n')
  lines[1] = `1girl, solo, ${(outfit.identityTokensOverride || cast.identityTokens).join(', ')}`
  const wardrobe = outfit.tokens.join(', ')
  lines[2] = /\bschool uniform\b/i.test(lines[2] || '')
    ? lines[2].replace(/\bschool uniform\b/ig, wardrobe)
    : `${wardrobe}, ${lines[2] || ''}`
  return lines.join('\n')
}
