import { normalizeProseKey, proseToken } from './promptPhraseTables.ts'
import { tokenize } from './promptPrimitives.ts'
import type { DraftOutfitOverride } from './promptBuilderPersistence'

const TIME_WEATHER_TAG = /^(?:(?:early_|late_)?(?:morning|afternoon|evening|night)|(?:spring|summer|autumn|winter)(?:_clothes)?|dawn|sunrise|sunset|dusk|noon|midnight|day(?:time|light)?|nighttime|nightlife|golden_hour|blue_hour|overcast|sunny|rain(?:y|ing|fall|y_day|y_night)?|snow(?:y|ing|fall)?|(?:clear|starry|night)_sky)$/
const LIGHT_PALETTE_TAG = /^(?:(?:[a-z]+_)*(?:background|backdrop|scenery|atmosphere|theme|tones?|palette|color_scheme|color_grading|lighting|light|light_rays|sunbeam|shadow|shadows|backlit|moonlit|candlelit)|sunlight|moonlight|sunshine|monochrome|greyscale|grayscale|sepia|high_contrast|low_contrast|warm_radiance|color_(?:cast|temperature))$/
// Match complete setting tags. Words like train, forest and beach can describe clothing.
const SETTING_TAG = /^(?:(?:indoor|outdoor)s?|(?:japanese|summer|school)_festival|(?:swimming_)?pool|(?:hotel|living|dressing)_room|(?:beach|bedroom|classroom|clubroom|cafe|bathroom|shrine|park|garden|rooftop|library|kitchen|balcony|office|studio|ocean|sea|forest|street|backstage|festival)(?:_interior|_exterior)?|(?:on_|in_|lying_on_|sitting_on_)?(?:bed|futon)|on_(?:the_)?(?:stage|beach)|(?:[a-z]+_)*pillow|poolside|underwater|floating_water_bubbles|boudoir)$/

/** Only apply at the wardrobe boundary. Scene and manually authored tags use their own fields. */
export function isWardrobeContextTag(value: string): boolean {
  const key = normalizeProseKey(value.trim())
  return TIME_WEATHER_TAG.test(key) || LIGHT_PALETTE_TAG.test(key) || SETTING_TAG.test(key)
}

export function wardrobeTokens(values: readonly string[]): string[] {
  return values.flatMap(tokenize).filter(value => !isWardrobeContextTag(value))
}

const LIGHT = '(?:(?:the |a )?(?:(?:dim|warm|cool|cold|soft|harsh|bright|pink|blue|golden|muted|colored|ambient|cinematic|diffuse|diffused|romantic|neon|studio|suite|bedroom|room|window|morning|evening) ){0,6}(?:lighting|sunlight|moonlight|candlelight|daylight|glow|light|shadows)|(?:golden|blue) hour|(?:the |a )?(?:glow|light) of (?:the |a )?(?:candles?|lanterns?|windows?|lamps?|sun|moon))'
const PLACE = '(?:(?:the |a |an )?(?:(?:dim|dark|quiet|bright|empty|small|large|wide|white|black|crumpled|satin|velvet|silk|private|tropical|sandy|moonlit|sunlit) ){0,5}(?:bedroom|bathroom|balcony|classroom|beach|pool(?:side)?|forest|garden|library|studio|street|rooftop|stage|bed|futon|sheets|sky)|(?:the )?(?:rain|snow|sunset|sunrise|night|dusk|dawn))'
const CONTEXT_CLAUSE = new RegExp(`\\s+(?:in|on|at|under|beneath|beside|against|by|across)\\s+(?:${LIGHT}|${PLACE})(?=\\s*(?:$|[.!?]|\\band\\b))`, 'gi')
const CONTEXT_FRAGMENT = /^(?:(?:[a-z-]+\s+){0,6}(?:lighting|moonlight|sunlight|candlelight|backlighting|background|backdrop|scenery|atmosphere|color palette|color grading|tones|(?:bedroom|moonlight|candlelight|neon) glow|(?:room|studio|window) light)|(?:moonlit|sunlit|candlelit)\s+(?:[a-z-]+\s+){0,5}(?:reflections|setting|scene|room|beach|glow))$/i
const SCENE_SENTENCE = /^(?:(?:the |a )?(?:scene|background|backdrop|lighting|color palette|color grading|setting)\s+(?:is|has|uses|takes place|features|shows)|(?:the )?(?:scene|background|overall image|entire image)[:：]|(?:场景|背景|整体画面|画面色调|全图色调|光照|光线)(?:为|是|设在|采用|呈现|[:：]))/i

export function wardrobeProse(value: string | undefined, tokens: readonly string[] = []): string {
  const parts = (value || '').trim().replace(/^(?:wearing|dressed in)\s+/i, '').split(/([,;，；]\s*|(?<=[.!?])\s+|(?<=[。！？])\s*)/)
  const prose = parts.flatMap((part, index) => {
    if (index % 2) return []
    const fragment = part.trim()
    const bare = fragment.replace(/^(?:and|with)\s+/i, '').replace(/[.!?]+$/, '')
    if (SCENE_SENTENCE.test(bare)
      || (CONTEXT_FRAGMENT.test(bare) && !/\b(?:catches|reflects|under|beneath|in|on|by)\b/i.test(bare))) return []
    const text = fragment.replace(CONTEXT_CLAUSE, '')
      .replace(/\s+that (?:catches|reflects) (?:the )?(?:moonlight|sunlight|candlelight)\b/gi, '')
      .replace(/\b(?:sunlit|moonlit|candlelit|sun-drenched|sun-dappled)\s+/gi, '').trim()
    const cleaned = text.replace(/^(?:and|with)\s+/i, '').replace(/[.!?]+$/, '')
    if (!cleaned || (/^(?:[\w-]+\s+){0,2}[\w-]+$/.test(cleaned) && isWardrobeContextTag(cleaned))
      || CONTEXT_FRAGMENT.test(cleaned)) return []
    return [{ text, separator: parts[index - 1] || '' }]
  }).map(({ text, separator }, index) => `${index ? separator || ' ' : ''}${text}`).join('')
  return prose || tokens.map(proseToken).filter(Boolean).join(', ')
}

export function sanitizeOutfitOverride(override?: DraftOutfitOverride | null): DraftOutfitOverride | null {
  if (!override) return null
  const tokens = wardrobeTokens(override.tokens)
  if (!tokens.length) return null
  const suppressedTags = wardrobeTokens(override.suppressedTags ?? [])
  return { ...override, tokens, prose: wardrobeProse(override.prose) || undefined,
    suppressedTags: suppressedTags.length ? suppressedTags : undefined }
}
