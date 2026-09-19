import { describe, expect, expectTypeOf, it } from 'vitest'
import type { DeepReadonly } from 'vue'
import type { CharKey as LegacyCharKey, DrawEngine as LegacyDrawEngine, HistoryEntry as LegacyHistoryEntry } from '@/stores/promptBuilderStore'
import type { CharKey, DrawEngine, HistoryEntry, HistorySnapshot } from './promptHistory'
import { parseArtworkRecords } from './artwork'
import { historyFromResultContext } from '@/utils/resultContext'

describe('公共作品类型的兼容边界', () => {
  it('旧导出保持同一契约，快照的深只读形状与原 Vue 表达一致', () => {
    expectTypeOf<HistoryEntry>().toEqualTypeOf<LegacyHistoryEntry>()
    expectTypeOf<CharKey>().toEqualTypeOf<LegacyCharKey>()
    expectTypeOf<DrawEngine>().toEqualTypeOf<LegacyDrawEngine>()
    expectTypeOf<HistorySnapshot>().toEqualTypeOf<DeepReadonly<Partial<HistoryEntry>>>()
  })

  it('旧记录保留字符串/数字 ID、缺失父作品、扩展字段及 null/缺省差别，不回写', () => {
    const records = [
      { id: 'legacy-id', parent_id: 'missing-parent', project: 'project-a', width: '832', scene: null, future: { version: 3 } },
      { id: 42, parent_id: null },
    ]
    const before = JSON.stringify(records)
    const parsed = parseArtworkRecords([...records, { id: '' }, null])
    expect(parsed).toEqual(records)
    expect(parsed[0]).toBe(records[0])
    expect(parsed[1]).not.toHaveProperty('scene')
    expect(parsed[1]).not.toHaveProperty('engine')
    expect(JSON.stringify(records)).toBe(before)
  })

  it('热门与工作室身份仍由结果决定，映射复制可变数组和嵌套对象', () => {
    const history = { emotion: ['calm'], manual_tags: ['river'], rating: { composition: 4 }, loras: [{ id: 'style', strength: 0.5 }] }
    const popular = historyFromResultContext({ characterId: 'popular-outside-studio-enum', outfitId: 'outfit-a', blueprintId: 'blueprint-a', history })
    history.emotion.push('happy')
    history.manual_tags.push('forest')
    history.rating.composition = 1
    history.loras[0]!.strength = 1
    expect(popular).toMatchObject({
      character: 'popular-outside-studio-enum', characterId: 'popular-outside-studio-enum', outfitId: 'outfit-a',
      scene: 'blueprint-a', subject: 'popular', noLora: true,
      emotion: ['calm'], manual_tags: ['river'], rating: { composition: 4 }, loras: [{ id: 'style', strength: 0.5 }],
    })
    expect(historyFromResultContext({ char: 'nene', sceneId: 'scene-a' })).toMatchObject({ character: 'nene', subject: 'studio', scene: 'scene-a', noLora: false })
    expect(historyFromResultContext(null)).toEqual({})
  })
})
