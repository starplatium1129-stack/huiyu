import { ref, onMounted, onUnmounted, computed, type Ref } from 'vue'
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
  columnCount: number
): MasonryGroup[] {
  const cols = Math.max(1, columnCount)
  return groups.map(group => {
    const columns: ArtworkRecord[][] = Array.from({ length: cols }, () => [])
    const heights: number[] = new Array(cols).fill(0)

    for (const item of group.items) {
      // 寻找当前高度最小的列
      let minCol = 0
      let minH = heights[0]
      for (let i = 1; i < cols; i++) {
        if (heights[i] < minH) {
          minH = heights[i]
          minCol = i
        }
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

  function update() {
    const width = containerRef?.value?.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 1440)
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

  onMounted(() => {
    update()
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', update, { passive: true })
    }
    if (containerRef?.value && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => update())
      resizeObserver.observe(containerRef.value)
    }
  })

  onUnmounted(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', update)
    }
    if (resizeObserver) {
      resizeObserver.disconnect()
      resizeObserver = null
    }
  })

  return {
    columnCount: computed(() => columnCount.value),
    update,
  }
}
