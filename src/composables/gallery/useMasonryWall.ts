import { ref, onActivated, onDeactivated, onMounted, onUnmounted, computed, type Ref } from 'vue'
import type { ArtworkRecord } from '@/types/artwork'

export interface MasonryGroup {
  key: string
  columns: ArtworkRecord[][]
}

/**
 * 将时间分组内的作品按照最短列贪心分发到各列。
 * 当出现较矮的横图时，后续作品会自动填充到该列下方，保持各列高度平衡，图与图紧密咬合零空位。
 */
export function buildMasonryGroups(
  groups: Array<{ key: string; items: ArtworkRecord[] }>,
  ratioOf: (item: ArtworkRecord) => number,
  columnCount: number,
  previous: MasonryGroup[] = []
): MasonryGroup[] {
  const cols = Math.max(1, columnCount)
  return groups.map(group => {
    const columns: ArtworkRecord[][] = Array.from({ length: cols }, () => [])
    const heights: number[] = new Array(cols).fill(0)
    const placements = new Map<string | number, number>()
    const prior = previous.find(value => value.key === group.key)
    if (prior?.columns.length === cols) prior.columns.forEach((column, index) => {
      column.forEach(item => placements.set(item.id, index))
    })

    for (const item of group.items) {
      // Keep painted cards in their column; only new cards choose the shortest.
      let minCol = placements.get(item.id) ?? 0
      if (!placements.has(item.id)) for (let i = 1; i < cols; i++) {
        if (heights[i] < heights[minCol]) minCol = i
      }

      columns[minCol].push(item)
      // 计算预估高度 (基准宽度 360 / 宽高比 + 卡片间距 20)
      const ratio = ratioOf(item) || (3 / 4)
      const safeRatio = Number.isFinite(ratio) && ratio > 0 ? ratio : (3 / 4)
      heights[minCol] += (360 / safeRatio) + 20
    }

    return {
      key: group.key,
      columns,
    }
  })
}

/**
 * 响应式列数探测
 */
export function useMasonryColumns(containerRef?: Ref<HTMLElement | null>) {
  const columnCount = ref(4)
  let active = false
  let measured = false

  function update(measuredWidth?: number) {
    if (!active) return
    const width = measuredWidth ?? (containerRef ? containerRef.value?.clientWidth ?? 0 : (typeof window !== 'undefined' ? window.innerWidth : 1440))
    // A cached or temporarily hidden wall has no layout width. Retain its last
    // columns instead of rebuilding it against the unrelated window width.
    if (width <= 0) return
    if (width >= 2300) {
      columnCount.value = 6
    } else if (width >= 1800) {
      columnCount.value = 5
    } else if (width >= 1280) {
      columnCount.value = 4
    } else if (width >= 860) {
      columnCount.value = 3
    } else if (width >= 520) {
      columnCount.value = 2
    } else {
      columnCount.value = 1
    }
  }

  let resizeObserver: ResizeObserver | null = null
  const onWindowResize = () => update()

  function start() {
    if (active) return
    active = true
    if (containerRef?.value && typeof ResizeObserver !== 'undefined') {
      // The first mount needs its actual columns immediately. Cached returns
      // keep them until ResizeObserver supplies fresh geometry after layout.
      if (!measured) { update(); measured = true }
      resizeObserver = new ResizeObserver(entries => {
        const entry = entries[0]
        if (entry) update(entry.contentRect.width)
      })
      resizeObserver.observe(containerRef.value)
    } else if (typeof window !== 'undefined') {
      update()
      window.addEventListener('resize', onWindowResize, { passive: true })
    }
  }

  function stop() {
    if (!active) return
    active = false
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', onWindowResize)
    }
    if (resizeObserver) {
      resizeObserver.disconnect()
      resizeObserver = null
    }
  }
  onMounted(start)
  onActivated(start)
  onDeactivated(stop)
  onUnmounted(stop)

  return {
    columnCount: computed(() => columnCount.value),
    update,
  }
}
