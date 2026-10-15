import type { BlueprintCompositionIntent } from '../types/sceneBlueprint'
export type { BlueprintCompositionIntent } from '../types/sceneBlueprint'
type CompositionSource = { adult?: boolean; compositionIntent?: BlueprintCompositionIntent; allowRepeatedSubject?: boolean }

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
  'comic panel', 'border', 'white border', 'framed',
  'double image', 'duplicated subject', 'duplicated body', 'duplicate', 'duplicated person',
  'clone', 'copy', 'doppelganger', 'twin', 'two of her', 'second instance of her', 'same character twice',
])
const repeatSuppression = new Set(['double exposure', 'double image', 'duplicated subject', 'duplicated body', 'duplicate', 'duplicated person', 'clone', 'copy', 'doppelganger', 'twin', 'two of her', 'second instance of her', 'same character twice'])
const key = (token: string) => token.trim().toLowerCase().replaceAll('_', ' ').replace(/^\((.*):[\d.]+\)$/, '$1')

export function compositionTokens(tokens: string[], source?: CompositionSource | null): string[] {
  return compositionIntent(source) === 'single' ? tokens : tokens.filter(t => !['solo', '1girl', 'single girl', 'single subject'].includes(key(t)))
}

export function compositionNegative(text: string, source?: CompositionSource | null): string {
  const intent = compositionIntent(source)
  const repeats = !source?.adult && source?.allowRepeatedSubject === true
  if (intent === 'single' && !repeats) return text
  return text.split(',').filter(t => !(intent !== 'single' && personSuppression.has(key(t))) && !(intent === 'triptych' && panelSuppression.has(key(t))) && !(repeats && repeatSuppression.has(key(t)))).join(',')
}

export function showcaseSubjectGuards(source?: CompositionSource | null): { prompt: string; negative: string } {
  const intent = compositionIntent(source)
  if (!source?.adult && source?.allowRepeatedSubject) return { prompt: 'preserve the requested reflection or illusory echo', negative: '' }
  if (intent === 'triptych') return { prompt: 'three sequential panels, same character in each panel', negative: '' }
  if (intent === 'group') return { prompt: 'distinct companions', negative: '' }
  return { prompt: '1girl, solo', negative: '' }
}
