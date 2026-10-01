import { identityDomainOf } from './interrogateMerge.ts'
import { normalizeKey, CLOSED_EYES_TOKENS, GAZE_AND_EYE_DETAIL_TOKENS } from './promptPolicy.ts'
import { isGarmentToken } from './popularIdentity.ts'

export interface ReferenceTagOptions {
  knownCharacterTags?: readonly string[]
  catalog?: readonly { en: string; cat: string }[]
}

export interface ReferenceTagSplit {
  /** Normalized, non-identity candidates. Existing merge/rating rules still apply. */
  tags: string[]
  excludedIdentity: string[]
  /** Original text retained for review; never automatically added to the prompt. */
  uncertain: string[]
}

// Reference-only classification, not a replacement for the production tag catalog.
// Do not infer that an unoccupied target identity domain belongs to the reference.
const SPECIES = new Set([
  'human', 'elf', 'dark_elf', 'half_elf', 'fairy', 'angel', 'demon', 'oni', 'orc', 'ogre',
  'mermaid', 'merman', 'android', 'robot', 'cyborg', 'kemonomimi', 'halo',
])
const EAR_TRAIT_RE = /^(?:(?:animal|cat|fox|dog|wolf|rabbit|bunny|horse|mouse|rat|raccoon|tiger|lion|deer|sheep|goat|bear|bat|cow|elf|pointy|pointed|long)_)+(?:ears?)$/
const APPENDAGE_RE = /^(?:(?:animal|cat|fox|dog|wolf|rabbit|bunny|horse|mouse|rat|raccoon|tiger|lion|deer|sheep|goat|bear|bat|cow|dragon|demon|devil|angel|angelic|bird|feathered|butterfly|insect|elf|oni|ear|white|black|red|blue|brown|silver|golden|long|short|fluffy|curled|curved|multiple|two|single|small|large)_)*(?:tails?|wings?|horns?)$/
const EXTRA_HAIR_RE = /^(?:(?:light|dark|pale)_)?(?:aqua|teal|cyan|turquoise|lavender|violet|magenta|maroon|burgundy|ginger|yellow|gold|golden|rainbow|two_tone|two_toned|multicoloured|strawberry_blonde|dirty_blonde|platinum_blonde)_hair$/
const EXTRA_EYE_RE = /^(?:heterochromia|heterochromatic_eyes|mismatched_eyes|odd_eyes|two_toned_eyes|star_shaped_eyes|(?:slit|horizontal|vertical|diamond|star_shaped|heart_shaped)_pupils)$/
const SKIN_COLOR_RE = /^(?:(?:very|light|dark|pale|tan|tanned|fair|brown|black|white|blue|green|purple|red|grey|gray|olive)_)+skin$/
const STABLE_DETAILS_RE = /^(?:freckles|facial_markings|birthmark|(?:facial|face|body)_tattoo|(?:facial|face|body)_scar|scar(?:_across_face|_on_face)?|mole(?:_under_eye|_under_mouth|_on_cheek)?|(?:curly|wavy|straight|drill)_hair|ringlets|(?:blunt|short|asymmetrical|braided)_bangs)$/

// These name a wearable object, even when it is shaped like an animal feature.
// Hair ribbons/earrings must not disappear merely because Appearance is broad.
const ACCESSORY_RE = /^(?:[a-z0-9]+_)*(?:headband|hairband|earrings?|ear_clips?|hairclips?|hair_clips?|hair_ribbons?|hair_ornaments?|hair_flower|necklace|pendant|brooch|bracelet|ribbon|bow|crown|tiara|glasses|goggles)$/
const TEMPORARY_BODY_STATE_RE = /^(?:wet_(?:hair|skin)|messy_hair|windblown_hair|red_ears|sweaty_skin|water_droplets|sweat|bare_(?:shoulders|arms|legs|back|streaks)|backless|off_shoulder|collarbone|shoulder_blade)$/

export function isStableIdentityToken(token: string): boolean {
  const key = normalizeKey(token)
  return Boolean(identityDomainOf(key)) || SPECIES.has(key)
    || EAR_TRAIT_RE.test(key) || APPENDAGE_RE.test(key) || EXTRA_HAIR_RE.test(key)
    || EXTRA_EYE_RE.test(key) || SKIN_COLOR_RE.test(key) || STABLE_DETAILS_RE.test(key)
}

function isAtomicTag(raw: string, key: string, catalogKeys: ReadonlySet<string>): boolean {
  // Accept a single weighted tag, but never flatten caption sentences, tag lists,
  // commands or unknown character-name syntax into an apparently safe token.
  const unweighted = raw.replace(/^\(([^()]+):\s*-?\d+(?:\.\d+)?\)$/, '$1').trim()
  if (!/^[a-z0-9]+(?:[ _-][a-z0-9]+)*$/i.test(unweighted)) return false
  if (/(?:^|_)(?:a|an|the|she|he|they|her|his|their|is|are|has|have|wearing|dressed|whose|while|and|with)(?:_|$)/.test(key)) return false
  if (/(?:^|_)(?:girl|boy|woman|man|person)(?:_|$)/.test(key)) return false
  const words = key.split('_')
  if (words.length > 8) return false
  // Unknown long space-separated phrases are prose candidates. Underscored
  // action tags and known catalog entries need not fit an arbitrary word count.
  return !(/\s/.test(unweighted) && words.length > 3 && !catalogKeys.has(key)
    && !isGarmentToken(key) && !isStableIdentityToken(key))
}

/** Split newly inferred reference tags without modifying user-authored tags. */
export function splitReferenceTags(
  inputTags: readonly string[],
  options: ReferenceTagOptions = {},
): ReferenceTagSplit {
  const knownCharacters = new Set((options.knownCharacterTags ?? []).map(normalizeKey).filter(Boolean))
  const catalogKeys = new Set<string>()
  const characterKeys = new Set<string>()
  const bodyKeys = new Set<string>()
  for (const entry of options.catalog ?? []) {
    const key = normalizeKey(entry.en)
    if (!key) continue
    catalogKeys.add(key)
    if (entry.cat === 'Character') characterKeys.add(key)
    if (entry.cat === 'Body') bodyKeys.add(key)
  }
  const result: ReferenceTagSplit = { tags: [], excludedIdentity: [], uncertain: [] }
  const seen = new Set<string>()
  for (const value of inputTags) {
    if (typeof value !== 'string') continue
    const raw = value.trim()
    const key = normalizeKey(raw)
    if (!key || seen.has(key)) continue
    seen.add(key)
    const atomic = isAtomicTag(raw, key, catalogKeys)
    // Historical exactTokens can include garments. A reliable clothing tag is
    // still transferable when supplied in the caller's character-name inventory.
    if (atomic && (isGarmentToken(key) || ACCESSORY_RE.test(key))) {
      result.tags.push(key)
    } else if (knownCharacters.has(key) || characterKeys.has(key)) {
      result.excludedIdentity.push(key)
    } else if (!atomic) {
      result.uncertain.push(raw)
    } else if (isStableIdentityToken(key)) {
      result.excludedIdentity.push(key)
    } else if ((bodyKeys.has(key) || /(?:^|_)(?:hair|eyes?|skin|ears?|tails?|wings?|horns?)$/.test(key))
      && !TEMPORARY_BODY_STATE_RE.test(key) && !CLOSED_EYES_TOKENS.has(key) && !GAZE_AND_EYE_DETAIL_TOKENS.has(key)) {
      // Body also contains clothing exposure and transient physical states.
      // Its category alone cannot establish a permanent identity feature.
      result.uncertain.push(raw)
    } else {
      result.tags.push(key)
    }
  }
  return result
}
