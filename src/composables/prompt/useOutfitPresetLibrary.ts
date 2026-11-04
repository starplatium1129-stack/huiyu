import { computed, ref, watch, type Ref } from 'vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { useSceneStore } from '@/stores/sceneStore'
import { OUTFIT_BUNDLES } from '@/composables/scene/useDirectorCatalog'
import { isStableIdentityToken } from '@/utils/interrogateReference'
import { isGarmentToken } from '@/utils/popularIdentity'
import { normalizeKey } from '@/utils/promptPolicy'
import { suppressedOutfitTags } from '@/utils/outfitReplacement'

interface OutfitPreset {
  id: string
  name: string
  sourceId: string
  sourceName: string
  search: string
  tokens: string[]
  prose: string
  identity: string[]
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

export function useOutfitPresetLibrary(search: Readonly<Ref<string>>) {
  const pb = usePromptBuilderStore(), scenes = useSceneStore()
  const limit = ref(24)
  const canApply = computed(() => pb.isPopular || (!pb.isUnbound && pb.char !== 'triad'))
  const presets = computed<OutfitPreset[]>(() => {
    const studio: OutfitPreset[] = []
    for (const profile of scenes.characters) {
      const id = typeof profile.id === 'string' ? profile.id : ''
      if (id !== 'nene' && id !== 'natsume') continue
      const wardrobe = record(profile.lora) && record(profile.lora.special_outfits) ? profile.lora.special_outfits : {}
      const sourceName = typeof profile.name === 'string' ? profile.name : id
      for (const [outfitId, value] of Object.entries(wardrobe)) {
        const tokens = Array.isArray(value) ? value.filter((tag): tag is string => typeof tag === 'string' && !!tag.trim()) : []
        if (!tokens.length) continue
        const bundle = OUTFIT_BUNDLES.find(item => item.character === id && tokens.includes(item.tags[0]))
        const name = bundle?.label.split(' · ').slice(1).join(' · ') || outfitId.replace(/_/g, ' ')
        studio.push({ id: `studio/${id}/${outfitId}`, name, sourceId: id, sourceName,
          search: [sourceName, id, outfitId, name, ...tokens].join(' ').toLowerCase(), tokens, prose: '', identity: [] })
      }
    }
    const popular = pb.popularCharacters.flatMap(character => character.outfits.map(outfit => ({
      id: `catalog/${character.id}/${outfit.id}`, name: outfit.name, sourceId: character.id,
      sourceName: character.displayName,
      search: [character.displayName, character.originalName, character.id, ...character.aliases, outfit.name, outfit.id, outfit.prose, ...outfit.tokens].join(' ').toLowerCase(),
      tokens: outfit.tokens, prose: outfit.prose,
      identity: [...character.identityTokens, ...character.exactTokens, ...(character.characterTokens || []), ...(character.copyrightTokens || [])],
    })))
    return [...studio, ...popular]
  })
  const matched = computed(() => {
    const terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
    return terms.length ? presets.value.filter(preset => terms.every(term => preset.search.includes(term))) : presets.value
  })
  const visible = computed(() => matched.value.slice(0, limit.value))
  watch(search, () => { limit.value = 24 })

  function select(preset: OutfitPreset) {
    if (!canApply.value) return
    if (pb.outfitOverride?.presetId === preset.id) {
      pb.clearOutfitOverride()
      pb.flash('已恢复原服装')
      return
    }
    const identity = new Set(preset.identity.map(normalizeKey))
    const bunnyCostume = preset.tokens.some(token => /bunny[_ -]suit/i.test(token))
    const removed: string[] = []
    const tokens = preset.tokens.filter(token => {
      const key = normalizeKey(token)
      const studioControl = /^(?:nene|natsume)_/.test(key)
      const identityToken = (isStableIdentityToken(token) && !(key === 'bunny_ears' && bunnyCostume))
        || (identity.has(key) && !isGarmentToken(token) && !/(?:ribbon|bow|clip|ornament|flower|earring)$/.test(key))
      if (studioControl || identityToken) { removed.push(token); return false }
      return true
    })
    if (!tokens.length) { pb.flash('这套服装没有可独立套用的衣装词条'); return }
    const proseKey = normalizeKey(preset.prose)
    const proseLeaksIdentity = removed.some(token => proseKey.includes(normalizeKey(token)))
    pb.setOutfitOverride(tokens, null, { presetId: preset.id, label: preset.name,
      ...(preset.prose && !proseLeaksIdentity ? { prose: preset.prose } : {}),
      suppressedTags: suppressedOutfitTags(pb.manualTags) })
    pb.flash(`已换装「${preset.name}」`)
  }

  return { pb, limit, canApply, matched, visible, select }
}
