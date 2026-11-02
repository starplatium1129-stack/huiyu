import type { PromptPlan } from '../types/prompt'
import { normalizeArtistStyleIds, parseArtistStyleItem } from '../config/artistStyles.ts'
import { CANONICAL_OUTFITS } from './canonicalOutfits.ts'
import { authoredSceneCaption } from './promptCaption.ts'
import { resolveCameraTags } from './promptCamera.ts'
import { normalizeKey, tokenize } from './promptPrimitives.ts'
import { proseToken } from './promptPhraseTables.ts'
import { orderPromptTags } from './animaPromptOrder.ts'

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

/** Render MOSS visual facts without an Anima/Krea profile or LoRA controls. */
export function renderMossDrawingPrompt(plan: PromptPlan | null, description: string, negative: string) {
  const authored = description.trim()
  const mergeNegative = (base: string) => [...new Set([base, ...(plan?.negative ?? [])]
    .flatMap(tokenize).map(value => value.trim()).filter(Boolean))].join(', ')
  if (authored.startsWith('{')) {
    const layout = compileMossPrompt(authored, negative)
    return { raw: authored, prompt: layout.prompt, negative: mergeNegative(layout.negative), tagLine: '' }
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
  const raw = [...new Set([tagLine, ...prose, authored].filter(Boolean))].join('\n')
  const compiled = compileMossPrompt(raw, negative)
  return { raw, prompt: compiled.prompt, negative: mergeNegative(compiled.negative), tagLine }
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

export function compileMossPrompt(prompt: string, negative: string) {
  const text = prompt.trim()
  if (text.startsWith('{')) {
    let layout: unknown
    try { layout = JSON.parse(text) } catch { throw new Error('布局 JSON 无法解析，请检查引号、逗号和括号') }
    if (!layout || typeof layout !== 'object' || Array.isArray(layout)) throw new Error('布局须为 JSON 对象')
    // Layout is one intact input. Never prepend tags or rewrite coordinates.
    // Author-default text exclusions yield to an explicitly authored text item.
    const items = 'items' in layout ? layout.items : undefined
    const hasText = Array.isArray(items) && items.some(item => item && typeof item.text === 'string' && item.text.trim())
    return { prompt: text, negative: mossTextNegative(negative, hasText) }
  }
  const authored = new Set(text.split(/[,\n]/).map(token => token.trim().toLowerCase()))
  const quality = MOSS_QUALITY.split(', ').filter(token => !authored.has(token))
  return { prompt: [...quality, text].filter(Boolean).join(', '), negative: mossTextNegative(negative, mossTextIntent(text)) }
}
