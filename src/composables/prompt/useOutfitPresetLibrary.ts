import { computed, ref, watch, type Ref } from 'vue'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { useSceneStore } from '@/stores/sceneStore'
import { usePromptTagTools } from '@/composables/prompt/usePromptTagTools'
import { OUTFIT_BUNDLES } from '@/composables/scene/useDirectorCatalog'
import { UNIVERSAL_WARDROBE_PRESETS } from '@/config/universalWardrobe'
import { suppressedOutfitTags } from '@/utils/outfitReplacement'
import { wardrobeTokens } from '@/utils/wardrobeContent'
import { catalogWardrobe, prepareCatalogWardrobe, type CatalogWardrobeRecipe } from '@/utils/catalogWardrobe'
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
  sourceName: string
  search: string
  types: string[]
}
interface CatalogOutfit extends ItemBase, CatalogWardrobeRecipe {
  kind: 'catalog'
}
interface BundleOutfit extends ItemBase {
  kind: 'bundle' | 'universal'
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
  variants: OutfitItem[]
}

/** One browsing card per name or applied recipe. Each source keeps its own action and ID. */
function groupOutfits(items: OutfitItem[], recipeKey: (item: CatalogOutfit | BundleOutfit) => string | null) {
  const byTitle = new Map<string, OutfitGroup>()
  for (const item of items) {
    const title = item.name.trim().normalize('NFKC').toLowerCase().replace(/\s+/g, ' ')
    const key = item.kind === 'tag' || !title ? item.id : `outfit/${title}`
    const group = byTitle.get(key)
    if (group) group.variants.push(item)
    else byTitle.set(key, { id: item.id, variants: [item] })
  }
  const result: OutfitGroup[] = [], byRecipe = new Map<string, OutfitGroup>()
  for (const group of byTitle.values()) {
    // An alternate name can join a card only if *every* source has that recipe.
    // A title with several distinct looks must keep its own set of choices.
    const recipes = new Set(group.variants.map(item => item.kind === 'tag' ? null : recipeKey(item)))
    const [key] = recipes
    if (key && recipes.size === 1) {
      const same = byRecipe.get(key)
      if (same) { same.variants.push(...group.variants); continue }
      byRecipe.set(key, group)
    }
    result.push(group)
  }
  return result
}

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
      description: preset.description, tokens: wardrobeTokens(preset.tags),
      search: searchText([preset.label, preset.id, preset.description, ...preset.tags].join(' ')),
      types: outfitTypes([preset.label, preset.id, ...preset.tags].join(' ')),
    }))
    const bundles: BundleOutfit[] = OUTFIT_BUNDLES
      .filter(bundle => !pb.isPopular && (pb.char === 'triad' || bundle.character === pb.char))
      .map(bundle => ({
        id: `bundle/${bundle.id}`, kind: 'bundle', name: bundle.label.split(' · ').slice(1).join(' · '),
        sourceName: `${bundle.label.split(' · ')[0]} · 角色词包`, description: wardrobeTokens(bundle.tags).join(', '), tokens: wardrobeTokens(bundle.tags),
        search: searchText([bundle.label, bundle.id, ...bundle.tags].join(' ')),
        types: outfitTypes([bundle.label, bundle.id, ...bundle.tags].join(' ')),
      }))
    const clothingTags: ClothingTag[] = tags.value.map(tag => {
      const meaning = tagMeaning(tag.en, tag.cn)
      return { id: `tag/${tag.en}`, kind: 'tag', name: meaning, sourceName: '服装词条', tag,
        search: searchText([tag.en, meaning, tag.cn || '', ...(tag.aliases || []), tag.desc || ''].join(' ')),
        types: outfitTypes([tag.en, meaning, tag.cn || '', ...(tag.aliases || [])].join(' ')) }
    })
    const catalog: CatalogOutfit[] = catalogWardrobe(scenes.characters, pb.popularCharacters).map(recipe => ({
      ...recipe, kind: 'catalog', search: searchText(recipe.searchWords.join(' ')),
      types: outfitTypes([recipe.outfitId, recipe.name, ...recipe.tokens].join(' ')),
    }))
    // Show each source on the first page, even when the character catalog is large.
    const groups: OutfitItem[][] = [universal, catalog, bundles, clothingTags]
    const combined: OutfitItem[] = [], longest = Math.max(...groups.map(group => group.length))
    for (let index = 0; index < longest; index++) {
      for (const group of groups) {
        const item = group[index]
        if (item) combined.push(item)
      }
    }
    return combined
  })
  const groups = computed(() => groupOutfits(items.value, item => {
    const { tokens, prose } = item.kind === 'catalog' ? prepareCatalogOutfit(item) : { tokens: item.tokens, prose: '' }
    const applied = [...new Set(tokens.map(pb.tagDictionary.canonicalize))]
    return applied.length ? 'recipe/' + JSON.stringify([applied, prose]) : null
  }))
  const matched = computed(() => {
    const terms = searchText(search.value.trim()).split(/\s+/).filter(Boolean)
    if (!terms.length && type.value === 'all' && source.value === 'all') return groups.value
    function matches(item: OutfitItem) {
      const matchesSource = source.value === 'all'
        || (source.value === 'character' ? item.kind === 'catalog' || item.kind === 'bundle'
          : source.value === 'official' ? item.kind === 'tag' && item.tag.cat === 'Official Outfit' : item.kind === source.value)
      return matchesSource && (type.value === 'all' || item.types.includes(type.value))
        && terms.every(term => item.search.includes(term))
    }
    return groups.value.flatMap(group => {
      const variants = group.variants.filter(matches)
      return variants.length ? [{ id: group.id, variants }] : []
    })
  })
  const visible = computed(() => {
    const characterId = pb.subject.kind === 'popular' ? pb.subject.characterId : pb.char
    return matched.value.slice(0, limit.value).map(group => {
      const item = group.variants.find(variant => isSelected(variant) && (variant.kind !== 'catalog' || canApply.value))
        || group.variants.find(variant => variant.kind === 'catalog' && variant.sourceId === characterId)
        || group.variants.find(variant => variant.kind !== 'catalog' || canApply.value)
        || group.variants[0]
      return { ...group, item }
    })
  })
  watch([search, source, type], () => { limit.value = 48 })

  function isPresetActive(tokens: string[]): boolean {
    if (!tokens.length) return false
    const canonical = [...new Set(tokens.map(pb.tagDictionary.canonicalize))]
    if (pb.outfitOverride) {
      const selected = pb.outfitOverride.tokens.map(pb.tagDictionary.canonicalize)
      return canonical.length === selected.length && canonical.every((token, i) => token === selected[i])
    }
    return canonical.every(token => pb.manualTags.has(token))
  }
  function isSelected(item: OutfitItem): boolean {
    if (item.kind === 'tag') return pb.manualTags.has(item.tag.en)
    if (item.kind === 'catalog' || pb.outfitOverride?.presetId) return pb.outfitOverride?.presetId === item.id
    if (pb.outfitOverride?.label && pb.outfitOverride.label !== item.name) return false
    return isPresetActive(item.tokens)
  }
  function selectBundle(item: BundleOutfit) {
    if (!pb.isPopular && (pb.isUnbound || pb.char === 'triad')) {
      const active = isPresetActive(item.tokens)
      toggleOutfitBundle(item.tokens)
      pb.flash(active ? `已卸下「${item.name}」` : `已装配「${item.name}」`)
    } else if (isSelected(item)) {
      if (pb.outfitOverride) pb.clearOutfitOverride()
      else toggleOutfitBundle(item.tokens)
      pb.flash(`已卸下「${item.name}」`)
    } else {
      pb.setOutfitOverride(item.tokens, null, { presetId: item.id, label: item.name, suppressedTags: suppressedOutfitTags(pb.manualTags) })
      pb.flash(`已换装「${item.name}」`)
    }
  }
  function prepareCatalogOutfit(item: CatalogOutfit) {
    return prepareCatalogWardrobe(item, !pb.isPopular && pb.char === item.sourceId)
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
