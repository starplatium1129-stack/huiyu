import { describe, expect, it } from 'vitest'
import { characterConflictNote, isCensorTag, mergeInterrogatedTags } from './interrogateMerge'

describe('interrogateMerge · 马赛克/打码词条自动过滤（2026-08-29）', () => {
  it('打码类词条全部进 filtered，不进 accepted', () => {
    const result = mergeInterrogatedTags({
      tags: ['censored', 'mosaic_censoring', 'bar_censor', 'white_hair', 'solo'],
      manualTags: new Set(),
      identityTokens: [],
    })
    expect(result.filtered).toEqual(['censored', 'mosaic_censoring', 'bar_censor'])
    expect(result.accepted).toEqual(['white_hair', 'solo'])
  })

  it('uncensored（无码）属正向属性，保留', () => {
    const result = mergeInterrogatedTags({
      tags: ['uncensored', 'censored_nipples', '1girl'],
      manualTags: new Set(),
      identityTokens: [],
    })
    expect(result.filtered).toEqual(['censored_nipples'])
    expect(result.accepted).toContain('uncensored')
    expect(result.accepted).toContain('1girl')
  })

  it('连字符形式经归一后命中（out-of-frame_censoring）', () => {
    expect(isCensorTag('out-of-frame_censoring')).toBe(true)
    expect(isCensorTag('mosaic_censoring')).toBe(true)
    expect(isCensorTag('uncensored')).toBe(false)
    expect(isCensorTag('censorship')).toBe(false)
  })
})

describe('interrogateMerge · 同角色等价匹配（2026-08-29）', () => {
  it('WD14 标准词条 vs 项目写法不同 → 不报冲突（mika_(blue_archive) ≙ misono_mika）', () => {
    const note = characterConflictNote(
      ['mika_(blue_archive)'],
      ['misono_mika', '1girl', 'pink_hair', 'halo', 'blue_archive'],
      ['misono_mika', 'mika', 'mika_(blue_archive)', '圣园未花'],
    )
    expect(note).toBeNull()
  })

  it('无 alias 时按基座包含匹配（hina_(blue_archive) 基座 hina ⊆ sorasaki_hina）', () => {
    const note = characterConflictNote(
      ['hina_(blue_archive)'],
      ['sorasaki_hina', '1girl', 'blue_archive'],
    )
    expect(note).toBeNull()
  })

  it('剥作品后缀后相等（artoria_pendragon_(fate) ≙ artoria_pendragon）', () => {
    const note = characterConflictNote(
      ['artoria_pendragon_(fate)'],
      ['artoria_pendragon', 'saber (fate)', '1girl'],
    )
    expect(note).toBeNull()
  })

  it('空格格式与下划线格式归一等价（makima (chainsaw man) ≙ makima_(chainsaw_man)）', () => {
    const note = characterConflictNote(
      ['makima_(chainsaw_man)'],
      ['makima (chainsaw man)', '1girl'],
    )
    expect(note).toBeNull()
  })

  it('真正的其他角色仍报冲突', () => {
    const note = characterConflictNote(
      ['reimu_hakurei'],
      ['misono_mika', '1girl', 'blue_archive'],
    )
    expect(note).toContain('reimu_hakurei')
  })
})

describe('interrogateMerge · 互斥组冲突消解（2026-08-29 修复「校服 + 泳装并存」）', () => {
  it('校服角色 + 反推泳装 → 收集为服装顶替项（圣园未花 trinity_uniform 真实场景）', () => {
    const result = mergeInterrogatedTags({
      tags: ['swimsuit', 'bikini', 'white_hair', '1girl'],
      manualTags: new Set(),
      identityTokens: ['misono_mika', '1girl', 'school_uniform', 'pleated_skirt', 'white_tights'],
    })
    // 服装跨族不是「丢弃」，是拿去顶替角色默认服装 —— 2026-08-29 改为替换语义
    expect(result.outfitReplacement).toEqual(['swimsuit', 'bikini'])
    expect(result.replacedOutfitGroup).toBe('校服/水手服')
    expect(result.conflicts).toEqual([])
    // 顶替项绝不能同时进 accepted，否则又变成两套服装并存
    expect(result.accepted).not.toContain('swimsuit')
    expect(result.accepted).not.toContain('bikini')
    // 非互斥组词条照常叠加；1girl 已在身份行判为重复
    expect(result.accepted).toContain('white_hair')
    expect(result.duplicates).toContain('1girl')
  })

  it('同服装族内叠加不冲突（校服族已占，反推 sailor_uniform / blazer 放行）', () => {
    const result = mergeInterrogatedTags({
      tags: ['sailor_uniform', 'blazer'],
      manualTags: new Set(),
      identityTokens: ['school_uniform', 'pleated_skirt'],
    })
    expect(result.conflicts).toEqual([])
    expect(result.accepted).toEqual(['sailor_uniform', 'blazer'])
  })

  it('身份行无服装词时，反推服装正常叠加', () => {
    const result = mergeInterrogatedTags({
      tags: ['swimsuit'],
      manualTags: new Set(),
      identityTokens: ['1girl', 'pink_hair'],
    })
    expect(result.accepted).toEqual(['swimsuit'])
    expect(result.conflicts).toEqual([])
  })

  it('反向对称：泳装角色 + 反推校服 同样顶替', () => {
    const result = mergeInterrogatedTags({
      tags: ['school_uniform'],
      manualTags: new Set(),
      identityTokens: ['swimsuit'],
    })
    expect(result.outfitReplacement).toEqual(['school_uniform'])
    expect(result.replacedOutfitGroup).toBe('泳装/水着')
    expect(result.accepted).toEqual([])
  })

  it('顶替项记录被顶替的服装族，供提示与一键恢复使用', () => {
    const result = mergeInterrogatedTags({
      tags: ['swimsuit'],
      manualTags: new Set(),
      identityTokens: ['school_uniform'],
    })
    expect(result.outfitReplacement).toEqual(['swimsuit'])
    expect(result.replacedOutfitGroup).toBe('校服/水手服')
    // 服装是替换语义，不再计入 conflicts（conflicts 表示「丢弃」）
    expect(result.conflicts).toEqual([])
  })

  it('时段互斥仍走跳过（无「可替换部件」语义），且不进服装顶替', () => {
    const result = mergeInterrogatedTags({
      tags: ['day'],
      manualTags: new Set(),
      identityTokens: ['night'],
    })
    expect(result.conflicts.map(c => c.tag)).toEqual(['day'])
    expect(result.conflicts[0].domain).toBe('时段')
    expect(result.outfitReplacement).toEqual([])
  })

  it('回归：发色身份域行为不受影响（域内互斥）', () => {
    const result = mergeInterrogatedTags({
      tags: ['blonde_hair'],
      manualTags: new Set(),
      identityTokens: ['pink_hair'],
    })
    expect(result.conflicts.map(c => c.tag)).toEqual(['blonde_hair'])
  })

  it('未纳入互斥词表的服装词（ballgown）不参与判定，照常叠加', () => {
    // OUTFIT_FAMILIES 只覆盖 6 个高频易冲突族，其余属词表覆盖度问题，非本次修复范围
    const result = mergeInterrogatedTags({
      tags: ['ballgown'],
      manualTags: new Set(),
      identityTokens: ['school_uniform'],
    })
    expect(result.accepted).toEqual(['ballgown'])
    expect(result.conflicts).toEqual([])
  })
})


describe('反推冲突审计回归', () => {
  const merge = (tags: string[], identityTokens: string[] = [], sceneTokens: string[] = [], manualTags = new Set<string>()) => mergeInterrogatedTags({ tags, identityTokens, sceneTokens, manualTags })
  it('服装不与时段或天气跨类别冲突', () => {
    const result = merge(['day', 'clear_sky'], ['school_uniform'])
    expect(result.accepted).toEqual(['day', 'clear_sky'])
    expect(result.conflicts).toEqual([])
  })
  it('场景与手动词条的时段天气参与冲突判断', () => {
    const result = merge(['day', 'sunny'], [], ['night'], new Set(['rain']))
    expect(result.accepted).toEqual([])
    expect(result.conflicts.map(item => item.domain)).toEqual(['时段', '天气'])
  })
  it('归一去重且同一批反推中只保留首个互斥取值', () => {
    const result = merge(['Blush', 'pink_hair', 'pink hair', 'blue_hair'], [], [], new Set(['blush']))
    expect(result.accepted).toEqual(['pink_hair'])
    expect(result.duplicates).toEqual(['blush', 'pink_hair'])
    expect(result.conflicts.map(item => item.tag)).toEqual(['blue_hair'])
  })
  it('泳装不能误替换夜间，多个服装家族择一', () => {
    expect(merge(['swimsuit'], ['night']).accepted).toEqual(['swimsuit'])
    const result = merge(['swimsuit', 'bikini', 'maid'], ['school_uniform'])
    expect(result.outfitReplacement).toEqual(['swimsuit', 'bikini'])
    expect(result.conflicts.map(item => item.tag)).toEqual(['maid'])
  })
  it('单人与 solo 可共存，不能扩成双人', () => {
    const result = merge(['1girl', 'solo', '2girls'])
    expect(result.accepted).toEqual(['1girl', 'solo'])
    expect(result.conflicts.map(item => item.tag)).toEqual(['2girls'])
  })
  it('保留明确镜头，拒绝反推全身与特写并存', () => {
    const result = mergeInterrogatedTags({ tags: ['full_body', 'face_focus'], identityTokens: [], manualTags: new Set(), shot: 'close' })
    expect(result.accepted).toEqual(['face_focus'])
    expect(result.conflicts.map(item => item.tag)).toEqual(['full_body'])
  })
  it('工作室无法替换场景服装时明确拒绝冲突，而不是丢失反推服装', () => {
    const result = mergeInterrogatedTags({ tags: ['swimsuit'], identityTokens: [], sceneTokens: ['school_uniform'], manualTags: new Set(), replaceOutfit: false })
    expect(result.outfitReplacement).toEqual([])
    expect(result.conflicts.map(item => item.tag)).toEqual(['swimsuit'])
  })

  it('姿势最大还原：反推站姿优先采纳，自动将 manualTags 中的旧坐姿列入清理，同批多个姿势优先保留首个', () => {
    // 1. manualTags 中有 sitting，反推 standing → standing 采纳，sitting 列入淘汰
    const replaceResult = mergeInterrogatedTags({
      tags: ['standing', 'smile'],
      manualTags: new Set(['sitting']),
      identityTokens: [],
    })
    expect(replaceResult.accepted).toEqual(['standing', 'smile'])
    expect(replaceResult.obsoleteManualTags).toEqual(['sitting'])
    expect(replaceResult.restorations.some(r => r.includes('姿势'))).toBe(true)

    // 2. 同一批次反推包含多个姿势时，首选置信度最高的姿势，丢弃后续冲突姿势
    const batch = merge(['sitting', 'standing', 'lying'])
    expect(batch.accepted).toEqual(['sitting'])
    expect(batch.conflicts.map(c => c.tag)).toEqual(['standing', 'lying'])
  })

  it('视线与神态还原：反推闭眼优先采纳，自动清理 manualTags 中的直视词', () => {
    const eyeResult = mergeInterrogatedTags({
      tags: ['closed_eyes'],
      manualTags: new Set(['looking_at_viewer']),
      identityTokens: [],
    })
    expect(eyeResult.accepted).toEqual(['closed_eyes'])
    expect(eyeResult.obsoleteManualTags).toEqual(['looking_at_viewer'])
  })

  it('穿戴状态还原：反推赤脚优先采纳，自动清理 manualTags 中的穿鞋词', () => {
    const barefootResult = mergeInterrogatedTags({
      tags: ['barefoot'],
      manualTags: new Set(['boots']),
      identityTokens: [],
    })
    expect(barefootResult.accepted).toEqual(['barefoot'])
    expect(barefootResult.obsoleteManualTags).toEqual(['boots'])
  })

  it('镜头可见性：特写镜头下自动忽略脚部与鞋袜部件', () => {
    const result = mergeInterrogatedTags({
      tags: ['blush', 'boots', 'thighhighs', 'earrings'],
      identityTokens: [],
      manualTags: new Set(),
      shot: 'close',
    })
    expect(result.accepted).toEqual(['blush', 'earrings'])
    expect(result.conflicts.map(c => c.tag)).toEqual(['boots', 'thighhighs'])
    expect(result.conflicts.every(c => c.domain === '镜头可见性')).toBe(true)
  })

  it('视角与拍摄角度还原：反推背面优先采纳，自动清理 manualTags 中的正面视角', () => {
    const viewResult = mergeInterrogatedTags({
      tags: ['back_view'],
      manualTags: new Set(['front_view']),
      identityTokens: [],
    })
    expect(viewResult.accepted).toEqual(['back_view'])
    expect(viewResult.obsoleteManualTags).toEqual(['front_view'])
  })

  it('空间环境互斥：室内拒绝室外', () => {
    const envResult = merge(['outdoors'], ['indoors'])
    expect(envResult.accepted).toEqual([])
    expect(envResult.conflicts.some(c => c.tag === 'outdoors' && c.domain === '空间环境')).toBe(true)
  })

  it('Danbooru 元数据、画质缺陷与多余质量词自动过滤', () => {
    const result = merge(['watermark', 'rating:safe', 'bad_anatomy', 'masterpiece', 'smile'])
    expect(result.accepted).toEqual(['smile'])
    expect(result.filtered).toContain('watermark')
    expect(result.filtered).toContain('rating:safe')
    expect(result.filtered).toContain('bad_anatomy')
    expect(result.filtered).toContain('masterpiece')
  })

  it('单人物立绘反推保护：有具体场景时自动忽略白底留白背景，无场景时放行', () => {
    // 1. 有场景（如教室）时，立绘白底词被自动忽略，保护教室环境
    const inScene = mergeInterrogatedTags({
      tags: ['white_background', 'simple_background', 'white_dress'],
      sceneTokens: ['classroom'],
      manualTags: new Set(),
      identityTokens: [],
    })
    expect(inScene.accepted).toEqual(['white_dress'])
    expect(inScene.conflicts.map(c => c.tag)).toEqual(['white_background', 'simple_background'])

    // 2. 无场景（纯单人物创作）时，立绘白底词放行
    const noScene = mergeInterrogatedTags({
      tags: ['white_background', 'white_dress'],
      sceneTokens: [],
      manualTags: new Set(),
      identityTokens: [],
    })
    expect(noScene.accepted).toEqual(['white_background', 'white_dress'])
  })
})
