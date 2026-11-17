import { actionPhrase, normalizeProseKey } from './promptPhraseTables.ts'
import type { MossLayoutSide } from './mossLayout.ts'

/** Keep the existing studio character blocks scoped before Krea flattens tags into buckets. */
export function studioDualSubject(template: string): {
  subjectProse: string; scenePrompt: string; subjects?: { caption: string; side?: MossLayoutSide }[]
} {
  const blocks = [...template.matchAll(/\(((?:ayachi_nene|shiki_natsume)[^()]*)\)/g)]
  const names: Record<string, string> = { ayachi_nene: 'Ayachi Nene', shiki_natsume: 'Shiki Natsume' }
  const subjects = blocks.flatMap(match => {
    const tokens = match[1].split(',').map(token => token.trim()).filter(Boolean)
    const identity = normalizeProseKey(tokens[0])
    const name = names[identity]
    if (!name) return []
    const position = tokens.map(normalizeProseKey).find(key => key === `${identity}_on_left` || key === `${identity}_on_right`)
    const side = position ? (position.endsWith('_left') ? 'left' : 'right') : undefined
    const details = tokens.filter(token => {
      const key = normalizeProseKey(token)
      return key !== identity && key !== position
    }).map(actionPhrase).filter(Boolean)
    return [{ name, side, caption: `${name}${side ? ` on the ${side}` : ''}: ${details.join(', ')}` } as const]
  })
  // A custom template may omit blocks. Keep its fragments and supply only stable identities.
  if (subjects.length !== 2 || !subjects.some(subject => subject.name === 'Ayachi Nene')
    || !subjects.some(subject => subject.name === 'Shiki Natsume')) {
    return {
      subjectProse: 'Two women: Ayachi Nene with white hair, purple eyes, an ahoge and pink hair ribbons; Shiki Natsume with black hair, golden-yellow eyes, two red hairclips and a mole beneath one eye',
      scenePrompt: template,
    }
  }
  let scenePrompt = template
  for (const block of blocks) scenePrompt = scenePrompt.replace(block[0], '')
  return { subjectProse: subjects.map(subject => subject.caption).join('. '), scenePrompt, subjects }
}
