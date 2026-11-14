import type { PopularCharacter, PopularOutfit } from '@/types/character'
import { substituteScenarioPrompt, type ScenarioCharacter } from '@/config/scenarios'
import { wardrobeTokens } from './wardrobeContent.ts'

/** Replace authored placeholders, preserving act-specific props and actions. */
export function scenarioCastPrompt(template: string, base: ScenarioCharacter, cast?: PopularCharacter, outfit?: PopularOutfit): string {
  if (!cast || !outfit) return substituteScenarioPrompt(template, base)
  const lines = template.split('\n')
  const identity = wardrobeTokens(outfit.identityTokensOverride ?? [])
  lines[1] = `1girl, solo, ${(identity.length ? identity : cast.identityTokens).join(', ')}`
  const wardrobe = wardrobeTokens(outfit.tokens).join(', ')
  if (!wardrobe) return lines.join('\n')
  lines[2] = /\bschool uniform\b/i.test(lines[2] || '')
    ? lines[2].replace(/\bschool uniform\b/ig, wardrobe)
    : `${wardrobe}, ${lines[2] || ''}`
  return lines.join('\n')
}
