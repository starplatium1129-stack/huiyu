import type { PopularCharacter } from '../types/character'
import { mutualGroupWithCategory } from './promptPolicy.ts'
import { normalizeProseKey, proseToken } from './promptPhraseTables.ts'

// Garments belong to the selected outfit or reference, not permanent identity.
const GARMENT_TOKEN_RE =
  /^(?:[a-z0-9]+_)*(?:clothes|clothing|outfit|costume|coat|overcoat|trench_coat|jacket|dress|sundress|skirt|miniskirt|shirt|blouse|pants|trousers|jeans|shorts|hotpants|crop_top|tank_top|bodysuit|leotard|corset|bra|panties|underwear|boots|shoes|heels|sneakers|sandals|socks|tights|pantyhose|stockings|leggings|thighhighs|thigh_highs|over_knee_socks|knee_socks|uniform|serafuku|suit|robe|cloak|cape|capelet|hoodie|sweater|cardigan|vest|apron|kimono|yukata|qipao|cheongsam|swimsuit|swimwear|bikini|pajamas|sleepwear|nightgown|lingerie|gloves|scarf|necktie|belt|hat|helmet|armor|footwear|headdress)$/

export function isGarmentToken(token: string): boolean {
  return GARMENT_TOKEN_RE.test(String(token || '').trim().toLowerCase())
}

const EXPRESSION_RE = /(?:^|_)(?:smile|smiling|blush|blushing|expressionless|expression|crying|tears|teary|sad|happy|angry|shy|pout|pouting)(?:_|$)/
const DIRECTION_RE = /^(?:looking|standing|sitting|lying|kneeling|squatting|holding|carrying|walking|running|leaning|peace_sign|v_sign|closed_eyes|open_mouth|closed_mouth|close_up|medium_shot|wide_shot|full_body|upper_body|cowboy_shot|pov|depth_of_field|bokeh)(?:_|$)/
const SETTING_RE = /(?:^|_)(?:background|backdrop|lighting|sunlight|moonlight|sunset|sunrise|beach|library|classroom|bedroom|forest|sky|scenery)(?:_|$)/

/** A selected character supplies stable features; references own scene and performance. */
export function standaloneIdentityTokens(tokens: readonly string[]): string[] {
  return tokens.filter(token => {
    const key = normalizeProseKey(token)
    return !isGarmentToken(key) && !mutualGroupWithCategory(key)
      && !EXPRESSION_RE.test(key) && !DIRECTION_RE.test(key) && !SETTING_RE.test(key)
  })
}

/** Reuse the structured visual identity instead of attempting to edit free-form role prose. */
export function standaloneIdentityProse(character: PopularCharacter): string {
  const name = character.identityProse.match(/^(.+?)(?:\s+from\s+|,)/i)?.[1]
    || character.originalName
  const names = new Set([
    character.id, character.originalName, name, character.franchise,
    ...character.aliases, ...character.exactTokens,
  ].map(normalizeProseKey))
  const avoided = new Set((character.dnaLock?.avoid ?? []).map(normalizeProseKey))
  const traits = standaloneIdentityTokens(character.identityTokens)
    .filter(token => {
      const key = normalizeProseKey(token)
      return !names.has(key) && !avoided.has(key) && !/^(?:\d+girls?|\d+boys?|solo)$/.test(key)
    })
    .map(proseToken).filter(Boolean)
  return `${name} from ${character.franchise}, the only character in the image${traits.length ? `, with ${[...new Set(traits)].join(', ')}` : ''}`
}
