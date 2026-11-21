import { profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
import { computed, ref, type Ref } from 'vue'
import type { ArtistStyleOption } from '@/config/artistStyles'

const USAGE_KEY = 'aics-artist-usage'
const RECENT_KEY = 'aics-artist-recent'

function loadUsage(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

/** 只重排命中的画师。精选按目录顺序，其后沿用常用、角色推荐和目录顺序。 */
export function sortByStyleFunnel(
  matched: readonly ArtistStyleOption[],
  featuredIds: ReadonlySet<string>,
  top3Ids: readonly string[],
  curatedIds: readonly string[],
): ArtistStyleOption[] {
  const byId = new Map(matched.map(option => [option.id, option]))
  const sorted: ArtistStyleOption[] = []
  const seen = new Set<string>()
  const push = (id: string) => {
    if (seen.has(id)) return
    const option = byId.get(id)
    if (option) {
      sorted.push(option)
      seen.add(id)
    }
  }
  for (const option of matched) if (featuredIds.has(option.id)) push(option.id)
  for (const id of top3Ids) push(id)
  for (const id of curatedIds) push(id)
  for (const option of matched) push(option.id)
  return sorted
}

/** 使用频次追踪（localStorage 持久化）+ Top 3 常用画师 computed。 */
export function useArtistStyleFunnel(options: readonly ArtistStyleOption[]): {
  recordUsage: (ids: string[]) => void
  frequentTop3Ids: Ref<string[]>
  recentIds: Ref<string[]>
} {
  const usageCounts = ref<Record<string, number>>(loadUsage())
  const valid = new Set(options.map(option => option.id))
  let recent: unknown = []
  try { recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]') } catch { /* Old or invalid preferences start empty. */ }
  const recentIds = ref<string[]>(Array.isArray(recent) ? [...new Set(recent.filter((id): id is string => typeof id === 'string' && valid.has(id)))].slice(0, 12) : [])

  function recordUsage(ids: string[]) {
    if (!ids.length) return
    const next = { ...usageCounts.value }
    let changed = false
    for (const id of ids) {
      if (!valid.has(id)) continue
      next[id] = (next[id] || 0) + 1
      changed = true
    }
    if (!changed) return
    usageCounts.value = next
    const used = [...new Set(ids.filter(id => valid.has(id)))]
    recentIds.value = [...used, ...recentIds.value.filter(id => !used.includes(id))].slice(0, 12)
    try {
      localStorage.setItem(USAGE_KEY, JSON.stringify(next))
      localStorage.setItem(RECENT_KEY, JSON.stringify(recentIds.value))
    } catch { /* 配额满等场景静默降级 */ }
  }

  const frequentTop3Ids = computed(() => Object.entries(usageCounts.value)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([id]) => id))

  return { recordUsage, frequentTop3Ids, recentIds }
}
