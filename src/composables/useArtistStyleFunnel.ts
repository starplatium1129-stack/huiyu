import { profileLocalStorage as localStorage } from '../platform/web/profileStorage.ts'
// 画师三级漏斗排序（2026-09-05 从 ArtistStylePicker.vue 抽出：单体门禁 631>600 拆分）
// 1. Top 3 常用画师：只取使用频次最高的前 3 位（避免试一次就永久污染列表）；
// 2. 角色专属画师：当前角色的官方原画师 / 精选推荐风格；
// 3. 其余画师按目录正常分类排列。

import { computed, ref, type Ref } from 'vue'
import type { ArtistStyleOption } from '@/config/artistStyles'

const USAGE_KEY = 'aics-artist-usage'

function loadUsage(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch { return {} }
}

/** 纯排序：命中集按「Top3 常用 → 角色专属 → 目录默认顺序」重排，保持去重。 */
export function sortByStyleFunnel(
  matched: readonly ArtistStyleOption[],
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
  for (const id of top3Ids) push(id)
  for (const id of curatedIds) push(id)
  for (const option of matched) push(option.id)
  return sorted
}

/** 使用频次追踪（localStorage 持久化）+ Top 3 常用画师 computed。 */
export function useArtistStyleFunnel(options: readonly ArtistStyleOption[]): {
  usageCounts: Ref<Record<string, number>>
  recordUsage: (ids: string[]) => void
  frequentTop3Ids: Ref<string[]>
} {
  const usageCounts = ref<Record<string, number>>(loadUsage())

  function recordUsage(ids: string[]) {
    if (!ids.length) return
    const valid = new Set(options.map(option => option.id))
    const next = { ...usageCounts.value }
    let changed = false
    for (const id of ids) {
      if (!valid.has(id)) continue
      next[id] = (next[id] || 0) + 1
      changed = true
    }
    if (!changed) return
    usageCounts.value = next
    try { localStorage.setItem(USAGE_KEY, JSON.stringify(next)) } catch { /* 配额满等场景静默降级 */ }
  }

  const frequentTop3Ids = computed(() => Object.entries(usageCounts.value)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([id]) => id))

  return { usageCounts, recordUsage, frequentTop3Ids }
}
