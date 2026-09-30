import { describe, it, expect } from 'vitest'
import { buildMasonryGroups } from './useMasonryWall'
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
