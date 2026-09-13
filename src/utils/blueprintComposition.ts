import { mergeTokenText } from './promptPolicy.ts'

import type { BlueprintCompositionIntent } from '../types/sceneBlueprint'
export type { BlueprintCompositionIntent } from '../types/sceneBlueprint'
type CompositionSource = { adult?: boolean; compositionIntent?: BlueprintCompositionIntent }

export function parseCompositionIntent(value: unknown): BlueprintCompositionIntent {
  if (value == null || value === '') return 'single'
  if (value === 'single' || value === 'group' || value === 'triptych') return value
  throw new Error('Invalid blueprint compositionIntent')
}

export function compositionIntent(source?: CompositionSource | null): BlueprintCompositionIntent {
  return source?.adult ? 'single' : (source?.compositionIntent || 'single')
}

const personSuppression = new Set([
  'multiple girls', 'second person', 'two people', 'extra person', 'extra characters',
  '1boy', '2boys', '2girls', '3girls', '4girls', '5girls', 'crowd', 'bystanders', 'extra girl',
])
const panelSuppression = new Set([
  'split image', 'split screen', 'split panel', 'two panels', 'diptych', 'triptych',
  'comic strip', 'multiple frames', 'panel borders', 'frame borders', 'double exposure',
  'double image', 'duplicated subject', 'duplicated body', 'duplicate', 'duplicated person',
  'clone', 'copy', 'doppelganger', 'twin', 'two of her', 'second instance of her', 'same character twice',
])
const key = (token: string) => token.trim().toLowerCase().replaceAll('_', ' ').replace(/^\((.*):[\d.]+\)$/, '$1')

export function compositionTokens(tokens: string[], source?: CompositionSource | null): string[] {
  return compositionIntent(source) === 'single' ? tokens : tokens.filter(t => !['solo', '1girl', 'single girl', 'single subject'].includes(key(t)))
}

export function compositionNegative(text: string, source?: CompositionSource | null): string {
  const intent = compositionIntent(source)
  if (intent === 'single') return text
  return text.split(',').filter(t => !personSuppression.has(key(t)) && !(intent === 'triptych' && panelSuppression.has(key(t)))).join(',')
}

const defaultSuppression = 'split image, split screen, split panel, two panels, diptych, triptych, comic strip, multiple frames, panel borders, frame borders, double exposure, double image, duplicated subject, duplicated body, multiple girls, second person, two people, duplicate, duplicated person, extra person, extra limbs, 1boy, 2boys, crowd, bystanders'

export function blueprintNegative(negative: string, source?: CompositionSource | null): string {
  return compositionNegative(mergeTokenText(negative, defaultSuppression), source)
}

export function showcaseSubjectGuards(source?: CompositionSource | null): { prompt: string; negative: string } {
  const intent = compositionIntent(source)
  const cloneNegative = 'duplicate, clone, copy, doppelganger, twin, two of her, second instance of her, duplicated subject, multiple girls, extra girl, same character twice'
  if (intent === 'triptych') return { prompt: 'exactly three sequential panels, same character once in each panel, consistent character design', negative: 'extra panels, inconsistent character design' }
  if (intent === 'group') return { prompt: 'distinct companions, one instance of each character, no cloned characters', negative: compositionNegative(cloneNegative, source) }
  const cloneGuard = '(no clone:1.4), (no duplicate:1.4), (no twin:1.3), no duplicated character, no second copy, no doppelganger, no double body, no mirror copy, single subject only'
  return {
    prompt: source?.adult
      ? `(solo:1.5), (1girl:1.4), (single girl only:1.6), (one person only:1.6), (no second person:1.3), no other person, no bystanders, no background people, ${cloneGuard}`
      : `(single girl only:1.4), (one person only:1.4), no second person, no other person, ${cloneGuard}`,
    negative: cloneNegative,
  }
}
