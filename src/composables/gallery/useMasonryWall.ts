import { ref, onActivated, onDeactivated, onMounted, onUnmounted, computed, type Ref } from 'vue'
import type { ArtworkRecord } from '@/types/artwork'

export interface GalleryRow<T extends Pick<ArtworkRecord, 'id'> = ArtworkRecord> {
  id: T['id']
  items: T[]
  ratio: number
  fill: number
}
export interface MasonryGroup<T extends Pick<ArtworkRecord, 'id'> = ArtworkRecord> {
  key: string
  rows: GalleryRow<T>[]
}

export function galleryRatio(value: number) { return Number.isFinite(value) && value > 0 ? value : .75 }

/** Equal-height image rows give landscapes proportional width without cropping.
 * Previously painted rows stay together when dimensions resolve or pages append. */
export function buildMasonryGroups<T extends Pick<ArtworkRecord, 'id'> = ArtworkRecord>(
  groups: Array<{ key: string; items: T[] }>,
  ratioOf: (item: T) => number,
  columnCount: number,
  previous: MasonryGroup<T>[] = []
): MasonryGroup<T>[] {
  const target = Math.max(1, columnCount) * .75
  return groups.map(group => {
    const prior = previous.find(value => value.key === group.key)
    const current = new Map(group.items.map(item => [item.id, item]))
    const row = (items: T[]): GalleryRow<T> => {
      const ratio = items.reduce((sum, item) => sum + galleryRatio(ratioOf(item)), 0)
      return { id: items[0]!.id, items, ratio, fill: ratio >= target * .75 ? 1 : ratio / target }
    }
    const rows = (prior?.rows ?? []).map(previousRow => row(previousRow.items.map(item => current.get(item.id)!)))
    const placed = new Set(rows.flatMap(value => value.items.map(item => item.id)))
    let pending: T[] = [], ratio = 0
    const flush = () => {
      if (pending.length) rows.push(row(pending))
      pending = []; ratio = 0
    }
    for (const item of group.items) {
      if (placed.has(item.id)) continue
      const next = galleryRatio(ratioOf(item))
      if (pending.length && ratio + next > target && Math.abs(target - ratio) <= Math.abs(target - ratio - next)) flush()
      pending.push(item); ratio += next
      if (ratio >= target) flush()
    }
    flush()
    return { key: group.key, rows }
  })
}

/**
 * 响应式列数探测
 */
export function useMasonryColumns(containerRef?: Ref<HTMLElement | null>) {
  const columnCount = ref(4)
  let active = false

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
      // Use layout's delivered geometry on first mount as well as cached returns;
      // reading clientWidth here forces a full layout inside Vue's mount flush.
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
