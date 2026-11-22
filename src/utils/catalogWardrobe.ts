import { studioOutfitBundle } from '@/composables/scene/useDirectorCatalog'
import type { PopularCharacter } from '@/types/character'
import { isStableIdentityToken } from './interrogateReference'
import { isGarmentToken } from './popularIdentity'
import { normalizeKey } from './promptPolicy'
import { wardrobeProse, wardrobeTokens } from './wardrobeContent'

export interface CatalogWardrobeRecipe {
  id: string
  outfitId: string
  name: string
  sourceId: string
  sourceName: string
  tokens: string[]
  prose: string
  identity: string[]
  searchWords: string[]
}

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export function catalogWardrobe(profiles: readonly Record<string, unknown>[], popular: readonly PopularCharacter[], characterId?: string) {
  const recipes: CatalogWardrobeRecipe[] = []
  for (const profile of profiles) {
    const id = profile.id
    if ((id !== 'nene' && id !== 'natsume') || (characterId && id !== characterId)) continue
    const wardrobe = record(profile.lora) && record(profile.lora.special_outfits) ? profile.lora.special_outfits : {}
    const sourceName = typeof profile.name === 'string' ? profile.name : id
    for (const [outfitId, value] of Object.entries(wardrobe)) {
      const tokens = Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string' && !!tag.trim()) : []
      if (!tokens.length) continue
      const bundle = studioOutfitBundle(id, outfitId)
      const name = bundle?.label.split(' · ').slice(1).join(' · ') || outfitId.replace(/_/g, ' ')
      recipes.push({ id: `studio/${id}/${outfitId}`, outfitId, name, sourceId: id, sourceName, tokens,
        prose: '', identity: [], searchWords: [sourceName, id, outfitId, name, ...tokens] })
    }
  }
  for (const character of popular) {
    if (characterId && character.id !== characterId) continue
    const identity = [...character.identityTokens, ...character.exactTokens, ...(character.characterTokens || []), ...(character.copyrightTokens || [])]
    for (const outfit of character.outfits) {
      recipes.push({ id: `catalog/${character.id}/${outfit.id}`, outfitId: outfit.id, name: outfit.name,
        sourceId: character.id, sourceName: character.displayName, tokens: outfit.tokens, prose: outfit.prose, identity,
        searchWords: [character.displayName, character.originalName, character.id, ...character.aliases, outfit.name, outfit.id, outfit.prose, ...outfit.tokens] })
    }
  }
  return recipes
}

export function prepareCatalogWardrobe(item: CatalogWardrobeRecipe, keepStudioControls: boolean) {
  const identity = new Set(item.identity.map(normalizeKey))
  const bunnyCostume = item.tokens.some(token => /bunny[_ -]suit/i.test(token))
  const removed: string[] = []
  const tokens = wardrobeTokens(item.tokens).filter(token => {
    const key = normalizeKey(token)
    const studioControl = /^(?:nene|natsume)_/.test(key) && !keepStudioControls
    const identityToken = (isStableIdentityToken(token) && !(key === 'bunny_ears' && bunnyCostume))
      || (identity.has(key) && !isGarmentToken(token) && !/(?:ribbon|bow|clip|ornament|flower|earring)$/.test(key))
    if (studioControl || identityToken) { removed.push(token); return false }
    return true
  })
  const proseKey = normalizeKey(item.prose)
  const prose = removed.some(token => proseKey.includes(normalizeKey(token))) ? '' : wardrobeProse(item.prose)
  return { tokens, prose }
}
