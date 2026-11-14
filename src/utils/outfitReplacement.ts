import type { Scene } from '../types/scene'
import type { DraftOutfitOverride } from './promptBuilderPersistence'
import { OUTFIT_BUNDLES } from '../composables/scene/useDirectorCatalog.ts'
import { UNIVERSAL_WARDROBE_PRESETS } from '../config/universalWardrobe.ts'
import { CANONICAL_OUTFITS } from './canonicalOutfits.ts'
import { isGarmentToken, isOutfitToken } from './popularIdentity.ts'
import { normalizeKey, splitBreaks, tokenize } from './promptPolicy.ts'
import { isWardrobeContextTag, wardrobeTokens } from './wardrobeContent.ts'

/** Keep previous hand-picked clothing available when the replacement is removed. */
export function suppressedOutfitTags(tags: Iterable<string>): string[] {
  const values = [...tags], keys = new Set(values.map(normalizeKey))
  const bundles = [...OUTFIT_BUNDLES, ...UNIVERSAL_WARDROBE_PRESETS]
  const bundled = new Set(bundles.filter(bundle => bundle.tags.length && bundle.tags.every(tag => keys.has(normalizeKey(tag))))
    .flatMap(bundle => bundle.tags).map(normalizeKey))
  return values.filter(tag => !isWardrobeContextTag(tag) && (isOutfitToken(tag) || bundled.has(normalizeKey(tag))))
}

export function withoutSuppressedOutfitTags(tags: Iterable<string>, override?: DraftOutfitOverride | null): string[] {
  const suppressed = new Set(wardrobeTokens(override?.suppressedTags ?? []).map(normalizeKey))
  return [...tags].filter(tag => !suppressed.has(normalizeKey(tag)))
}

/** Replace worn-garment references while retaining the scene's action and setting. */
export function sceneProseWithChangedOutfit(prose: string, source: { tokens: readonly string[]; prose: string }, clothed = false): string {
  const words = [...source.tokens, source.prose].flatMap(value =>
    value.toLowerCase().replace(/[_-]/g, ' ').match(/[a-z]+/g) || [])
  const garments = new Set(words.filter(isGarmentToken))
  if (words.some(word => ['nightdress', 'nightgown', 'negligee', 'lingerie', 'babydoll'].includes(word))) {
    for (const word of ['nightdress', 'nightgown', 'negligee', 'lingerie', 'babydoll']) garments.add(word)
  }
  const excluded = 'a|an|the|and|or|with|while|before|after|near|beside|under|on|at|in|of|to|for|by|she|he|they|her|his|their|hand|hands|arm|arms|is|are|was|were|sits|stands|sitting|standing|lying|holds|holding|leans|reclines|wears'
  const modifier = `(?!(?:${excluded})\\b)[a-z]+(?:-[a-z]+)?`
  let result = prose
  if (garments.size) {
    const pattern = new RegExp(`\\b(wearing|dressed in|clad in|in)\\s+(?:(?:a|an|the|her|his|their)\\s+)?(?:${modifier}\\s+){0,4}(?:${[...garments].join('|')})\\b(?!\\s+(?:shop|store|rack|display)\\b)`, 'gi')
    const possessive = new RegExp(`\\b(her|his|their)\\s+(?:${modifier}\\s+){0,4}(?:${[...garments].join('|')})\\b`, 'gi')
    result = result.replace(pattern, (_match, verb: string) => `${verb} the selected outfit`)
      .replace(possessive, (_match, owner: string) => `${owner} selected outfit`)
  }
  return clothed ? result.replace(/\b(is|are|was|were|sits|sitting|stands|standing|lies|lying|reclines|reclining)\s+(?:(?:fully|completely|entirely|totally)\s+)?(?:nude|naked)\b/gi, '$1 in the selected outfit') : result
}

/** Derive a temporary scene; source catalogue records remain untouched. */
export function studioSceneWithOutfit(scene: Scene | null, sourceControls: readonly string[], selected: readonly string[]): Scene | null {
  if (!scene) return null
  const sections = splitBreaks((scene.prompt || '').replace(/_BREAK_/g, ' BREAK ')).map(tokenize)
  const trained = new Set(Object.values(CANONICAL_OUTFITS).map(outfit => normalizeKey(outfit.tags[0])))
  const controls = new Set(wardrobeTokens(sourceControls).map(normalizeKey).filter(key => !/^(?:(?:nene|natsume)_r18|twin_braids)$/.test(key)))
  const isOldOutfit = (tag: string) => !isWardrobeContextTag(tag)
    && (isOutfitToken(tag) || trained.has(normalizeKey(tag)) || controls.has(normalizeKey(tag)))
  const source = { tokens: [...sections.flat(), ...sourceControls], prose: '' }
  const clothed = selected.some(isGarmentToken) && !selected.some(tag => /^(?:nude|naked|fully_nude|completely_nude|no_clothes|unclothed)$/.test(normalizeKey(tag)))
  const replace = (value?: string) => value ? sceneProseWithChangedOutfit(value, source, clothed) : value
  return { ...scene, prompt: sections.map(tokens => tokens.filter(tag => !isOldOutfit(tag)).join(', ')).filter(Boolean).join(' BREAK '),
    animaCaption: replace(scene.animaCaption), promptProse: replace(scene.promptProse),
    identityTokensOverride: scene.identityTokensOverride?.filter(tag => !isOldOutfit(tag)),
    identityProseOverride: replace(scene.identityProseOverride) }
}
