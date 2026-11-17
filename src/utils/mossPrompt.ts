import type { PromptPlan } from '../types/prompt'
import { normalizeArtistStyleIds, parseArtistStyleItem } from '../config/artistStyles.ts'
import { CANONICAL_OUTFITS } from './canonicalOutfits.ts'
import { authoredSceneCaption } from './promptCaption.ts'
import { resolveCameraTags } from './promptCamera.ts'
import { normalizeKey, tokenize } from './promptPrimitives.ts'
import { proseToken } from './promptPhraseTables.ts'
import { orderPromptTags } from './animaPromptOrder.ts'
import { compileMossLayout, isMossLayoutInput, mossLayoutJson, mossSubjectBox, type MossCanvasSize, type MossLayoutSide } from './mossLayout.ts'

// MIAOKA's shared BASE v1.0/v1.1 positive and negative recipe.
export const MOSS_QUALITY = 'masterpiece, best quality, very aesthetic, ultra-detailed, high contrast'
export const MOSS_NEGATIVE = 'extra toes, lowres, (bad), text, error, fewer, extra, missing, worst quality, jpeg artifacts, low quality, watermark, unfinished, displeasing, oldest, early, signature, artistic error, username, bad feet, scan, [abstract], english text, shiny hair'

/** MOSS consumes names/styles as tags; it does not parse artist weights. */
export function mossArtistTags(ids: readonly string[]): string[] {
  return normalizeArtistStyleIds(ids).flatMap(item => {
    const parsed = parseArtistStyleItem(item)
    return parsed ? [parsed.id] : []
  })
}

const compositionPlacement: Record<string, MossLayoutSide | 'center'> = {
  subject_on_the_left_side_of_the_image: 'left',
  subject_on_the_right_side_of_the_image: 'right',
  centered_composition: 'center',
}

/** Render MOSS visual facts without an Anima/Krea profile or LoRA controls. */
export function renderMossDrawingPrompt(plan: PromptPlan | null, description: string, negative: string, size?: MossCanvasSize) {
  const authored = description.trim()
  const mergeNegative = (base: string) => [...new Set([base, ...(plan?.negative ?? [])]
    .flatMap(tokenize).map(value => value.trim()).filter(Boolean))].join(', ')
  if (isMossLayoutInput(authored)) {
    const layout = compileMossPrompt(authored, negative, size)
    return { raw: authored, prompt: layout.prompt, negative: mergeNegative(layout.negative) }
  }

  const rawTags = plan ? [
    ...plan.rating, ...(plan.freeSubject ? [] : plan.characterTokens),
    ...(plan.freeSubject ? [] : plan.copyrightTokens), ...plan.artists,
    ...plan.identity, ...plan.exactControls, ...plan.sceneVisualFragments,
    ...plan.emotion, ...plan.camera, ...plan.lighting, ...plan.palette, ...plan.composition, ...plan.manual,
  ].flatMap(tokenize) : []
  const seen = new Set<string>(), outfits = new Set<string>()
  const tags = resolveCameraTags(rawTags, plan?.manual || [], plan?.camera || []).flatMap(value => {
    let token = value.replace(/<lora:[^>]+>/gi, '').replace(/\\([()])/g, '$1').trim()
    token = token.replace(/^\((.*):\s*-?\d+(?:\.\d+)?\)$/, '$1').trim()
    let key = normalizeKey(token)
    if (!key || key === 'break') return []
    if (/^(?:nene|natsume)_/.test(key)) {
      const outfit = Object.values(CANONICAL_OUTFITS).find(item => item.tags[0] === key)
      if (outfit) outfits.add(outfit.prose)
      else {
        token = proseToken(token)
        key = normalizeKey(token)
      }
      if (outfit || !key) return []
    }
    if (seen.has(key)) return []
    seen.add(key)
    return [token.replace(/_/g, ' ')]
  })
  const sceneProse = plan?.sceneProse || plan?.scene?.promptProse || plan?.scene?.animaCaption || ''
  const prose = plan ? [plan.subjectProse, plan.outfitProse ? `Clothing: ${plan.outfitProse}` : '',
    ...outfits, sceneProse ? authoredSceneCaption(plan, sceneProse, false) : '']
    .map(value => value.replace(/<lora:[^>]+>/gi, '').replace(/\bBREAK\b/g, ', ').trim()) : []
  // Free-subject identities are classification metadata, not tokens to inject.
  const ordered = plan?.freeSubject && (plan.characterTokens.length || plan.copyrightTokens.length)
    ? orderPromptTags({ ...plan, quality: MOSS_QUALITY.split(', ') }, tags) : tags
  const tagLine = ordered.join(', ')
  if (size) {
    // Keep the relationships authored in prose, with exact visual cues inside the caption.
    const caption = [...new Set([authored, ...prose, tagLine].filter(Boolean))].join('\n')
    if (!caption) return { raw: '', prompt: '', negative: mergeNegative(negative) }
    const intent = plan?.mossLayout?.compositionIntent || plan?.scene?.compositionIntent
    const multiPanel = intent === 'triptych' || ordered.some(tag => /^(?:triptych|diptych|three panels|two panels|multi panel)$/i.test(tag))
    const subjects = plan?.mossLayout?.subjects
    const explicitlySplit = !multiPanel && subjects?.length === 2 && new Set(subjects.map(subject => subject.side)).size === 2
      && subjects.every(subject => subject.side)
    const people = ordered.flatMap(tag => tag.match(/^(\d+)\s*(?:girls?|boys?|people|women|men|others?)$/i)?.[1] ?? [])
    const singleSubject = !multiPanel && intent !== 'group'
      && people.length <= 1 && !people.some(count => Number(count) > 1)
      && !ordered.some(tag => /^(?:group|multiple girls|multiple boys)$/i.test(tag))
    const mainCharacter = singleSubject && Boolean(plan?.subjectProse || people[0] === '1')
    const placement = singleSubject ? compositionPlacement[normalizeKey(plan?.composition[0] ?? '')] : undefined
    const sceneDetail = authored || prose.at(-1) || tagLine
    const characterDetail = plan?.subjectProse ? prose.slice(0, 2).filter(Boolean).join('. ') : sceneDetail
    const items = explicitlySplit
      ? subjects.map(subject => ({ label: 'character' as const, caption: subject.caption, bbox: mossSubjectBox(size, subject.side) }))
      : [{
          label: mainCharacter ? 'character' as const : 'object' as const,
          caption: mainCharacter ? characterDetail || sceneDetail : sceneDetail,
          bbox: mossSubjectBox(size, placement),
        }]
    const raw = mossLayoutJson(caption, items, multiPanel)
    const compiled = compileMossPrompt(raw, negative, size)
    return { raw, prompt: compiled.prompt, negative: mergeNegative(compiled.negative) }
  }
  const raw = [...new Set([tagLine, ...prose, authored].filter(Boolean))].join('\n')
  const compiled = compileMossPrompt(raw, negative)
  return { raw, prompt: compiled.prompt, negative: mergeNegative(compiled.negative) }
}

/** Only explicit lettering cues relax the author defaults; custom exclusions remain intact. */
function mossTextIntent(text: string): boolean {
  const tags = text.split(/[,\n]/).map(normalizeKey)
  const positive = text.split(/[.!?\n]/).filter(sentence =>
    !/\b(?:no|not|without|avoid|exclude|omit|don't)\b|不要|不含|没有|无文字/i.test(sentence)).join('\n')
  return tags.some(tag => ['text', 'english_text', 'chinese_text', 'japanese_text', 'korean_text', 'lettering', 'speech_bubble'].includes(tag))
    || /\b(?:text|lettering|caption|title|sign|poster|speech bubble)\s*(?:(?:reads?|says?|reading|saying|:|=)\s*)?["'“‘「『]/i.test(positive)
    || /(?:写上|写着|文字内容|标题内容|标语内容)\s*[:：]?\s*["'“‘「『]/.test(positive)
}

function mossTextNegative(negative: string, hasText: boolean): string {
  return hasText && negative.trim() === MOSS_NEGATIVE
    ? tokenize(negative).filter(token => !['text', 'english_text'].includes(normalizeKey(token))).join(', ')
    : negative.trim()
}

export function compileMossPrompt(prompt: string, negative: string, size?: MossCanvasSize) {
  const text = prompt.trim()
  if (isMossLayoutInput(text)) {
    const layout = compileMossLayout(text, size)
    return { prompt: layout.prompt, negative: mossTextNegative(negative, layout.hasText || mossTextIntent(layout.caption)) }
  }
  const authored = new Set(text.split(/[,\n]/).map(token => token.trim().toLowerCase()))
  const quality = MOSS_QUALITY.split(', ').filter(token => !authored.has(token))
  return { prompt: [...quality, text].filter(Boolean).join(', '), negative: mossTextNegative(negative, mossTextIntent(text)) }
}
