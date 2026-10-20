import { isStableIdentityToken } from './interrogateReference.ts'
import { normalizeProseKey } from './promptPhraseTables.ts'

const words = (value: string) => normalizeProseKey(value).replace(/[^a-z0-9_]/g, '_').split('_').filter(Boolean)

/** Detect concrete identity references; never rewrite a relationship sentence by guessing. */
export function roamingIdentityReferences(caption: string, sourceNames: readonly string[], targetTraits: readonly string[]): string[] {
  const text = ` ${words(caption).join(' ')} `
  const target = targetTraits.map(value => words(value).join(' ')).filter(Boolean)
  const references = sourceNames.map(value => words(value).join(' '))
    .filter(name => name.length >= 3 && text.includes(` ${name} `))
  const tokens = words(caption)
  for (let start = 0; start < tokens.length; start++) {
    for (let length = 1; length <= 4 && start + length <= tokens.length; length++) {
      const phrase = tokens.slice(start, start + length).join(' ')
      const retained = target.some(trait => phrase === trait || phrase.endsWith(` ${trait}`) || trait.endsWith(` ${phrase}`))
      if (isStableIdentityToken(phrase) && !retained) references.push(phrase)
    }
  }
  return [...new Set(references)].filter(value => !references.some(other => other !== value && value.endsWith(` ${other}`)))
}
