import type { PromptPlan } from '../types/prompt'
import { tagKey } from './animaPromptOrder.ts'
import { isReferenceWardrobeTag, isStableIdentityToken, splitReferenceTags } from './interrogateReference.ts'
import { isOutfitToken } from './popularIdentity.ts'
import type { DraftReferenceInput } from './promptBuilderPersistence'
import { cleanCastProse, isCastCountTag } from './promptCast.ts'
import { normalizeKey } from './promptPrimitives.ts'
import { mossCastBoxes, mossNormalizedBox, type MossCanvasSize, type MossLayoutItem } from './mossLayout.ts'

type CastLayout = NonNullable<PromptPlan['mossLayout']>
type CastSubject = NonNullable<CastLayout['subjects']>[number]
type ReferenceItem = NonNullable<CastLayout['referenceLayout']>['layout']['items'][number]
type UnitBox = [number, number, number, number]

const adjective = 'very|extremely|light|dark|bright|pale|deep|long|short|medium|shoulder.length|waist.length|wavy|straight|curly|braided|flowing|silky|fluffy|spiky|tousled|twin|jet|platinum|golden|blond[e]?|black|white|brown|red|pink|blue|silver|purple|orange|green|grey|gray|auburn|violet|lavender|teal|cyan|aqua|turquoise|multicolored|amber|hazel|tan|tanned|fair|olive'
const appearance = new RegExp(
  '\\b(?:(?:' + adjective + ')(?:[, _-]+)){1,6}(?:hair|eyes|skin|braids?|ponytails?|pigtails?|bangs)\\b(?![ _-]+(?:ribbon|clip|band|flower|ornament|tie)\\b)'
  + '|\\b(?:blond[e]?|brunette|redheaded|fair.skinned|dark.skinned|(?:' + adjective + ')[ _-](?:haired|eyed))\\b'
  + '|\\b(?:hime.cut|bob.cut|pigtails?|ponytails?|twintails?|freckles|heterochromia|ahoge|horns?|halos?|(?:fox|cat|wolf|elf|rabbit|animal|pointed) ears|(?:fluffy|cat|fox|devil) tail|(?:angel|feathered|bat|demon) wings)\\b',
  'gi',
)
const bareSubject = /^(?:(?:the |a |an |another )?(?:(?:left|right|central|center|rear|front|foreground|background|distant|near|far) )*(?:character|subject|person|figure|woman|man|girl|boy)s?|she|he|they|both|each)(?:[.!?;]+|$)/i
const clothingDetail = /^(?:sleeves?|cuffs?|collars?|lapels?|hemlines?|garters?|thongs?|slippers?|loafers?|sleeveless|nightdress|babydoll|towels?|habits?|veils?|monokinis?|sarongs?|overskirts?|tunics?|chokers?|lingerie|swimwear|bottoms|tops|straps?|piping|frills?|ruffles?|sashes?|obis?|bodices?|bustiers?|shawls?|ponchos?|wraps?)$/
const compoundWrap = /\b(?:towel|sheet|blanket|robe|cloak|apron|bikini|swimsuit|kimono|silk|lace|leather|lightly|scantily|half|barely)[ -](?:wrapped|clad|draped|dressed)\b/gi
const wearingFallback = /\b(?:(?:is|are|was|were)\s+)?(?:wears?|wearing|dressed in|clad in|outfitted in|wrapped in|draped in)\s+[^.;!?]+/gi
const afterClothing = /(?:\s+(?:while|beside|near|next to|in front of|at (?:a|an|the))\s+|\s*,\s*(?:holding|standing|sitting|seated|leaning|walking|looking|smiling|laughing|glancing|resting|bracing|raising|reaching|kneeling|lying|turning|turned|wading)\b)/i

const referenceSubjectClause = /^(?:(?:in|on|at|to|near|beside|behind|farther|further)\s+(?:the\s+)?(?:left|right|center|central|front|rear|back|foreground|background)(?:\s+(?:foreground|background|side|edge|corner|third|half))?\s*,?\s*)?(?:(?:the|a|an|another|first|second|third|left|right|central|front|rear|foreground|background|one|two|three|four|five|adult|young|tall|short)\s+)*(?:she|he|they|her|his|their|subject|character|figure|person|people|girl|boy|woman|man|women|men)s?\b/i
const referenceActionClause = /^(?:stand(?:s|ing)?|sit(?:s|ting)?|seated|lying|lies|kneel(?:s|ing)?|crouch(?:es|ing)?|squat(?:s|ting)?|lean(?:s|ing)?|hold(?:s|ing)?|carrying|looking|gazing|glancing|facing|eye contact|walk(?:s|ing)?|running|smil(?:e|es|ing)|laugh(?:s|ing)?|blush(?:es|ing)?|grin(?:s|ning)?|waving|hug(?:s|ging)?|kiss(?:es|ing)?|embrac(?:es?|ing)|reaching|crossed|wading|partially submerged|resting|braced|raised|turned|dangling|bent legs|hands?|arms?)\b/i
const referenceBodyOrTraitRe = /\b(?:breasts?|chest|cleavage|thighs?|ass|butt|hips?|waist|stomach|navel|collarbone|shoulders?|armpits?|nipples?|pussy|penis|nails?|nail polish|fingernails?|fang|mole|blush|sweat|eyebrows?|pupils?|lips?|mouth|nose|cheeks?|face|eyes?|hair|bangs|skin|complexion|legs?|feet|toes|fingers?)\b/i
const referenceExpressionOrPoseTag = /^(?:smile|smiling|open_mouth|closed_mouth|parted_lips|closed_eyes|one_eye_closed|wink|grin|laughing|blush|blushing|frown|pout|crying|tears|expressionless|looking_at_viewer|looking_back|looking_away|looking_to_the_side|looking_up|looking_down|looking_at_another|eye_contact|sitting|standing|lying|kneeling|crouching|squatting|leaning|leaning_forward|wading|partially_submerged|arms_crossed|crossed_arms|hand_up|hand_on_own_face|hand_on_hip|peace_sign|v_sign|waving|turning_around|from_behind|back_turned|dangling_legs)$/
const referenceCameraCue = /\b(?:close[ -]up|upper body|full body|wide[ -]angle|(?:wide|medium|cowboy|long|water[ -]level) shot|water[ -]level view|camera|framing|depth of field|(?:high|low|dutch|slightly tilted) angle|slightly tilted|from (?:above|below|behind|the side)|point of view|pov)\b/i
const referencePlaceCue = /\b(?:at|in|on|by|near|beside|across|through|under|beneath|against|amid|outside|inside)\s+(?:(?:a|an|the)\s+|(?:(?:sunlit|bright|soft|warm|cool|dim|neon|morning|afternoon|evening|pale|hazy|clear|turquoise|rippling|wet)\s+){0,4}(?:pool|water|beach|ocean|sea|room|bedroom|kitchen|cafe|classroom|library|street|city|skyline|park|forest|garden|church|window|railing|sunlight|moonlight|daylight|rain|snow|mist|light|glow)\b)/i

export function cleanMossCastText(value: string): string {
  return value.replace(/<lora:[^>]+>/gi, '').replace(/\b(?:nene|natsume)_[a-z0-9_]+\b/gi, '')
    .replace(/\bBREAK\b/g, ', ').trim()
}

export function formatCastOutfitClause(outfitCaption: string): string {
  const cleaned = cleanCastProse(cleanMossCastText(outfitCaption)).replace(/[.!?]+$/, '').trim()
  if (!cleaned || /^(?:none|n\/?a|unknown|unclear|unavailable|unspecified|out of frame|no visible clothing|(?:clothing (?:is )?)?not (?:clearly )?(?:visible|specified|shown|discernible))$/i.test(cleaned)) return ''
  if (/^(?:wears?|is wearing)\s+/i.test(cleaned)) return cleaned.replace(/^(?:wears?|is wearing)\s+/i, 'wearing ')
  if (/^(?:wearing|dressed|clad|wrapped|draped|in\s+(?:a|an|the)|without (?:any )?clothes|(?:(?:fully|completely|entirely|totally) )?(?:nude|naked|topless|bottomless|unclothed|shirtless))\b/i.test(cleaned)) {
    return cleaned.charAt(0).toLowerCase() + cleaned.slice(1)
  }
  const lowered = /^(?:A|An|The)\s+/.test(cleaned) ? cleaned.charAt(0).toLowerCase() + cleaned.slice(1) : cleaned
  return `wearing ${lowered}`
}

export function isPerCharacterReferenceTag(token: string): boolean {
  const key = normalizeKey(token)
  if (!key) return true
  if (isReferenceWardrobeTag(key) || isOutfitToken(key) || isStableIdentityToken(key)) return true
  if (referenceExpressionOrPoseTag.test(key)) return true
  if (referenceBodyOrTraitRe.test(key.replace(/_/g, ' ')) && !referenceCameraCue.test(key.replace(/_/g, ' '))) return true
  return false
}

function withoutReferenceClothes(value: string): string {
  const nouns = [...new Set((value.toLowerCase().match(/[a-z]+/g) ?? []).filter(word =>
    isOutfitToken(word) || isOutfitToken(word.replace(/s$/, '')) || clothingDetail.test(word)))]
  const states = /\b(?:(?:(?:fully|completely|entirely|totally)\s+)?(?:nude|naked|unclothed|topless|bottomless|shirtless)|without (?:any )?clothes)\b/gi
  value = value.replace(states, '').replace(compoundWrap, '')
  if (nouns.length > 0) {
    const stopWords = 'a|an|the|her|their|his|while|as|before|after|by|from|at|near|beside|in|on|over|under|with|or|that|who|holds?|holding|standing|stands?|sitting|sits?|seated|kneels?|kneeling|lies|lying|leans?|leaning|reclining|reclines?|reaches?|reaching|smiles?|smiling|laughs?|laughing|looks?|looking|glances?|glancing|walks?|walking|runs?|running|poses?|posing|turned|turning'
    const modifier = '(?!(?:' + stopWords + ')\\b)[a-z]+(?:-[a-z]+)*'
    const garment = '(?:(?:a|an|the|her|his|their)\\s+)?(?:' + modifier + '\\s+){0,6}(?:' + nouns.join('|') + ')\\b(?!\\s+(?:shop|store|rack|display|ring|float)\\b)'
    const list = garment + '(?:(?:\\s*,\\s*(?:and\\s+)?|\\s+(?:and|with|over|under)\\s+)' + garment + ')*'
    const worn = new RegExp('\\b(?:(?:(?:is|are|was|were)\\s+)?(?:wears?|wearing|dressed in|clad in|outfitted in|wrapped in|draped in)|has|have|in|with)\\s+' + list, 'gi')
    const possessed = new RegExp('\\b(her|his|their)\\s+' + garment, 'gi')
    const fragment = new RegExp('(^|[,;]\\s*)(?:and\\s+)?' + list + '(?=\\s*[,;.!?]|\\s*$)', 'gi')
    value = value.replace(worn, '').replace(possessed, '$1 outfit').replace(fragment, '$1')
  }
  return value.replace(wearingFallback, clause => {
    const rest = clause.match(afterClothing)
    return rest?.index !== undefined ? clause.slice(rest.index) : ''
  })
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

/** Multi-character summary projection: keep shared environment, lighting and camera; drop per-character clauses. */
export function cleanCastReferenceSceneProse(value: string, identityTerms: readonly string[] = []): string {
  const cleaned = cleanCastProse(cleanMossReferenceProse(value, identityTerms, true))
  if (!cleaned) return ''
  const kept: string[] = []
  for (const rawSentence of cleaned.split(/(?<=[.!?])\s+/)) {
    const body = rawSentence.replace(/[.!?]+$/, '').trim()
    if (!body) continue
    const clauses = body.split(/;\s*/).flatMap(semi => {
      const parts = semi.split(/,\s*/).map(part => part.trim()).filter(Boolean)
      const safe: string[] = []
      for (const part of parts) {
        const hasChar = referenceSubjectClause.test(part) || referenceActionClause.test(part)
          || /\b(?:character|subject|figure|person|girl|boy|woman|man)s?\b/i.test(part)
        const hasBody = referenceBodyOrTraitRe.test(part)
        const hasWrap = compoundWrap.test(part) || /\b(?:towel|bikini|swimsuit|lingerie|habit|veil)\b/i.test(part)
        compoundWrap.lastIndex = 0
        if (!hasChar && !hasBody && !hasWrap) {
          safe.push(part)
          continue
        }
        const cam = !hasBody && !hasWrap ? part.match(referenceCameraCue)?.[0] : undefined
        const place = !hasBody && !hasWrap ? part.match(referencePlaceCue)?.[0] : undefined
        if (cam && place) safe.push(`${cam} ${place}`)
        else if (cam) safe.push(cam)
        else if (place) safe.push(place)
      }
      const joined = safe.join(', ').trim()
      return joined && /\p{L}/u.test(joined) ? [joined] : []
    })
    if (clauses.length) {
      const sentence = clauses.join('; ').replace(/^[a-z]/, c => c.toUpperCase())
      kept.push(/[.!?]$/.test(sentence) ? sentence : `${sentence}.`)
    }
  }
  return kept.join(' ')
}

function stripLeadingReferenceSubject(caption: string): string {
  let text = caption.trim()
  if (!text) return ''
  // "Towel-wrapped character seated..." -> "wrapped in a towel, seated..."
  text = text.replace(/^(?:the |a |an )?(?:(?:foreground|background|left|right|central|center|front|rear|far|near) )*([a-z]+)-wrapped\s+(?:character|subject|person|figure|woman|man|girl|boy)\b[,]?\s*/i, 'wrapped in a $1, ')
  text = text.replace(/^(?:the |a |an )?(?:(?:foreground|background|left|right|central|center|front|rear|far|near) )*([a-z]+)-clad\s+(?:character|subject|person|figure|woman|man|girl|boy)\b[,]?\s*/i, 'in a $1, ')
  text = text.replace(/^(?:the |a |an )?(?:(?:foreground|background|left|right|central|center|front|rear|far|near|seated|standing|leaning|smiling|grinning|laughing) )*(?:character|subject|person|figure|woman|man|girl|boy)\b(?:(?:\s*,\s*)|\s+(?:is|are)\s+|\s+)?/i, '')
  text = text.replace(/([.!?]\s+)(?:the |a |an )?(?:(?:left|right|central|center|foreground|background) )?(?:character|subject|person|figure)\s+/gi, '$1')
  return text.replace(/^[,;\s]+/, '').trim()
}

function extractReferenceOutfitAndPose(raw: string): { outfit: string; pose: string } {
  const text = stripLeadingReferenceSubject(cleanCastProse(cleanMossCastText(raw)))
  if (!text) return { outfit: '', pose: '' }
  const cleanPose = (value: string) => value
    .replace(/[ \t]+/g, ' ').replace(/\s+([,.;!?])/g, '$1')
    .replace(/(?:,\s*){2,}/g, ', ').replace(/,+([.;!?])/g, '$1')
    .replace(/^[\s,.;]+|[\s,;]+$/g, '').trim()

  const verbRe = /(?:^|[,;.]\s*|\s+)(?:(?:is|are)\s+)?((?:wears?|wearing|dressed in|clad in|outfitted in|wrapped in|draped in)\s+[^.!?;]+)/i
  const verbMatch = text.match(verbRe)
  if (verbMatch && verbMatch.index !== undefined) {
    let clause = verbMatch[1].trim()
    let tail = ''
    const rest = clause.match(afterClothing)
    if (rest?.index !== undefined && rest.index > 0) {
      tail = clause.slice(rest.index)
      clause = clause.slice(0, rest.index).trim()
    }
    const before = text.slice(0, verbMatch.index)
    const after = text.slice(verbMatch.index + verbMatch[0].length)
    const leadingSep = verbMatch[0].match(/^[.!?;]/)?.[0] ?? ''
    const pose = cleanPose(`${before}${leadingSep} ${tail} ${after}`)
    return { outfit: formatCastOutfitClause(clause), pose }
  }

  const inRe = /^in\s+((?:a|an|the)\s+[^,.;!?]+?)(?=\s*,\s*|\s+(?:standing|stands?|sitting|sits?|seated|leaning|leans?|lying|lies|kneeling|holding|smiling|laughing|looking|glancing|turning|turned|walking|running|wading|facing|posing|tilting|tilts?)\b|[.!?;]|$)/i
  const inMatch = text.match(inRe)
  if (inMatch && isLegacyWardrobeClause(inMatch[1])) {
    const outfit = formatCastOutfitClause(`wearing ${inMatch[1].trim()}`)
    const pose = cleanPose(text.slice(inMatch[0].length))
    return { outfit, pose }
  }

  const stateRe = /\b((?:(?:fully|completely|entirely|totally)\s+)?(?:nude|naked|unclothed|topless|bottomless|shirtless)|without (?:any )?clothes)\b/i
  const stateMatch = text.match(stateRe)
  if (stateMatch && stateMatch.index !== undefined) {
    const pose = cleanPose(`${text.slice(0, stateMatch.index)} ${text.slice(stateMatch.index + stateMatch[0].length)}`)
    return { outfit: stateMatch[1].trim().toLowerCase(), pose }
  }

  return { outfit: '', pose: text }
}

function isLegacyWardrobeClause(clause: string): boolean {
  if (referenceActionClause.test(clause)) return false
  const wardrobe = normalizeKey(clause.replace(/[.!?]+$/, ''))
  return isOutfitToken(wardrobe) || isReferenceWardrobeTag(wardrobe)
    || (clause.toLowerCase().match(/[a-z]+/g) ?? []).some(word => isOutfitToken(word) || clothingDetail.test(word))
}

function splitLegacyClothing(text: string, outfit = '') {
  const clothing = outfit ? [outfit] : []
  const remaining: string[] = []
  for (const fragment of text.split(/[,;]|(?<=[.!?])\s+/u)) {
    const clause = fragment.trim()
    if (!clause) continue
    if (isLegacyWardrobeClause(clause)) clothing.push(clause.replace(/^(?:and|with)\s+/i, '').replace(/[.!?]+$/, ''))
    else remaining.push(clause)
  }
  return { outfit: formatCastOutfitClause(clothing.join(', ')), pose: remaining.join(', ') }
}

/** Structured clothing and pose can each be absent in saved or newly recognized references. */
export function mossReferencePerformance(item: ReferenceItem, identityTerms: readonly string[] = [], replaceOutfit = false) {
  const extracted = extractReferenceOutfitAndPose(item.caption)
  const legacy = splitLegacyClothing(extracted.pose, extracted.outfit)
  const clothingOnly = (value: string) => formatCastOutfitClause(stripLeadingReferenceSubject(cleanMossReferenceProse(value, identityTerms))
    .split(/[,;]|(?<=[.!?])\s+/u).map(fragment => fragment.trim())
    .filter(fragment => fragment && !referenceActionClause.test(fragment) && !referenceSubjectClause.test(fragment)
      && (isLegacyWardrobeClause(fragment) || !referenceBodyOrTraitRe.test(fragment)))
    .join(', ').replace(/\s+(?:with|and|or)\s*[.!?]?$/i, ''))
  const outfit = replaceOutfit ? '' : clothingOnly(item.clothing ?? '') || clothingOnly(legacy.outfit)
  const structuredPose = splitLegacyClothing(extractReferenceOutfitAndPose(item.pose ?? '').pose).pose
  const pose = cleanMossReferenceProse(structuredPose, identityTerms, true)
    || cleanMossReferenceProse(legacy.pose, identityTerms, true)
  return { outfit, pose: stripLeadingReferenceSubject(pose) }
}

function actorOutfit(subject: CastSubject, inherited = '') {
  return (!subject.outfitExplicit && inherited) || formatCastOutfitClause(subject.outfitCaption ?? '')
}

function area({ bbox: [top, left, bottom, right] }: { bbox: UnitBox }) {
  return Math.max(0, bottom - top) * Math.max(0, right - left)
}

function centerX({ bbox: [, left, , right] }: { bbox: UnitBox }) {
  return (left + right) / 2
}

export function referenceCastPeople(layout: DraftReferenceInput['layout']) {
  return layout?.items.filter(item => item.label === 'character').toSorted((a, b) => centerX(a) - centerX(b)) ?? []
}

export function referenceOutfitText(clothing: string) {
  return clothing.replace(/^wearing\s+/i, '').slice(0, 400).replace(/[,;\s]+$/, '')
}

export function singleReferenceCastOutfit(reference: DraftReferenceInput | null | undefined) {
  if (!reference || (reference.layout && reference.layout.canvas !== 'single')) return ''
  const people = referenceCastPeople(reference.layout)
  if (people.length > 1) return ''
  const person = people[0]
  const clothing = person ? mossReferencePerformance(person, reference.sourceIdentityTerms).outfit : ''
  if (clothing) return referenceOutfitText(clothing)

  const tags = reference.rawTags ?? reference.tags
  const counts = new Set(tags.filter(isCastCountTag).map(tagKey))
  const quantities = [...counts].filter(tag => tag !== 'solo')
  if ((!person && !counts.size) || quantities.length > 1
    || quantities.some(tag => !/^1\s*(?:girl|boy|person|woman|man)$/.test(tag))) return ''
  const garments = splitReferenceTags(tags).tags.filter(isReferenceWardrobeTag).map(tag => tag.replace(/_/g, ' '))
  return referenceOutfitText(garments.join(', '))
}

function spatialSlotLabel(index: number, count: number, box: UnitBox, allBoxes: readonly UnitBox[], formation?: CastLayout['formation'], useReference = false): string {
  if (count <= 1) return ''
  if (!useReference && count >= 4 && formation === 'staggered') {
    if (index === 0) return 'In the front left'
    if (index === 1) return 'In the front right'
    if (count === 4) return index === 2 ? 'In the back left' : 'In the back right'
    return index === 2 ? 'In the back left' : index === 3 ? 'In the back center' : 'In the back right'
  }
  const base = count === 2
    ? (index === 0 ? 'On the left' : 'On the right')
    : count === 3
      ? (index === 0 ? 'On the left' : index === 1 ? 'In the center' : 'On the right')
      : count === 4
        ? ['On the far left', 'In the center-left', 'In the center-right', 'On the far right'][index] ?? 'In the frame'
        : ['On the far left', 'In the left-center', 'In the center', 'In the right-center', 'On the far right'][index] ?? 'In the frame'
  if (!useReference || allBoxes.length < 2) return base
  const myArea = area({ bbox: box })
  const maxArea = Math.max(...allBoxes.map(b => area({ bbox: b })))
  const minArea = Math.min(...allBoxes.map(b => area({ bbox: b })))
  if (maxArea >= minArea * 2.5) {
    if (myArea >= maxArea * 0.72) return `${base} foreground`
    if (myArea <= maxArea * 0.35) return `${base} background`
  }
  return base
}

function conciseActorSummary(subject: CastSubject, slot: string, outfit: string): string {
  const identity = cleanCastProse(cleanMossCastText(subject.identityCaption || subject.caption || ''))
    .replace(/[.!?]+$/, '').trim()
  const name = subject.name?.trim() || identity.split(/\s+from\s+|,/i)[0]?.trim() || 'character'
  const traitMatch = identity.match(/\bwith\s+([^.;]+)/i)?.[1]?.trim()
  const shortTrait = traitMatch ? traitMatch.split(/,\s*/).slice(0, 2).join(', ') : ''
  const who = shortTrait ? `${name} (${shortTrait})` : name
  const slotLower = slot ? `${slot.charAt(0).toLowerCase()}${slot.slice(1)}, ` : ''
  return `${slotLower}${who}${outfit ? ` ${outfit}` : ''}`.trim()
}

function buildActorItemCaption(subject: CastSubject, slot: string, outfit: string, pose = ''): string {
  const identity = cleanCastProse(cleanMossCastText(subject.identityCaption || subject.caption || '')).replace(/[.!?]+$/, '').trim()
  const action = cleanCastProse(cleanMossCastText(subject.action ?? '')).replace(/[.!?]+$/, '').trim()
  const head = [identity, outfit].filter(Boolean).join(', ')
  const sentences: string[] = []
  if (head) {
    const prefixed = slot ? `${slot}: ${head}` : head
    sentences.push(/[.!?]$/.test(prefixed) ? prefixed : `${prefixed}.`)
  }
  if (pose) {
    const normalized = pose.charAt(0).toUpperCase() + pose.slice(1)
    sentences.push(/[.!?]$/.test(normalized) ? normalized : `${normalized}.`)
  }
  if (action) {
    const normalized = action.charAt(0).toUpperCase() + action.slice(1)
    sentences.push(/[.!?]$/.test(normalized) ? normalized : `${normalized}.`)
  }
  return sentences.join(' ') || 'Character in this position.'
}

export function buildMossCastLayout(layout: CastLayout, subjects: readonly CastSubject[], size: MossCanvasSize) {
  const reference = layout.referenceLayout?.layout
  const characters = referenceCastPeople(reference)
  const useReference = characters.length >= subjects.length
  const toLocal = (item: ReferenceItem) => cleanCastProse(cleanMossReferenceProse(item.caption, layout.referenceIdentityTerms))
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
    const targets = new Set(subjects.length === 1
      ? characters.toSorted((a, b) => area(b) - area(a)).slice(0, 1)
      : characters.slice(0, subjects.length))
    const targetBoxes = characters.filter(item => targets.has(item)).map(item => item.bbox)
    let actor = 0
    const summaryEntries: string[] = []
    const items = characters.map(item => {
      if (targets.has(item)) {
        const idx = actor++
        const subject = subjects[idx]
        const slot = spatialSlotLabel(idx, subjects.length, item.bbox, targetBoxes, layout.formation, true)
        const performance = mossReferencePerformance(item, layout.referenceIdentityTerms, subject.outfitExplicit)
        const outfit = actorOutfit(subject, performance.outfit)
        summaryEntries.push(conciseActorSummary(subject, slot, outfit))
        return toItem(item, buildActorItemCaption(subject, slot, outfit, subject.action ? '' : performance.pose))
      }
      const { outfit, pose } = mossReferencePerformance(item, layout.referenceIdentityTerms)
      return toItem(item, [outfit, pose].filter(Boolean).join('. ') || 'Supporting character in this position.')
    })
    const extraPeople = characters.length - subjects.length
    const totalCount = subjects.length + extraPeople
    const castSummary = subjects.length > 1
      ? `Exactly ${totalCount} distinct characters appear in the scene, each keeping their assigned hair, eyes, and outfit: ${summaryEntries.join('; ')}.`
      : ''
    return { items: [...items, ...supplemental], canvas: reference?.canvas ?? 'single', extraPeople, castSummary }
  }

  const boxes = mossCastBoxes(size, subjects.length, layout.formation)
  const unitBoxes: UnitBox[] = boxes.map(([t, l, b, r]) => [
    (t + size.height / 2) / size.height, (l + size.width / 2) / size.width,
    (b + size.height / 2) / size.height, (r + size.width / 2) / size.width,
  ])
  const summaryEntries: string[] = []
  const items = subjects.map((subject, index): MossLayoutItem => {
    const slot = spatialSlotLabel(index, subjects.length, unitBoxes[index], unitBoxes, layout.formation, false)
    const item = characters.length > 1 ? characters[index] : undefined
    const performance = item ? mossReferencePerformance(item, layout.referenceIdentityTerms, subject.outfitExplicit) : undefined
    const outfit = actorOutfit(subject, performance?.outfit)
    summaryEntries.push(conciseActorSummary(subject, slot, outfit))
    return {
      label: 'character',
      caption: buildActorItemCaption(subject, slot, outfit, subject.action ? '' : performance?.pose),
      bbox: boxes[index],
    }
  })
  const castSummary = subjects.length > 1
    ? `Exactly ${subjects.length} distinct characters appear in the scene, each keeping their assigned hair, eyes, and outfit: ${summaryEntries.join('; ')}.`
    : ''
  return { items: [...items, ...supplemental.slice(0, 16 - items.length)], canvas: 'single' as const, extraPeople: 0, castSummary }
}
