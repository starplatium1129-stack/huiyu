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
  it('does not submit or clear Chinese IME composition', () => {
    const pb = usePromptBuilderStore()
    const event = { target: { value: '校服' }, isComposing: true } as unknown as KeyboardEvent
    usePromptTagTools(pb).addTag(event)
    expect(pb.manualTags.size).toBe(0)
    expect((event.target as HTMLInputElement).value).toBe('校服')
  })

  it('keeps conflict replacements visible in batch feedback', () => {
    const pb = usePromptBuilderStore()
    const flash = vi.spyOn(pb, 'flash')
    usePromptTagTools(pb).addTag(inputWith('school_uniform, bikini, smile'))
    expect([...pb.manualTags]).toEqual(['bikini', 'smile'])
    expect(flash).toHaveBeenLastCalledWith(expect.stringContaining('1 项替换了冲突词条'))
  })

  it('一次粘贴混合分隔符并归一内部空格，不产生逗号垃圾词条', () => {
    const pb = usePromptBuilderStore()
    const { addTag } = usePromptTagTools(pb)
    addTag(inputWith('blue_hair, smile，twintails、long hair\ndetailed_background'))
    expect([...pb.manualTags].sort()).toEqual(['blue_hair', 'detailed_background', 'long_hair', 'smile', 'twintails'])
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

  it('shared imports and typed aliases converge while preserving weighted and LoRA syntax', () => {
    useSceneStore().tags = [{ en: 'depth_of_field', cn: '景深', cat: 'Camera', aliases: ['dof'] }]
    const pb = usePromptBuilderStore()
    pb.manualTags = new Set(['景深', 'dof', 'depth of field'])
    expect([...pb.manualTags]).toEqual(['depth_of_field'])
    const { addTag } = usePromptTagTools(pb)
    addTag(inputWith('<lora:My_Model:0.8>, (dof:1.25), BREAK'))
    expect([...pb.manualTags]).toEqual(['depth_of_field', '<lora:My_Model:0.8>', '(depth_of_field:1.25)', 'BREAK'])
  })
})

describe('usePromptTagTools · addTag 幂等语义', () => {

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

describe('usePromptTagTools · offline meanings', () => {
  it('loads normalized and weighted aliases and keeps unknown fallback and prompt tokens intact', async () => {
    const pb = usePromptBuilderStore()
    pb.manualTags = new Set(['(DOF:+1.25)', '(Long _ Hair:.8)', "(jeanne_d'arc_alter_(fate):0.85)", 'happy_on_fixture', 'mystery_shirt'])
    const original = [...pb.manualTags]
    const tools = usePromptTagTools(pb)
    tools.tagLabel('(DOF:+1.25)')
    await vi.dynamicImportSettled()
    expect(tools.tagLabel('(DOF:+1.25)')).toBe('前景虚化与景深')
    expect(tools.tagLabel('(Long _ Hair:.8)')).toBe('长发')
    expect(tools.tagLabel("(jeanne_d'arc_alter_(fate):0.85)")).toBe('贞德·Alter（Fate）')
    expect(tools.tagLabel('happy_on_fixture')).toBe('')
    expect(tools.tagMeaning('happy_on_fixture')).toBe('Happy On Fixture')
    expect(tools.tagLabel('mystery_shirt')).toBe('mystery · 衬衫')
    expect([...pb.manualTags]).toEqual(original)
  })
})

describe('usePromptTagTools · outfit override label', () => {
  it('describes the current reference outfit in Chinese without changing its prompt tokens', async () => {
    const pb = usePromptBuilderStore()
    const tokens = ['panties', 'high_heels', 'underwear']
    pb.setOutfitOverride(tokens, '校服/水手服')
    const { outfitOverrideLabel } = usePromptTagTools(pb)
    expect(outfitOverrideLabel.value).not.toMatch(/[a-z_]/i)
    await vi.dynamicImportSettled()
    expect(outfitOverrideLabel.value).toBe('内裤、高跟鞋、内衣')
    expect(pb.outfitOverride).toEqual({ tokens, replaced: '校服/水手服' })
  })

  it('uses a natural Chinese fallback for unknown or partly translated tokens', async () => {
    const pb = usePromptBuilderStore()
    pb.setOutfitOverride(['mystery_costume', 'mystery_shirt'], null)
    const { outfitOverrideLabel } = usePromptTagTools(pb)
    expect(outfitOverrideLabel.value).toBe('新服装')
    await vi.dynamicImportSettled()
    expect(outfitOverrideLabel.value).toBe('新服装')
    expect(pb.outfitOverride?.tokens).toEqual(['mystery_costume', 'mystery_shirt'])
  })

  it('uses catalog translations, skips unknown entries and follows outfit changes', async () => {
    useSceneStore().tags = [{ en: 'fixture_shoes', cn: '定制鞋履', cat: 'Clothing' }]
    const pb = usePromptBuilderStore()
    pb.setOutfitOverride(['fixture_shoes', 'mystery_costume', 'dress', 'dress', 'bikini'], null)
    const { outfitOverrideLabel } = usePromptTagTools(pb)
    expect(outfitOverrideLabel.value).toBe('定制鞋履')
    await vi.dynamicImportSettled()
    expect(outfitOverrideLabel.value).toBe('定制鞋履、连衣裙、比基尼')
    pb.setOutfitOverride(['high_heels'], null)
    expect(outfitOverrideLabel.value).toBe('高跟鞋')
  })
})
