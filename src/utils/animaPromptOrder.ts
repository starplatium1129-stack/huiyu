import type { PromptPlan } from '../types/prompt'
import { QUALITY_OR_SCORE_RE } from './promptDiagnostics.ts'
import { splitBreaks, tokenize } from './promptPrimitives.ts'

/** Classification only: preserve original spelling, literal parentheses and weights in output. */
export function tagKey(token: string): string {
  let value = token.trim()
  const weighted = /^\((.*):\s*-?\d+(?:\.\d+)?\s*\)$/.exec(value)
  if (weighted) value = weighted[1]
  return value.replace(/\\([()])/g, '$1').replace(/[_\s]+/g, ' ').trim().toLowerCase()
}

/** Anima's six sections; BREAK keeps its existing character scope. Prose is rendered separately. */
export function orderedAnimaTags(plan: PromptPlan, tags: string[], stripQuality = false): string {
  const characters = new Set(plan.characterTokens.map(tagKey))
  const copyrights = new Set(plan.copyrightTokens.map(tagKey))
  const artists = new Set(plan.artists.flatMap(tokenize).map(tagKey))
  const quality = new Set(plan.quality.map(tagKey))
  const rating = new Set(plan.rating.map(tagKey))
  const sections = splitBreaks(tags.join(', ')).map(tokenize)
  sections[0].push(...plan.copyrightTokens)
  return sections.map(tokens => {
    const groups: string[][] = Array.from({ length: 7 }, () => [])
    for (const token of tokens) {
      const key = tagKey(token)
      const isQuality = quality.has(key) || QUALITY_OR_SCORE_RE.test(key.replace(/ /g, '_'))
      if (stripQuality && isQuality) continue
      const group = isQuality ? 0
        : rating.has(key) || /^(?:safe|general|sensitive|questionable|explicit|nsfw)$/.test(key) ? 1
        : /^(?:\d+\+?(?:girls?|boys?|others?|people)|solo|multiple girls|multiple boys|no humans)$/.test(key) ? 2
        : characters.has(key) ? 3
        : copyrights.has(key) ? 4
        : artists.has(key) || key.startsWith('@') ? 5 : 6
      groups[group].push(token)
    }
    return groups.flat().join(', ')
  }).filter(Boolean).join(' BREAK ')
}
