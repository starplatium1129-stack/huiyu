import type { PromptPlan } from '../types/prompt'
import { isOutfitToken } from './popularIdentity.ts'
import { cleanCastProse } from './promptCast.ts'
import { mossCastBoxes, mossNormalizedBox, type MossCanvasSize, type MossLayoutItem } from './mossLayout.ts'

type CastLayout = NonNullable<PromptPlan['mossLayout']>
type CastSubject = NonNullable<CastLayout['subjects']>[number]
type ReferenceItem = NonNullable<CastLayout['referenceLayout']>['layout']['items'][number]

const adjective = 'very|extremely|light|dark|bright|pale|deep|long|short|medium|shoulder.length|waist.length|wavy|straight|curly|braided|flowing|silky|fluffy|spiky|tousled|twin|jet|platinum|golden|blond[e]?|black|white|brown|red|pink|blue|silver|purple|orange|green|grey|gray|auburn|violet|lavender|teal|cyan|aqua|turquoise|multicolored|amber|hazel|tan|tanned|fair|olive'
const appearance = new RegExp(
  '\\b(?:(?:' + adjective + ')(?:[, _-]+)){1,6}(?:hair|eyes|skin|braids?|ponytails?|pigtails?|bangs)\\b'
  + '|\\b(?:blond[e]?|brunette|redheaded|fair.skinned|dark.skinned|(?:' + adjective + ')[ _-](?:haired|eyed))\\b'
  + '|\\b(?:hime.cut|bob.cut|pigtails?|ponytails?|twintails?|freckles|horns?|halos?|(?:fox|cat|wolf|elf|rabbit|animal|pointed) ears|(?:fluffy|cat|fox|devil) tail|(?:angel|feathered|bat|demon) wings)\\b',
  'gi',
)
const bareSubject = /^(?:(?:the |a |an |another )?(?:(?:left|right|central|rear|front) )?(?:character|subject|person|figure|woman|man|girl|boy)s?|she|he|they|both|each)(?:[.!?;]+|$)/i
const clothingDetail = /^(?:sleeves?|cuffs?|collars?|lapels?|hemlines?|garters?|thongs?|slippers?|loafers?|sleeveless|nightdress|babydoll)$/

export function cleanMossCastText(value: string): string {
  return value.replace(/<lora:[^>]+>/gi, '').replace(/\b(?:nene|natsume)_[a-z0-9_]+\b/gi, '')
    .replace(/\bBREAK\b/g, ', ').trim()
}

function withoutReferenceClothes(value: string): string {
  const nouns = [...new Set((value.toLowerCase().match(/[a-z]+/g) ?? []).filter(word =>
    isOutfitToken(word) || isOutfitToken(word.replace(/s$/, '')) || clothingDetail.test(word)))]
  const states = /\b(?:(?:(?:fully|completely|entirely|totally)\s+)?(?:nude|naked|unclothed|topless|bottomless|shirtless)|without (?:any )?clothes)\b/gi
  value = value.replace(states, '')
  if (nouns.length === 0) return value

  const stopWords = 'a|an|the|her|their|his|while|as|before|after|by|from|at|near|beside|in|on|over|under|with|and|or|that|who|holds?|holding|standing|stands?|sitting|sits?|seated|kneels?|kneeling|lies|lying|leans?|leaning|reclining|reclines?|reaches?|reaching|smiles?|smiling|looks?|looking|walks?|walking|runs?|running|poses?|posing'
  const modifier = '(?!(?:' + stopWords + ')\\b)[a-z]+(?:-[a-z]+)?'
  const garment = '(?:(?:a|an|the|her|his|their)\\s+)?(?:' + modifier + '\\s+){0,5}(?:' + nouns.join('|') + ')\\b(?!\\s+(?:shop|store|rack|display)\\b)'
  const list = garment + '(?:(?:\\s*,\\s*(?:and\\s+)?|\\s+(?:and|with|over|under)\\s+)' + garment + ')*'
  const worn = new RegExp('\\b(?:(?:(?:is|are|was|were)\\s+)?(?:wears?|wearing|dressed in|clad in|outfitted in)|has|have|in|with)\\s+' + list, 'gi')
  const possessed = new RegExp('\\b(her|his|their)\\s+' + garment, 'gi')
  const fragment = new RegExp('(^|[,;]\\s*)(?:and\\s+)?' + list + '(?=\\s*[,;.!?]|\\s*$)', 'gi')
  return value.replace(worn, '').replace(possessed, '$1 outfit').replace(fragment, '$1')
}

/** A usable projection of the raw reference. Keep the original for later role and outfit changes. */
export function cleanMossReferenceProse(value: string, identityTerms: readonly string[] = [], replaceOutfit = false): string {
  let result = cleanMossCastText(value)
  const terms = identityTerms.map(term => term.trim()).filter(term => term.length > 1).sort((a, b) => b.length - a.length)
  for (const term of new Set(terms)) {
    const literal = term.split(/[\s_-]+/).map(word => word.replace(/[.*+?^{$}()|[\]\\]/g, '\\$&')).join('[\\s_-]+')
    if (!literal) continue
    result = result.replace(new RegExp('(?<![\\p{L}\\p{N}_])' + literal + '(?![\\p{L}\\p{N}_])', 'giu'), '')
  }
  result = result.replace(appearance, '')
  if (replaceOutfit) result = withoutReferenceClothes(result)
  return result.split(/(?<=[.!?;])\s+/).flatMap(sentence => {
    const cleaned = sentence.replace(/\b(?:who|with|has|have|is|are|and|or|and with)\s*(?=[,.!?;]|$)/gi, '')
      .replace(/[ \t]+/g, ' ').replace(/\s+([,.;!?])/g, '$1')
      .replace(/(?:,\s*){2,}/g, ', ').replace(/,+([.;!?])/g, '$1')
      .replace(/^[\s,.;]+|[\s,]+$/g, '')
    return cleaned && /\p{L}/u.test(cleaned) && !bareSubject.test(cleaned) ? [cleaned] : []
  }).join(' ')
}

function withLocalReference(subject: CastSubject, caption: string): string {
  const parts = subject.identityCaption
    ? [subject.identityCaption, subject.outfitExplicit ? subject.outfitCaption : '', caption, subject.action]
    : [subject.caption, caption]
  return parts.map(part => cleanCastProse(cleanMossCastText(part ?? ''))).filter(Boolean).join('\n') || 'Character in this position.'
}

function area({ bbox: [top, left, bottom, right] }: ReferenceItem) {
  return (bottom - top) * (right - left)
}

function centerX({ bbox: [, left, , right] }: ReferenceItem) {
  return (left + right) / 2
}

export function buildMossCastLayout(layout: CastLayout, subjects: readonly CastSubject[], size: MossCanvasSize) {
  const reference = layout.referenceLayout?.layout
  const characters = reference?.items.filter(item => item.label === 'character') ?? []
  const useReference = characters.length >= subjects.length
  const toLocal = (item: ReferenceItem, replaceOutfit = false) =>
    cleanCastProse(cleanMossReferenceProse(item.caption, layout.referenceIdentityTerms, replaceOutfit))
  const toItem = (item: ReferenceItem, caption: string): MossLayoutItem => ({
    label: item.label, caption, bbox: mossNormalizedBox(size, item.bbox),
    ...(item.label === 'text' ? { text: item.text } : {}),
  })
  const supplemental = reference?.items.flatMap(item => {
    if (item.label === 'text') return [toItem(item, toLocal(item) || 'Visible lettering.')]
    if (useReference && item.label === 'object') return [toItem(item, toLocal(item) || 'Reference prop.')]
    return []
  }) ?? []
  if (useReference) {
    // Sorting is stable. In a tie, the original reference order remains the tie-breaker.
    const targets = new Set([...characters].sort((a, b) => area(b) - area(a)).slice(0, subjects.length))
    let actor = 0
    const items = [...characters].sort((a, b) => centerX(a) - centerX(b)).map(item => {
      const subject = targets.has(item) ? subjects[actor++] : undefined
      return toItem(item, subject
        ? withLocalReference(subject, toLocal(item, subject.outfitExplicit))
        : toLocal(item) || 'Supporting character in this position.')
    })
    return { items: [...items, ...supplemental], canvas: reference?.canvas ?? 'single',
      extraPeople: characters.length - subjects.length }
  }

  const boxes = mossCastBoxes(size, subjects.length, layout.formation)
  const items = subjects.map((subject, index): MossLayoutItem => ({
    label: 'character', caption: cleanCastProse(cleanMossCastText(subject.caption)) || 'Character in this position.', bbox: boxes[index],
  }))
  return { items: [...items, ...supplemental.slice(0, 16 - items.length)], canvas: 'single' as const, extraPeople: 0 }
}
