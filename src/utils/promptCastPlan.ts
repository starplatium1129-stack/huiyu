import { CHAR_PROMPT, STUDIO_PROMPT_SUBJECTS } from '../config/promptConstants.ts'
import type { PopularCharacter } from '../types/character'
import type { CastFormation, CastMember, PromptPlan } from '../types/prompt'
import { tagKey } from './animaPromptOrder.ts'
import { CANONICAL_OUTFITS } from './canonicalOutfits.ts'
import { isReferenceWardrobeTag, isStableIdentityToken, splitReferenceTags } from './interrogateReference.ts'
import { cleanMossReferenceProse } from './mossCast.ts'
import { defaultOutfit, findOutfit } from './popularContent.ts'
import { isOutfitToken, standaloneIdentityProse, standaloneIdentityTokens } from './popularIdentity.ts'
import type { DraftOutfitOverride, DraftReferenceInput } from './promptBuilderPersistence'
import { cleanCastNegative, cleanCastProse, isCastCountTag, isCustomCastOutfit, parseLeadPosition, referenceCharacterCount } from './promptCast.ts'
import { normalizeKey, splitBreaks, tokenize } from './promptPrimitives.ts'
import { studioSubjectProse } from './studioPromptBuilder.ts'
import { wardrobeProse } from './wardrobeContent.ts'

const studioDefaults = { nene: 'neneSchool', natsume: 'natsumeCafe' } as const
const studioNames = { nene: 'Ayachi Nene', natsume: 'Shiki Natsume' } as const
const privateControl = /^(?:nene|natsume)_[a-z\d_]+$/

export function studioCastOutfit(member: CastMember | undefined) {
  if (member?.source !== 'studio' || (member.characterId !== 'nene' && member.characterId !== 'natsume')) return null
  const selected = member.outfitId.startsWith(member.characterId) ? CANONICAL_OUTFITS[member.outfitId as keyof typeof CANONICAL_OUTFITS] : undefined
  return selected ?? CANONICAL_OUTFITS[studioDefaults[member.characterId]]
}

function uniqueTags(tokens: readonly string[]): string[] {
  const seen = new Set<string>()
  return tokens.filter(token => {
    const key = tagKey(token)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function publicTags(tokens: readonly string[]): string[] {
  return tokens.flatMap(token => splitBreaks(token).flatMap(tokenize))
    .filter(token => !privateControl.test(normalizeKey(token)) && !/<lora:/i.test(token) && !isCastCountTag(token))
}

function isWardrobe(token: string): boolean {
  return isReferenceWardrobeTag(token) || isOutfitToken(token)
}

function identityTerms(character: PopularCharacter): string[] {
  return [character.originalName, character.displayName, ...character.aliases,
    ...(character.characterTokens ?? []), ...(character.copyrightTokens ?? [])]
}

export function resolveBoundReference(
  reference: DraftReferenceInput | null, description: string, manual: readonly string[],
  characters: readonly PopularCharacter[], catalog: readonly { en: string; cat: string }[],
) {
  if (reference?.subjectMode !== 'free') return { reference, description, manual: [...manual] }
  const known = [...(reference.characterTokens ?? []), ...(reference.copyrightTokens ?? []),
    ...(reference.sourceIdentityTerms ?? []), ...characters.flatMap(identityTerms), ...Object.values(studioNames)]
  const referenceKeys = new Set(reference.tags.map(normalizeKey))
  const safe = new Set(splitReferenceTags(reference.tags, { knownCharacterTags: known, catalog }).tags.map(normalizeKey))
  const hasMultipleBoxes = referenceCharacterCount(reference.layout) > 1
  const caption = cleanMossReferenceProse(reference.caption ?? '', known, hasMultipleBoxes)
  const layout = reference.layout && {
    ...reference.layout,
    items: reference.layout.items.map(item => item.label !== 'character' ? item : {
      ...item, caption: cleanMossReferenceProse(item.caption, known) || 'A figure in this position.',
    }),
  }
  return {
    reference: { ...reference, caption, captionInEditor: false, layout },
    description: reference.captionInEditor && reference.caption === description.trim() ? '' : description,
    manual: manual.filter(token => !referenceKeys.has(normalizeKey(token)) ||
      (token.startsWith('@') || safe.has(normalizeKey(token)) && (!hasMultipleBoxes || !isWardrobe(token)))),
  }
}

function resolveActor(member: CastMember, characters: readonly PopularCharacter[], override: DraftOutfitOverride | null, inheritReferenceOutfit: boolean) {
  const action = cleanCastProse(member.action ?? '').trim()
  const specialOutfit = isCustomCastOutfit(member.outfitId)
  const outfitPrompt = member.outfitId === 'custom' ? cleanCastProse(member.outfitPrompt ?? '') : ''
  const outfitCaption = outfitPrompt && !/^(?:wears?|wearing|dressed|in)\b/i.test(outfitPrompt) ? `Wearing ${outfitPrompt}` : outfitPrompt
  if (member.source === 'custom') {
    const name = cleanCastProse(member.name ?? '') || 'Original character'
    const appearance = cleanCastProse(member.appearance ?? '')
    const gender = member.gender ?? 'girl'
    return {
      name, characterTokens: [], copyrightTokens: [], aliases: member.name ? [name] : [],
      identity: publicTags([appearance || (gender === 'other' ? 'person' : gender)]), identityCaption: [name, gender === 'other' ? 'person' : gender, appearance].filter(Boolean).join(', '),
      outfit: publicTags([outfitPrompt]), outfitCaption, outfitExplicit: specialOutfit, action, gender,
    }
  }
  if (member.source === 'studio' && (member.characterId === 'nene' || member.characterId === 'natsume')) {
    const id = member.characterId
    const outfit = studioCastOutfit(member)
    const identity = publicTags(tokenize(CHAR_PROMPT[id]))
    const meta = STUDIO_PROMPT_SUBJECTS[id]
    return {
      name: studioNames[id], ...meta, aliases: [studioNames[id], ...identity], identity,
      outfit: publicTags(specialOutfit ? [outfitPrompt] : override?.tokens ?? outfit?.tags ?? []), action, gender: 'girl',
      identityCaption: cleanCastProse(studioSubjectProse(id)),
      outfitCaption: specialOutfit ? outfitCaption : override ? wardrobeProse(override.prose, override.tokens) : outfit?.prose ?? '',
      outfitExplicit: specialOutfit || Boolean(override) || member.outfitExplicit === true,
    }
  }
  const character = characters.find(item => item.id === member.characterId)
  if (!character) return null
  const outfit = findOutfit(character, member.outfitId) ?? defaultOutfit(character)
  const identityOutfit = !specialOutfit && (!inheritReferenceOutfit || member.outfitExplicit) ? outfit : null
  const identityProse = standaloneIdentityProse(character)
  const characterTokens = character.characterTokens?.length ? character.characterTokens : character.exactTokens.slice(0, 1)
  const copyrightTokens = character.copyrightTokens ?? []
  const identity = publicTags(standaloneIdentityTokens(identityOutfit?.identityTokensOverride?.length
    ? identityOutfit.identityTokensOverride : character.identityTokens)).filter(token => !isWardrobe(token))
  const gender = character.identityTokens.map(normalizeKey).some(token => /^(?:1_?boy|male|man|male_focus)$/.test(token)) ? 'boy'
    : character.identityTokens.map(normalizeKey).some(token => /^(?:1_?girl|female|woman)$/.test(token)) || !/\bnon[- ]binary\b/i.test(identityProse) ? 'girl' : 'other'
  const name = identityProse.split(/\s+from\s+|,/i)[0]
  const variant = identityOutfit?.identityProseOverride
  return {
    name, characterTokens, copyrightTokens,
    aliases: identityTerms(character), identity, action, gender,
    identityCaption: cleanCastProse(variant ? `${name}, ${variant}` : identityProse),
    outfit: publicTags(specialOutfit ? [outfitPrompt] : override?.tokens ?? outfit.tokens),
    outfitCaption: specialOutfit ? outfitCaption : override ? wardrobeProse(override.prose, override.tokens) : outfit.prose,
    outfitExplicit: specialOutfit || Boolean(override) || member.outfitExplicit === true,
  }
}

export function buildCastPlan(
  base: PromptPlan, engine: 'moss' | 'anima', cast: readonly CastMember[], leadPosition: number, formation: CastFormation,
  characters: readonly PopularCharacter[], reference: DraftReferenceInput | null,
  outfitOverride: DraftOutfitOverride | null, description: string, castInteraction: string,
): PromptPlan {
  const layout = reference?.layout
  const boxes = referenceCharacterCount(layout)
  const lead = parseLeadPosition(leadPosition, cast.length - 1)
  const actors = cast.map((member, index) => resolveActor(member, characters,
    index === lead && outfitOverride?.presetId ? outfitOverride : null, engine === 'moss' && boxes >= cast.length))
    .filter(actor => actor !== null)
  if (!actors.length) return base
  const interaction = actors.length > 1 ? cleanCastProse(castInteraction) : ''
  const characterTokens = uniqueTags(actors.flatMap(actor => actor.characterTokens))
  const copyrightTokens = uniqueTags(actors.flatMap(actor => actor.copyrightTokens))
  const namesAndTraits = uniqueTags([...actors.flatMap(actor => actor.aliases), ...characterTokens, ...copyrightTokens,
    ...(reference?.characterTokens ?? []), ...(reference?.copyrightTokens ?? []), ...(reference?.sourceIdentityTerms ?? [])])
  const localKeys = new Set([...namesAndTraits, ...actors.flatMap(actor => [...actor.identity, ...actor.outfit])].map(tagKey))
  const sharedTags = (tags: readonly string[]) => publicTags(tags)
    .filter(token => !localKeys.has(tagKey(token)) && !isWardrobe(token) && !isStableIdentityToken(token))
  const counts = ['girl', 'boy', 'other'].flatMap(gender => {
    const count = actors.filter(actor => actor.gender === gender).length
    return count ? [`${count}${gender}${count > 1 ? 's' : ''}`] : []
  })
  const scene = base.scene && { ...base.scene, compositionIntent: 'group' as const, animaCaption: '', promptProse: '' }
  const prose = (text: string) => cleanMossReferenceProse(cleanCastProse(text), namesAndTraits, true)
  const useReferenceAtmosphere = Boolean(reference && actors.length > 1 && boxes < actors.length)
  const referenceProse = useReferenceAtmosphere
    ? prose(reference?.caption ?? '').replace(/\b(?:the |a |an )?(?:left |right |front |rear )?(?:subject|character|person|figure|girl|boy|woman|man)s?\s+(?:is |are )?(?:stand(?:s|ing)?|sit(?:s|ting)?|kneel(?:s|ing)?|lie[s]?|lying|lean(?:s|ing)?|poses?|posing)(?:\s+[a-z-]+ly)?\s+(?=(?:in|on|at|by|near|under|beside|against)\b)/gi, 'The scene is ')
    : prose(reference?.caption ?? '')
  const sourceSceneProse = base.sceneProse || base.scene?.animaCaption || base.scene?.promptProse || ''
  const sceneProse = reference?.caption && sourceSceneProse === reference.caption ? referenceProse : prose(sourceSceneProse)
  const common: PromptPlan = {
    ...base, scene, characterTokens, copyrightTokens, freeSubject: false,
    quality: base.quality.filter(token => tagKey(token) !== 'fair skin' || !actors.some(actor =>
      actor.identity.some(trait => /^(?:dark|tanned|brown|colored) skin/.test(tagKey(trait))))),
    identity: engine === 'anima' ? [...counts, ...characterTokens] : counts,
    exactControls: sharedTags(base.exactControls), preserveTokens: [],
    sceneVisualFragments: sharedTags(base.sceneVisualFragments), manual: sharedTags(base.manual),
    emotion: sharedTags(base.emotion), composition: sharedTags(base.composition),
    camera: sharedTags(base.camera), lighting: sharedTags(base.lighting), palette: sharedTags(base.palette),
    negative: tokenize(cleanCastNegative(base.negative.join(', '))),
    subjectProse: '', outfitProse: '',
    sceneProse, visualDescription: cleanCastProse(description),
  }
  if (engine === 'moss') return {
    ...common,
    mossLayout: {
      compositionIntent: actors.length > 1 ? 'group' : 'single', castLayout: true, formation, interaction, referenceIdentityTerms: namesAndTraits,
      subjects: actors.map(actor => {
        const { identityCaption, outfitCaption, outfitExplicit, action } = actor
        return {
          caption: [identityCaption, outfitCaption, action].filter(Boolean).join('. '),
          identityCaption, outfitCaption, outfitExplicit, action,
        }
      }),
      ...(layout ? { referenceLayout: { layout, boundSubject: true } } : {}),
    },
  }
  const grammar = actors.map(actor => [actor.name, actor.action].filter(Boolean).join(' — ')).join('; ')
  return {
    ...common,
    sceneProse: [...new Set([sceneProse, referenceProse].filter(Boolean))].join(' '),
    animaCast: {
      tags: actors.map(actor => [...actor.identity.filter(token => !characterTokens.some(name => tagKey(name) === tagKey(token))
        && !copyrightTokens.some(work => tagKey(work) === tagKey(token))), ...actor.outfit, ...publicTags([actor.action])]),
      direction: [
        actors.length > 1 ? `From left to right: ${grammar.replace(/[.!?]+$/, '')}.` : cast[0]?.source === 'custom' && cast[0].name ? `The character is ${actors[0].name}.` : '',
        interaction,
      ].filter(Boolean).join('\n'),
    },
  }
}
