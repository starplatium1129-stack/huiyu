import { describe, it, expect, vi } from 'vitest'
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue'
import { mount } from '@vue/test-utils'
import { buildMasonryGroups, useMasonryColumns } from './useMasonryWall'
import type { ArtworkRecord } from '@/types/artwork'

function makeItem(id: string, ratio: number): ArtworkRecord {
  return {
    id,
    image_id: id,
    prompt: `prompt ${id}`,
    scene: 'test',
    width: Math.round(1000 * ratio),
    height: 1000,
  }
}

describe('buildMasonryGroups', () => {

  it('distributes items into balanced columns', () => {
    expect(buildMasonryGroups([], () => 1, 4)).toEqual([])
    const items = [
      makeItem('1', 3 / 4), // 竖图
      makeItem('2', 3 / 4), // 竖图
      makeItem('3', 16 / 9), // 横图 (较矮)
      makeItem('4', 3 / 4), // 竖图
      makeItem('5', 3 / 4), // 应该被分配到第 3 列（横图下方）以追平高度
    ]

    const groups = [{ key: '今天', items }]
    const result = buildMasonryGroups(groups, item => (Number(item.width || 1) / Number(item.height || 1)), 4)

    expect(result).toHaveLength(1)
    expect(result[0].columns).toHaveLength(4)
    // 检查第 3 列（包含横图）是否正确接纳了后续较矮需要补充的作品
    expect(result[0].columns[2].some(i => i.id === '3')).toBe(true)
    expect(result[0].columns[2].some(i => i.id === '5')).toBe(true)
    // Corrected dimensions resize the frame, not the DOM parent of painted cards.
    const corrected = buildMasonryGroups(groups, item => item.id === '3' ? 0.2 : 0.75, 4, result)
    expect(corrected[0].columns.map(col => col.map(item => item.id)))
      .toEqual(result[0].columns.map(col => col.map(item => item.id)))
    const appended = buildMasonryGroups([{ key: '今天', items: [...items, makeItem('6', 1)] }],
      item => item.id === '3' ? 0.2 : 0.75, 4, corrected)
    expect(appended[0].columns[0].at(-1)?.id).toBe('6')
    expect(appended[0].columns[2].map(item => item.id)).toEqual(['3', '5'])
  })

  it('handles invalid or zero ratios without throwing', () => {
    const items = [makeItem('1', NaN), makeItem('2', -1), makeItem('3', 0)]
    const groups = [{ key: '本周', items }]
    const result = buildMasonryGroups(groups, () => NaN, 3)

    expect(result[0].columns).toHaveLength(3)
    const totalAssigned = result[0].columns.reduce((sum, col) => sum + col.length, 0)
    expect(totalAssigned).toBe(3)
  })
})

it('preserves cached gallery columns while hidden and measures the actual container on return', async () => {
  let width = 1100
  let columns!: ReturnType<typeof useMasonryColumns>
  let resize!: ResizeObserverCallback
  const observe = vi.fn(), disconnect = vi.fn()
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: ResizeObserverCallback) { resize = callback }
    observe = observe
    disconnect = disconnect
  })
  const active = ref(true)
  const Gallery = defineComponent({ setup() {
    const container = ref<HTMLElement | null>(null)
    columns = useMasonryColumns(container)
    return () => h('div', { ref: (value: unknown) => {
      container.value = value as HTMLElement | null
      if (container.value) Object.defineProperty(container.value, 'clientWidth', { configurable: true, get: () => width })
    } })
  } })
  const wrapper = mount(defineComponent({ setup: () => () => h(KeepAlive, null, { default: () => active.value ? h(Gallery) : null }) }))
  try {
    expect(columns.columnCount.value).toBe(3)
    active.value = false
    await nextTick()
    expect(disconnect).toHaveBeenCalledOnce()
    width = 0
    window.dispatchEvent(new Event('resize'))
    resize([], {} as ResizeObserver)
    await nextTick()
    expect(columns.columnCount.value).toBe(3)
    width = 1850
    active.value = true
    await nextTick()
    expect(columns.columnCount.value).toBe(3)
    resize([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver)
    expect(columns.columnCount.value).toBe(5)
    expect(observe).toHaveBeenCalledTimes(2)
    width = 0
    resize([], {} as ResizeObserver)
    expect(columns.columnCount.value).toBe(5)
  } finally { wrapper.unmount(); vi.unstubAllGlobals() }
})
