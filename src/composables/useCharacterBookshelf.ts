import { computed, ref, watch, type MaybeRefOrGetter, toValue } from 'vue'
import type { DirectoryCharacter } from '@/components/library/CharacterDirectory.vue'
import { franchiseKey, franchiseLabel } from '@/utils/franchiseLabel'

const PAGE_SIZE = 24

export function useCharacterBookshelf(items: MaybeRefOrGetter<readonly DirectoryCharacter[]>) {
  const query = ref('')
  const mode = ref<'shelf' | 'characters'>('shelf')
  const series = ref<string | null>(null)
  const page = ref(1)
  const term = computed(() => query.value.trim().toLocaleLowerCase())
  const indexed = computed(() => toValue(items).map(item => {
    const key = franchiseKey(item.source)
    return {
      item, key,
      text: [item.id, item.name, item.source, franchiseLabel(key), ...(item.aliases || [])].join(' ').toLocaleLowerCase(),
    }
  }))
  const groups = computed(() => {
    const grouped = new Map<string, DirectoryCharacter[]>()
    for (const { item, key } of indexed.value) {
      const members = grouped.get(key) || []
      members.push(item)
      grouped.set(key, members)
    }
    return [...grouped].map(([key, members]) => ({
      key, label: franchiseLabel(key) || '未标注作品', count: members.length,
      // 只用目录已有画像；待生成占位不作为封面，也不复制少量画像来凑叠卡。
      covers: members.filter(item => item.image?.trim() && !item.image.includes('portrait-pending')).slice(0, 5),
    })).sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'zh-CN'))
  })
  const activeGroup = computed(() => groups.value.find(group => group.key === series.value))
  const showingShelf = computed(() => mode.value === 'shelf' && !term.value && series.value === null)
  const results = computed(() => indexed.value.filter(row => term.value
    ? row.text.includes(term.value)
    : series.value === null || row.key === series.value).map(row => row.item)
    .sort((a, b) => Number(b.name.toLocaleLowerCase() === term.value) - Number(a.name.toLocaleLowerCase() === term.value)))
  const pageCount = computed(() => Math.max(1, Math.ceil(results.value.length / PAGE_SIZE)))
  const visibleResults = computed(() => results.value.slice((page.value - 1) * PAGE_SIZE, page.value * PAGE_SIZE))
  watch([query, mode, series], () => { page.value = 1 })
  watch(pageCount, count => { page.value = Math.min(page.value, count) })

  function openGroup(key: string) { series.value = key; query.value = ''; mode.value = 'characters' }
  function changeMode(value: 'shelf' | 'characters') { mode.value = value; series.value = null; query.value = '' }
  function clearSearch() { query.value = '' }

  return { query, mode, series, page, term, groups, activeGroup, showingShelf, results, pageCount, visibleResults, openGroup, changeMode, clearSearch }
}
