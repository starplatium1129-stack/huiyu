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
  it('默认值对齐 WAI Illustrious 基线', () => {
    const s = usePromptBuilderStore()
    expect(s.sdParams).toMatchObject({
      cfg: 6,
      steps: 30,
      sampler: 'Euler a',
      hiresFix: false,
      hiresScale: 1.5,
      hiresDenoise: 0.4,
      faceDetailer: true,
      seedLock: false,
      seed: -1,
    })
  })

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
    // CHAR_PROMPT 表内 natsume 有专属提示词，派生值非空
    expect(typeof s.charPrompt).toBe('string')
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

  it('toggleManualTag 添加后可再点移除', () => {
    const s = usePromptBuilderStore()
    s.toggleManualTag('masterpiece')
    expect(s.manualTags.has('masterpiece')).toBe(true)
    s.toggleManualTag('masterpiece')
    expect(s.manualTags.has('masterpiece')).toBe(false)
  })
})
