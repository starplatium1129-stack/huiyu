import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { usePromptBuilderStore } from './promptBuilderStore'

/**
 * promptBuilderStore 纯状态契约（不含存储/网络路径）：
 *  - SD 参数基线与「手动改过」标记集合
 *  - 角色切换与派生文案
 *  - 创作主体（工作室 / 热门角色）切换
 *  - 词条选择：情绪开关、画师别名归一
 */

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('promptBuilderStore · SD 参数', () => {
  it('markParamTouched 只记录合法参数键且去重', () => {
    const s = usePromptBuilderStore()
    s.markParamTouched('cfg')
    s.markParamTouched('cfg')
    s.markParamTouched('steps')
    expect(s.sdParamsTouched.has('cfg')).toBe(true)
    expect(s.sdParamsTouched.has('steps')).toBe(true)
    // 非法键静默忽略（防御拼写错误悄悄绕过 profile 覆盖）
    s.markParamTouched('notARealParam' as never)
    expect(s.sdParamsTouched.has('notARealParam' as never)).toBe(false)
  })

  it('resetParamsToProfile 清空 touched 标记并恢复默认模型参数', () => {
    const s = usePromptBuilderStore()
    s.modelProfiles = [{
      id: 'wai_illustrious_v17',
      name: 'WAI Illustrious',
      checkpoint_match: '.*',
      cfg: 6,
      steps: 30,
      sampler: 'Euler a',
      hires_fix: false,
    } as any]
    s.markParamTouched('cfg')
    s.markParamTouched('steps')
    s.sdParams.cfg = 12
    s.sdParams.steps = 50
    expect(s.sdParamsTouched.size).toBe(2)

    s.resetParamsToProfile()
    expect(s.sdParamsTouched.size).toBe(0)
    expect(s.sdParams.cfg).toBe(6)
    expect(s.sdParams.steps).toBe(30)
  })
})

describe('promptBuilderStore · 角色与主体切换', () => {
  it('setChar 切换角色并驱动 charPrompt 派生', () => {
    const s = usePromptBuilderStore()
    s.setChar('natsume')
    expect(s.char).toBe('natsume')
    expect(s.charPrompt).toContain('shiki_natsume')
  })

  it('subject 默认工作室；切热门带全字段；切回工作室幂等', () => {
    const s = usePromptBuilderStore()
    expect(s.subject.kind).toBe('studio')
    expect(s.isPopular).toBe(false)

    s.setPopularSubject('nene', 'outfit-school', 'bp-001')
    expect(s.isPopular).toBe(true)
    expect(s.subject).toMatchObject({
      kind: 'popular',
      characterId: 'nene',
      outfitId: 'outfit-school',
      blueprintId: 'bp-001',
    })

    s.setStudioSubject()
    expect(s.subject.kind).toBe('studio')
    // 已是 studio 时再次调用不产生新对象（幂等）
    const before = s.subject
    s.setStudioSubject()
    expect(s.subject).toBe(before)
  })
})

describe('promptBuilderStore · 词条选择', () => {
  it('keeps user-owned duplicates and explicitly adopted reference tags when resetting the reference', () => {
    const s = usePromptBuilderStore()
    s.manualTags = new Set(['sitting', 'park', 'paper_lantern'])
    s.referenceInput = { tags: ['sitting', 'park'] }
    expect(s.addManualTag('sitting')).toBe('duplicate')
    expect(s.referenceInput).toEqual({ tags: ['park'] })
    s.clearReferenceInput()
    expect(s.manualTags).toEqual(new Set(['sitting', 'paper_lantern']))
    expect(s.referenceInput).toBeNull()
  })

  it('does not restore reference ownership after a user removes and re-adds a tag', () => {
    const s = usePromptBuilderStore()
    s.manualTags = new Set(['sitting', 'park'])
    s.referenceInput = { tags: ['sitting', 'park'] }
    s.toggleManualTag('sitting')
    s.toggleManualTag('sitting')
    s.clearReferenceInput()
    expect(s.manualTags).toEqual(new Set(['sitting']))
  })

  it('clears removed source tags synchronously, including the clear-tags action', () => {
    const s = usePromptBuilderStore()
    s.manualTags = new Set(['sitting', 'park'])
    s.referenceInput = { tags: ['sitting', 'park'] }
    s.manualTags.delete('sitting')
    expect(s.referenceInput).toEqual({ tags: ['park'] })
    s.manualTags = new Set()
    expect(s.referenceInput).toBeNull()
  })

  it('restores detached reference ownership when undoing a style-layer change', () => {
    const s = usePromptBuilderStore()
    s.manualTags = new Set(['sitting', 'paper_lantern'])
    s.referenceInput = { tags: ['sitting'] }
    const snapshot = s.snapshotStyleLayers()
    s.manualTags = new Set(['standing'])
    expect(s.referenceInput).toBeNull()
    s.restoreStyleLayers(snapshot)
    snapshot.referenceInput!.tags.push('paper_lantern')
    s.clearReferenceInput()
    expect(s.manualTags).toEqual(new Set(['paper_lantern']))
  })

  it('toggleEmotion 开关语义：未选则加入，已选则移除', () => {
    const s = usePromptBuilderStore()
    s.toggleEmotion('emo-a')
    expect(s.selections.emotion).toContain('emo-a')
    s.toggleEmotion('emo-a')
    expect(s.selections.emotion).not.toContain('emo-a')
  })

  it('setArtistStyleIds 走别名归一（azure→azuuru）并保持顺序', () => {
    const s = usePromptBuilderStore()
    s.setArtistStyleIds(['azure', 'rella'])
    expect(s.artistStyleIds).toEqual(['azuuru', 'rella'])
  })

})
