import { normalizeKey, tokenize, mutualGroupWithCategory } from './promptPolicy.ts'

/** Split bundles before comparison so an identity/footwear token cannot hide after a comma. */
export function randomTokens(value: string): string[] {
  return tokenize(value).map(token => token.trim().replace(/\s+/g, '_')).filter(Boolean)
}

export function visibleInRandomShot(token: string, shot: string | null): boolean {
  if (shot !== 'close' && shot !== 'detail' && shot !== 'medium') return true
  // The generic detail option has no body-part target. Keep random details
  // conservative; explicit user-selected close-ups are not changed here.
  const key = normalizeKey(token)
  return !/(?:^|_)(?:boots?|shoes?|sneakers?|heels?|sandals?|socks?|stockings?|thighhighs|thigh_highs|tabi|legwear|feet|legs|kneehighs|pantyhose)(?:_|$)/.test(key)
    && !['barefoot', 'footjob'].includes(key)
    && (shot === 'medium' || !['walking', 'running', 'jumping', 'on_desk', 'on_floor', 'sitting_on_sofa'].includes(key))
}

/** Earlier choices and authored facts own their slots. Later details cannot evict them. */
export function fitsRandomFacts(token: string, facts: readonly string[]): boolean {
  const hit = mutualGroupWithCategory(token)
  return !hit || !facts.some(fact => {
    const other = mutualGroupWithCategory(fact)
    return other?.category === hit.category && other.group !== hit.group
  })
}

/** Clothing selected as the everyday outfit should fit the place and weather. */
export function outfitFitsSetting(tokens: readonly string[], location: string | undefined, settingTags: readonly string[]): boolean {
  if (!location) return true
  const clothing = tokens.map(normalizeKey).join(' ')
  if (/swimsuit|swimwear|bikini|monokini/.test(clothing)) return ['beach', 'pool', 'onsen'].includes(location)
  if (/pajamas|sleepwear|nightgown/.test(clothing)) return ['bedroom', 'living_room', 'hotel_room'].includes(location)
  if (settingTags.includes('snow')) return /coat|jacket|sweater|hoodie|winter|cardigan/.test(clothing)
  return true
}

/** Extra catalog details complement, rather than replace, the primary controls.
 * Unknown additions require a reviewed rule instead of silently becoming eligible.
 */
export function compatibleRandomDetail(token: string, category: 'Lighting' | 'Camera', shot: string | null, lighting: string | null,
  diffuse: boolean): boolean {
  const key = normalizeKey(token)
  if (category === 'Lighting') {
    if (['rim_lighting', 'soft_shadows', 'diffused_light'].includes(key)) return true
    if (['dappled_light', 'sunbeam', 'volumetric_lighting', 'lens_flare'].includes(key)) return !diffuse && (lighting === 'golden' || lighting === 'window')
    return false
  }
  if (key === 'macro_shot') return shot === 'detail'
  if (['low_angle', 'from_below'].includes(key)) return shot === 'low'
  if (['high_angle', 'from_above'].includes(key)) return shot === 'high'
  if (key === 'three_quarter_view') return ['close', 'medium', 'wide'].includes(shot ?? '')
  if (key === 'dutch_angle') return shot !== 'detail'
  if (['depth_of_field', 'blurry_background', 'cinematic_composition'].includes(key)) return true
  return false
}
