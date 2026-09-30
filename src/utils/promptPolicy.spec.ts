import { describe, expect, it } from 'vitest'
import type { ModelProfile, PromptPart } from './promptPolicy'
import {
  adaptNegative,
  analyzeParts,
  applyFraming,
  assembleNegative,
  mergeNegativePrompt,
  parseScenePromptLoras,
  qualityPrefix,
  resolveFramingMode,
  resolveLoraSpecs,
  sceneRating,
} from './promptPolicy'

/** 组装负面词的 2026-08-15 用户裁定契约：
 *  裸露压制只存在于 ALL 评级；R15/R18 剥离裸露压制并强制未成年保护词。 */
describe('adaptNegative · 评级驱动的负面词适配', () => {
  const base = 'worst quality, low quality, nsfw, nude, cropped, duplicate'

  it('ALL 评级：保留裸露压制，并补齐缺失的 nsfw/nude/explicit', () => {
    const out = adaptNegative('low quality', { rating: 'All' })
    expect(out).toContain('nsfw')
    expect(out).toContain('nude')
    expect(out).toContain('explicit')
    expect(out).not.toContain('child')
  })

  it('特写/细节镜头移除 cropped；triad 双人移除 duplicate', () => {
    const close = adaptNegative(base, { rating: 'R18' }, { shot: 'close' })
    expect(close).not.toContain('cropped')
    const triad = adaptNegative(base, { rating: 'R18' }, { character: 'triad' })
    expect(triad).not.toContain('duplicate')
  })
})

describe('mergeNegativePrompt · merge/replace 策略', () => {
  it('merge：前缀与场景负面去重合并', () => {
    const out = mergeNegativePrompt('prefix-a, prefix-b', 'scene-x, prefix-a', 'merge')
    expect(out).toContain('prefix-a')
    expect(out).toContain('prefix-b')
    expect(out).toContain('scene-x')
    expect(out.split('prefix-a').length - 1).toBe(1)
  })

  it('replace+all：只留前缀', () => {
    const out = mergeNegativePrompt('prefix-a', 'scene-x', 'replace', 'all')
    expect(out).toBe('prefix-a')
  })
})

describe('assembleNegative · 端到端装配', () => {
  it('krea2 引擎恒为空串（自然语言模型无负面）', () => {
    expect(assembleNegative(null, { rating: 'R18' }, 'krea2')).toBe('')
  })

  it('sd + sdNegativeEnabled=false 恒为空串', () => {
    expect(assembleNegative(null, { rating: 'R18' }, 'sd', { sdNegativeEnabled: false })).toBe('')
  })

  it('任何 profile 下都携带解剖/白边保护词', () => {
    const out = assembleNegative(null, { rating: 'R15' }, 'sd')
    expect(out).toContain('bad anatomy')
    expect(out).toContain('white_border')
  })

  it('strip_quality_tokens 的 profile 会剥掉 score_N 类 token', () => {
    const profile = { negative_prefix: '', strip_quality_tokens: true } as unknown as ModelProfile
    const scene = { rating: 'R15', negative: 'score_9, lowres' }
    const out = assembleNegative(profile, scene, 'anima' as never)
    expect(out).not.toMatch(/score_\d+/i)
  })
})

describe('parseScenePromptLoras / resolveLoraSpecs', () => {
  it('解析 <lora:name> 与 <lora:name:weight>，忽略无名字段', () => {
    const refs = parseScenePromptLoras({
      prompt: 'x <lora:ayachi_nene_v18_wd14:0.52> y <lora:shiki_natsume_v18_wd14> z <lora:> end',
    } as never)
    expect(refs).toEqual([
      { name: 'ayachi_nene_v18_wd14', weight: 0.52 },
      { name: 'shiki_natsume_v18_wd14', weight: null },
    ])
  })

  it('resolveLoraSpecs 解析场景内联 LoRA 并回填默认权重', () => {
    const specs = resolveLoraSpecs(
      'nene',
      { prompt: '<lora:ayachi_nene_v18_wd14:0.5>', category: 'After_Story' } as never,
      [{ name: 'ayachi_nene_v18_wd14', recommended_weight: {}, strength: { default: 0.8 } }] as never,
      { nene: 'ayachi_nene_v18_wd14' },
      {},
    )
    expect(specs.length).toBe(1)
    expect(specs[0].name).toBe('ayachi_nene_v18_wd14')
    expect(specs[0].weight).toBe(0.5) // 显式权重优先于 profile 默认
  })

  it('场景无内联 LoRA 时按角色回退表解析（无冒号 → 默认权重）', () => {
    const specs = resolveLoraSpecs(
      'nene',
      { prompt: '1girl, smile' } as never,
      [] as never,
      { nene: 'ayachi_nene_v18_wd14' },
      {},
    )
    expect(specs.length).toBe(1)
    expect(specs[0].name).toBe('ayachi_nene_v18_wd14')
    expect(typeof specs[0].weight).toBe('number')
  })
})

describe('framing · 画幅冲突消解', () => {
  const parts: PromptPart[] = [
    { cls: 'q', text: 'masterpiece' },
    { cls: 'c', text: '1girl, full_body, close_up' },
    { cls: 'n', text: 'nsfw, full_body' },
    { cls: 'l', text: '<lora:x>' },
  ]

  it('resolveFramingMode：显式 shot 优先；否则由手动词条推断', () => {
    expect(resolveFramingMode('wide')).toBe('wide')
    expect(resolveFramingMode('close')).toBe('close')
    expect(resolveFramingMode('medium')).toBe('mid')
    expect(resolveFramingMode(undefined, ['full_body'])).toBe('wide')
    expect(resolveFramingMode(undefined, ['close_up'])).toBe('close')
    expect(resolveFramingMode()).toBe('')
  })

  it('applyFraming 只清洗正向部件，负面与 LoRA 行豁免；清空的部件被丢弃', () => {
    const framed = applyFraming(parts, 'close')
    const cPart = framed.find(p => p.cls === 'c')
    expect(cPart?.text).toContain('close_up')
    expect(cPart?.text).not.toContain('full_body')
    // n/l 部件原样保留
    expect(framed.find(p => p.cls === 'n')?.text).toBe('nsfw, full_body')
    expect(framed.find(p => p.cls === 'l')?.text).toBe('<lora:x>')
  })
})

describe('sceneRating / qualityPrefix', () => {
  it('评级归一：mature=true 或 R18 → R18；R15 → R15；其余 → ALL', () => {
    expect(sceneRating({ rating: 'R18' })).toBe('R18')
    expect(sceneRating({ rating: 'All', mature: true })).toBe('R18')
    expect(sceneRating({ rating: 'R15' })).toBe('R15')
    expect(sceneRating({})).toBe('ALL')
  })

  it('qualityPrefix 无 profile 时使用站内默认质量前缀', () => {
    expect(qualityPrefix(null)).toBe('masterpiece, best quality, very aesthetic, absurdres')
  })
})

/** K2 引擎 §10.1/§10.3 镜头可见性与硬冲突检查（2026-08-30 落地）。 */
describe('analyzeParts · 镜头可见性与硬冲突', () => {
  it('特写镜头下写鞋 → 警告镜头可见性', () => {
    const report = analyzeParts([{ cls: 'q', text: 'face_focus, boots, black dress' }], 'sd')
    expect(report.warnings.some(w => w.includes('特写镜头'))).toBe(true)
  })

  it('特写但不写鞋 → 无镜头可见性警告', () => {
    const report = analyzeParts([{ cls: 'q', text: 'face_focus, black dress, long hair' }], 'sd')
    expect(report.warnings.some(w => w.includes('特写镜头'))).toBe(false)
  })

  it('背面镜头写前胸 → 警告镜头可见性', () => {
    const report = analyzeParts([{ cls: 'q', text: 'back_view, cleavage, long hair' }], 'sd')
    expect(report.warnings.some(w => w.includes('背面镜头'))).toBe(true)
  })

  it('闭眼 + 亮晶晶眼睛 → 警告瞳孔不可见', () => {
    const report = analyzeParts([{ cls: 'q', text: 'closed_eyes, sparkling_eyes, smile' }], 'sd')
    expect(report.warnings.some(w => w.includes('瞳孔'))).toBe(true)
  })

  it('闭眼但不写瞳孔细节 → 无瞳孔警告', () => {
    const report = analyzeParts([{ cls: 'q', text: 'closed_eyes, gentle smile' }], 'sd')
    expect(report.warnings.some(w => w.includes('瞳孔'))).toBe(false)
  })

  it('赤脚与靴子同屏 → 硬冲突警告', () => {
    const report = analyzeParts([{ cls: 'q', text: 'barefoot, boots, summer' }], 'sd')
    expect(report.warnings.some(w => w.includes('赤脚'))).toBe(true)
  })

  it('俯拍与仰拍同屏 → 硬冲突警告', () => {
    const report = analyzeParts([{ cls: 'q', text: 'from_above, from_below, girl' }], 'sd')
    expect(report.warnings.some(w => w.includes('俯拍'))).toBe(true)
  })

  it('正面与背面视角同屏 → 硬冲突警告', () => {
    const report = analyzeParts([{ cls: 'q', text: 'front_view, back_view, girl' }], 'sd')
    expect(report.warnings.some(w => w.includes('正面与背面'))).toBe(true)
  })

  it('Krea 散文路径不误报（自然语言短语非独立 token）', () => {
    const report = analyzeParts([{ cls: 'q', text: 'A close-up portrait, wearing black boots and a red dress' }], 'krea2')
    expect(report.warnings.some(w => w.includes('特写镜头'))).toBe(false)
  })
})
