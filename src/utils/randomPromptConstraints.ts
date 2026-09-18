import { normalizeKey, tokenize, mutualGroupWithCategory } from './promptPolicy.ts'

/** Split bundles before comparison so an identity/footwear token cannot hide after a comma. */
export function randomTokens(value: string): string[] {
  return tokenize(value).map(token => token.trim().replace(/\s+/g, '_')).filter(Boolean)
}

export function visibleInRandomShot(token: string, shot: string | null): boolean {
  if (shot !== 'close' && shot !== 'detail') return true
  // The generic detail option has no body-part target. Keep random details
  // conservative; explicit user-selected close-ups are not changed here.
  const key = normalizeKey(token)
  return !/(?:^|_)(?:boots?|shoes?|sneakers?|heels?|sandals?|socks?|stockings?|thighhighs|thigh_highs|tabi|legwear|feet|legs)(?:_|$)/.test(key)
    && !['barefoot', 'bare_feet', 'bare_legs'].includes(key)
}

/** Same-family descriptors compose; only distinct families in one category conflict. */
export function appendRandomTag(target: string[], token: string): void {
  const key = normalizeKey(token)
  if (!key || target.some(item => normalizeKey(item) === key)) return
  const hit = mutualGroupWithCategory(token)
  if (hit) {
    for (let index = target.length - 1; index >= 0; index -= 1) {
      const other = mutualGroupWithCategory(target[index])
      if (other?.category === hit.category && other.group !== hit.group) target.splice(index, 1)
    }
  }
  target.push(token)
}

/** Extra catalog details complement, rather than replace, the primary controls.
 * Unknown additions require a reviewed rule instead of silently becoming eligible.
 */
export function compatibleRandomDetail(token: string, category: 'Lighting' | 'Camera', shot: string | null, lighting: string | null): boolean {
  const key = normalizeKey(token)
  if (category === 'Lighting') {
    if (['rim_lighting', 'soft_shadows', 'diffused_light'].includes(key)) return true
    if (['dappled_light', 'sunbeam', 'volumetric_lighting', 'lens_flare'].includes(key)) return lighting === 'golden' || lighting === 'window'
    if (['screen_glow', 'firelight', 'neon_lights'].includes(key)) return lighting === null || lighting === 'lantern'
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
