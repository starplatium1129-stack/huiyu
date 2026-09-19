import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import { useSceneStore } from '@/stores/sceneStore'
import { usePromptTagTools } from './usePromptTagTools'

/**
 * 词条输入契约（2026-08-30 UX 审计 P0-3 回归门禁）：
 *  - 批量粘贴：逗号 / 中文逗号 / 顿号 / 换行分隔，一次回车加多个词条
 *  - 幂等 add：输入已激活的词条是「保留」而不是「删掉」
 *  - 组间互斥顶替行为保持不变
 *
 * 这三条都曾被同一行 `pb.toggleManualTag(tag)` 破坏过：批量粘贴产出垃圾词条，
 * 输入已有词条则静默删除——手工攒的 40+ 词条最容易这么丢，故锁进门禁。
 */

function inputWith(value: string): Event {
  return { target: { value } } as unknown as Event
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('usePromptTagTools · addTag 批量粘贴', () => {
  it('英文逗号分隔一次回车加多个词条', () => {
    const pb = usePromptBuilderStore()
    const { addTag } = usePromptTagTools(pb)
    addTag(inputWith('blue_hair, smile, twintails'))
    expect([...pb.manualTags].sort()).toEqual(['blue_hair', 'smile', 'twintails'])
  })

  it('中文逗号与顿号同样分隔', () => {
    const pb = usePromptBuilderStore()
    const { addTag } = usePromptTagTools(pb)
    addTag(inputWith('looking_at_viewer，blush、open_mouth'))
    expect([...pb.manualTags].sort()).toEqual(['blush', 'looking_at_viewer', 'open_mouth'])
  })

  it('换行分隔（多行粘贴）', () => {
    const pb = usePromptBuilderStore()
    const { addTag } = usePromptTagTools(pb)
    addTag(inputWith('detailed_background\ndepth_of_field'))
    expect([...pb.manualTags].sort()).toEqual(['depth_of_field', 'detailed_background'])
  })

  it('词条内部空格归一为下划线，且不再产出 "a,_b" 这类垃圾词条', () => {
    const pb = usePromptBuilderStore()
    const { addTag } = usePromptTagTools(pb)
    addTag(inputWith('long hair, blue eyes'))
    expect([...pb.manualTags].sort()).toEqual(['blue_eyes', 'long_hair'])
    expect([...pb.manualTags].some(tag => tag.includes(','))).toBe(false)
  })

  it('支持常用别名自动归一化解析为规范标签', () => {
    const sceneStore = useSceneStore()
    sceneStore.tags = [
      { id: 'tag_003', cat: 'Clothing', en: 'school_uniform', cn: '校服', aliases: ['jk', 'seifuku'] },
      { id: 'tag_010', cat: 'Clothing', en: 'china_dress', cn: '旗袍', aliases: ['qipao', 'cheongsam'] },
    ] as any
    const pb = usePromptBuilderStore()
    const { addTag } = usePromptTagTools(pb)
    addTag(inputWith('jk'))
    expect(pb.manualTags.has('school_uniform')).toBe(true)
    pb.manualTags = new Set()
    addTag(inputWith('qipao'))
    expect(pb.manualTags.has('china_dress')).toBe(true)
  })

  it('空输入不产生任何词条', () => {
    const pb = usePromptBuilderStore()
    const { addTag } = usePromptTagTools(pb)
    addTag(inputWith('   ，、  '))
    expect(pb.manualTags.size).toBe(0)
  })
})

describe('usePromptTagTools · addTag 幂等语义', () => {
  it('输入已激活的词条保留它（toggle 语义会静默删掉，是 P0-3 的根因）', () => {
    const pb = usePromptBuilderStore()
    const { addTag } = usePromptTagTools(pb)
    addTag(inputWith('smile'))
    expect(pb.manualTags.has('smile')).toBe(true)
    addTag(inputWith('smile'))
    expect(pb.manualTags.has('smile')).toBe(true)
  })

  it('重复项被跳过并提示数量，已存在的那一批不受影响', () => {
    const pb = usePromptBuilderStore()
    const flash = vi.spyOn(pb, 'flash')
    const { addTag } = usePromptTagTools(pb)
    addTag(inputWith('smile, blush'))
    addTag(inputWith('smile, twintails'))
    expect([...pb.manualTags].sort()).toEqual(['blush', 'smile', 'twintails'])
    expect(flash).toHaveBeenCalledWith('已添加 1 个，跳过 1 个已存在')
  })
})

describe('promptBuilderStore · addManualTag', () => {
  it('返回 added / duplicate，且 duplicate 不改动集合', () => {
    const pb = usePromptBuilderStore()
    expect(pb.addManualTag('smile')).toBe('added')
    expect(pb.addManualTag('smile')).toBe('duplicate')
    expect(pb.manualTags.size).toBe(1)
  })

  it('同组服装细节可叠加，跨组服装才整体替换', () => {
    const pb = usePromptBuilderStore()
    expect(pb.addManualTag('school_uniform')).toBe('added')
    expect(pb.addManualTag('pleated_skirt')).toBe('added')
    expect(pb.manualTags.has('pleated_skirt')).toBe(true)
    expect(pb.manualTags.has('school_uniform')).toBe(true)
    expect(pb.addManualTag('triangle_bikini')).toBe('replaced')
    expect(pb.manualTags.has('triangle_bikini')).toBe(true)
    expect(pb.manualTags.has('pleated_skirt')).toBe(false)
    expect(pb.manualTags.has('school_uniform')).toBe(false)
  })
})

describe('usePromptTagTools · outfit bundles', () => {
  it('keeps compatible details inside a bundle and removes a conflicting old outfit family', () => {
    const pb = usePromptBuilderStore()
    pb.manualTags = new Set(['school_uniform', 'pleated_skirt', 'smile'])
    const { toggleOutfitBundle } = usePromptTagTools(pb)
    toggleOutfitBundle(['bikini', 'triangle_bikini', 'barefoot'])
    expect([...pb.manualTags].sort()).toEqual(['barefoot', 'bikini', 'smile', 'triangle_bikini'])
    toggleOutfitBundle(['bikini', 'triangle_bikini', 'barefoot'])
    expect([...pb.manualTags]).toEqual(['smile'])
  })
})
