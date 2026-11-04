import { computed, ref, watch, type Ref } from 'vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { useSceneStore } from '@/stores/sceneStore'
import { usePromptTagTools } from '@/composables/prompt/usePromptTagTools'
import { OUTFIT_BUNDLES } from '@/composables/scene/useDirectorCatalog'
import { UNIVERSAL_WARDROBE_PRESETS } from '@/config/universalWardrobe'
import { isStableIdentityToken } from '@/utils/interrogateReference'
import { isGarmentToken } from '@/utils/popularIdentity'
import { normalizeKey } from '@/utils/promptPolicy'
import { suppressedOutfitTags } from '@/utils/outfitReplacement'
import type { PromptTagSource } from '@/utils/promptTagDictionary'

const OUTFIT_TYPES = [
  { value: 'uniform', label: '制服', match: /uniform|serafuku|schoolwear|制服|校服|水手服/i },
  { value: 'daily', label: '日常', match: /casual|everyday|daily|streetwear|日常|私服|便服|休闲/i },
  { value: 'dress', label: '裙装与礼服', match: /dress|gown|skirt|wedding|bridal|裙|礼服|婚纱/i },
  { value: 'top', label: '上衣与外套', match: /shirt|blouse|sweater|cardigan|hoodie|jacket|coat|blazer|上衣|衬衫|毛衣|针织|外套|风衣|连帽衫/i },
  { value: 'bottom', label: '裤装', match: /pants|trousers|shorts|jeans|裤|牛仔/i },
  { value: 'swim', label: '泳装', match: /swimsuit|swimwear|bikini|monokini|水着|泳装|泳衣|比基尼|死库水/i },
  { value: 'sleep', label: '居家与睡衣', match: /pajamas|pyjamas|sleepwear|nightgown|nightdress|loungewear|negligee|babydoll|睡衣|睡裙|睡袍|家居|居家/i },
  { value: 'lingerie', label: '内衣', match: /lingerie|underwear|panties|brassiere|(?:^|[\s_-])bra(?:$|[\s_-])|内衣|内裤|文胸|胸罩/i },
  { value: 'nude', label: '裸露', match: /nude|naked|裸体|赤裸|全裸/i },
  { value: 'traditional', label: '传统服饰', match: /kimono|yukata|qipao|china[_ -]dress|hanfu|hanbok|和服|浴衣|旗袍|汉服|韩服/i },
  { value: 'costume', label: '职业与幻想', match: /maid|bunny[_ -]suit|witch|armor|armour|costume|女仆|兔女郎|魔女|战斗装|铠甲|职业装/i },
  { value: 'sport', label: '运动', match: /sportswear|sports[_ -]bra|gym|athletic|tracksuit|jersey|yoga|运动|健身|瑜伽|球衣/i },
  { value: 'accessory', label: '鞋袜与配饰', match: /shoes|boots|heels|socks|thighhighs|stockings|gloves|hat|ribbon|accessor|鞋|靴|袜|手套|帽|饰品|发饰/i },
] as const

export const OUTFIT_TYPE_OPTIONS = [
  { value: 'all', label: '全部类型' },
  ...OUTFIT_TYPES.map(({ value, label }) => ({ value, label })),
  { value: 'other', label: '其他服装' },
]

export const OUTFIT_SOURCE_OPTIONS = [
  { value: 'all', label: '全部来源' },
  { value: 'character', label: '角色套装' },
  { value: 'universal', label: '通用套装' },
  { value: 'tag', label: '服装词条' },
  { value: 'official', label: '官方服装词条' },
]

interface ItemBase {
  id: string
  name: string
  search: string
  types: string[]
}
interface CatalogOutfit extends ItemBase {
  kind: 'catalog'
  sourceId: string
  sourceName: string
  tokens: string[]
  prose: string
  identity: string[]
}
interface BundleOutfit extends ItemBase {
  kind: 'bundle' | 'universal'
  sourceName: string
  description: string
  tokens: string[]
}
interface ClothingTag extends ItemBase {
  kind: 'tag'
  tag: PromptTagSource
}
type OutfitItem = CatalogOutfit | BundleOutfit | ClothingTag
interface OutfitGroup {
  id: string
  item: OutfitItem
  variants: CatalogOutfit[]
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const searchText = (value: string) => value.toLowerCase().replace(/[_-]+/g, ' ')
const outfitTypes = (value: string) => {
  const matches = OUTFIT_TYPES.filter(type => type.match.test(value)).map(type => type.value as string)
  return matches.length ? matches : ['other']
}

export function useOutfitPresetLibrary(
  search: Readonly<Ref<string>>,
  tags: Readonly<Ref<readonly PromptTagSource[]>>,
  tagMeaning: (tag: string, label?: string) => string,
) {
  const pb = usePromptBuilderStore(), scenes = useSceneStore()
  const { toggleOutfitBundle } = usePromptTagTools(pb)
  const limit = ref(48), type = ref('all'), source = ref('all')
  const canApply = computed(() => pb.isPopular || (!pb.isUnbound && pb.char !== 'triad'))
  const items = computed<OutfitItem[]>(() => {
    const universal: BundleOutfit[] = UNIVERSAL_WARDROBE_PRESETS.map(preset => ({
      id: `universal/${preset.id}`, kind: 'universal', name: preset.label, sourceName: '通用套装',
      description: preset.description, tokens: preset.tags,
      search: searchText([preset.label, preset.id, preset.description, ...preset.tags].join(' ')),
      types: outfitTypes([preset.label, preset.id, ...preset.tags].join(' ')),
    }))
    const bundles: BundleOutfit[] = OUTFIT_BUNDLES
      .filter(bundle => !pb.isPopular && (pb.char === 'triad' || bundle.character === pb.char))
      .map(bundle => ({
        id: `bundle/${bundle.id}`, kind: 'bundle', name: bundle.label.split(' · ').slice(1).join(' · '),
        sourceName: `${bundle.label.split(' · ')[0]} · 角色词包`, description: bundle.tags.join(', '), tokens: bundle.tags,
        search: searchText([bundle.label, bundle.id, ...bundle.tags].join(' ')),
        types: outfitTypes([bundle.label, bundle.id, ...bundle.tags].join(' ')),
      }))
    const clothingTags: ClothingTag[] = tags.value.map(tag => {
      const meaning = tagMeaning(tag.en, tag.cn)
      return { id: `tag/${tag.en}`, kind: 'tag', name: meaning, tag,
        search: searchText([tag.en, meaning, tag.cn || '', ...(tag.aliases || []), tag.desc || ''].join(' ')),
        types: outfitTypes([tag.en, meaning, tag.cn || '', ...(tag.aliases || [])].join(' ')) }
    })
    const studio: CatalogOutfit[] = []
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
        studio.push({ id: `studio/${id}/${outfitId}`, kind: 'catalog', name, sourceId: id, sourceName, tokens, prose: '', identity: [],
          search: searchText([sourceName, id, outfitId, name, ...tokens].join(' ')),
          types: outfitTypes([outfitId, name, ...tokens].join(' ')) })
      }
    }
    const popular: CatalogOutfit[] = pb.popularCharacters.flatMap(character => character.outfits.map(outfit => ({
      id: `catalog/${character.id}/${outfit.id}`, kind: 'catalog' as const, name: outfit.name,
      sourceId: character.id, sourceName: character.displayName, tokens: outfit.tokens, prose: outfit.prose,
      identity: [...character.identityTokens, ...character.exactTokens, ...(character.characterTokens || []), ...(character.copyrightTokens || [])],
      search: searchText([character.displayName, character.originalName, character.id, ...character.aliases, outfit.name, outfit.id, outfit.prose, ...outfit.tokens].join(' ')),
      types: outfitTypes([outfit.name, outfit.id, ...outfit.tokens].join(' ')),
    })))
    // Show each source on the first page, even when the character catalog is large.
    const groups: OutfitItem[][] = [universal, [...studio, ...popular], bundles, clothingTags]
    const combined: OutfitItem[] = [], longest = Math.max(...groups.map(group => group.length))
    for (let index = 0; index < longest; index++) {
      for (const group of groups) {
        const item = group[index]
        if (item) combined.push(item)
      }
    }
    return combined
  })
  const matched = computed(() => {
    const terms = searchText(search.value.trim()).split(/\s+/).filter(Boolean)
    const groups: OutfitGroup[] = [], byContent = new Map<string, OutfitGroup>()
    for (const item of items.value) {
      const matchesSource = source.value === 'all'
        || (source.value === 'character' ? item.kind === 'catalog' || item.kind === 'bundle'
          : source.value === 'official' ? item.kind === 'tag' && item.tag.cat === 'Official Outfit' : item.kind === source.value)
      if (!matchesSource || (type.value !== 'all' && !item.types.includes(type.value))
        || !terms.every(term => item.search.includes(term))) continue
      if (item.kind === 'catalog') {
        const prepared = prepareCatalogOutfit(item)
        if (prepared.tokens.length) {
          // Group only identical applied content; token order and prose may affect rendering.
          const tokens = [...new Set(prepared.tokens.map(pb.tagDictionary.canonicalize))]
          const key = JSON.stringify([tokens, prepared.prose])
          const existing = byContent.get(key)
          if (existing) { existing.variants.push(item); continue }
          const group = { id: item.id, item, variants: [item] }
          byContent.set(key, group); groups.push(group)
          continue
        }
      }
      groups.push({ id: item.id, item, variants: item.kind === 'catalog' ? [item] : [] })
    }
    return groups
  })
  const visible = computed(() => {
    const characterId = pb.subject.kind === 'popular' ? pb.subject.characterId : pb.char
    return matched.value.slice(0, limit.value).map(group => ({ ...group,
      item: group.variants.find(variant => variant.id === pb.outfitOverride?.presetId)
        || group.variants.find(variant => variant.sourceId === characterId) || group.item }))
  })
  watch([search, source, type], () => { limit.value = 48 })

  function isPresetActive(tokens: string[]): boolean {
    if (!tokens.length) return false
    const canonical = tokens.map(pb.tagDictionary.canonicalize)
    const selected = pb.outfitOverride
      ? new Set(pb.outfitOverride.tokens.map(pb.tagDictionary.canonicalize)) : pb.manualTags
    return canonical.every(token => selected.has(token))
  }
  function isSelected(item: OutfitItem): boolean {
    if (item.kind === 'tag') return pb.manualTags.has(item.tag.en)
    return item.kind === 'catalog' ? pb.outfitOverride?.presetId === item.id : isPresetActive(item.tokens)
  }
  function selectBundle(item: BundleOutfit) {
    if (!pb.isPopular && (pb.isUnbound || pb.char === 'triad')) {
      const active = isPresetActive(item.tokens)
      toggleOutfitBundle(item.tokens)
      pb.flash(active ? `已卸下「${item.name}」` : `已装配「${item.name}」`)
    } else if (isPresetActive(item.tokens)) {
      if (pb.outfitOverride) pb.clearOutfitOverride()
      else toggleOutfitBundle(item.tokens)
      pb.flash(`已卸下「${item.name}」`)
    } else {
      pb.setOutfitOverride(item.tokens, null, { label: item.name, suppressedTags: suppressedOutfitTags(pb.manualTags) })
      pb.flash(`已换装「${item.name}」`)
    }
  }
  function prepareCatalogOutfit(item: CatalogOutfit) {
    const identity = new Set(item.identity.map(normalizeKey))
    const bunnyCostume = item.tokens.some(token => /bunny[_ -]suit/i.test(token))
    const removed: string[] = []
    const tokens = item.tokens.filter(token => {
      const key = normalizeKey(token)
      const studioControl = /^(?:nene|natsume)_/.test(key)
      const identityToken = (isStableIdentityToken(token) && !(key === 'bunny_ears' && bunnyCostume))
        || (identity.has(key) && !isGarmentToken(token) && !/(?:ribbon|bow|clip|ornament|flower|earring)$/.test(key))
      if (studioControl || identityToken) { removed.push(token); return false }
      return true
    })
    const proseKey = normalizeKey(item.prose)
    const prose = removed.some(token => proseKey.includes(normalizeKey(token))) ? '' : item.prose
    return { tokens, prose }
  }
  function select(item: OutfitItem) {
    if (item.kind === 'tag') { pb.toggleManualTag(item.tag.en); return }
    if (item.kind !== 'catalog') { selectBundle(item); return }
    if (!canApply.value) return
    if (pb.outfitOverride?.presetId === item.id) {
      pb.clearOutfitOverride()
      pb.flash('已恢复原服装')
      return
    }
    const { tokens, prose } = prepareCatalogOutfit(item)
    if (!tokens.length) { pb.flash('这套服装没有可独立套用的衣装词条'); return }
    pb.setOutfitOverride(tokens, null, { presetId: item.id, label: item.name,
      ...(prose ? { prose } : {}),
      suppressedTags: suppressedOutfitTags(pb.manualTags) })
    pb.flash(`已换装「${item.name}」`)
  }

  return { pb, limit, type, source, canApply, matched, visible, isSelected, select }
}
