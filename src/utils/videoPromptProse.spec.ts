import { describe, expect, it } from 'vitest'
import { tagsToVideoProse } from './videoPromptProse'

/**
 * tagsToVideoProse 契约（绘图词条流 → H3 视频自然语言）：
 *  - 质量/安全/评分类无意义词条丢弃
 *  - 权重括号与整词强调括号剥离、下划线转空格
 *  - 主体计数词 + 首个发色/瞳色 组装主句「a girl with red hair and red eyes」
 *  - CJK 散文与疑似自然语言输入原样返回（不做 tag 重拼）
 */
describe('tagsToVideoProse', () => {
  it('文档基准例：丢质量词、主体与外观组装成主句', () => {
    expect(tagsToVideoProse('safe, 1girl, solo, red hair, red eyes, techwear, dorm room'))
      .toBe('a girl with red hair and red eyes, solo, techwear, dorm room')
    expect(tagsToVideoProse('1girl, solo, blue hair, blue eyes, maid outfit'))
      .toBe('a girl with blue hair and blue eyes, solo, maid outfit')
  })

  it('质量/评分/来源词条全部丢弃', () => {
    const out = tagsToVideoProse(
      'masterpiece, best quality, safe, absurdres, rating:explicit, source:pixiv, 1girl, smile',
    )
    expect(out).toBe('a girl, smile')
  })

  it('权重括号与整词强调括号被剥离', () => {
    // ≥5 tokens 才判定为词条流；不足则按自然语言原样返回（直通契约）
    const out = tagsToVideoProse('1girl, (red hair:1.3), (blue eyes), white dress, night, window light, smile')
    expect(out).toBe('a girl with red hair and blue eyes, white dress, night, window light, smile')
  })

  it('下划线转空格（与 Anima 空格消歧规则同向）', () => {
    const out = tagsToVideoProse('1girl, solo, surtr_(arknights), long_hair, looking_at_viewer, night')
    expect(out).toContain('surtr (arknights)')
    expect(out).not.toContain('_')
  })

  it('无主体计数词时回退 a figure', () => {
    const out = tagsToVideoProse('red hair, blue eyes, techwear, dorm room, night, window')
    expect(out.startsWith('a figure with red hair and blue eyes')).toBe(true)
    expect(tagsToVideoProse('long hair, red eyes, black dress, night city, neon'))
      .toMatch(/^a figure with long hair and red eyes/)
  })

  it('CJK 散文原样返回（禁止按逗号重拼损伤中文标点）', () => {
    const input = '深夜的咖啡店，宁宁擦拭着杯子，夏目推门而入，两人相视一笑'
    expect(tagsToVideoProse(input)).toBe(input)
    expect(tagsToVideoProse('少女撑着伞，走在雨里')).toBe('少女撑着伞，走在雨里')
  })

  it('空输入返回空串，长词条流不按旧版 1200 字符上限截断', () => {
    expect(tagsToVideoProse('')).toBe('')
    expect(tagsToVideoProse('   ')).toBe('')
    const manyTags = Array.from({ length: 400 }, (_, i) => `tag_${i % 50}`).join(', ')
    const out = tagsToVideoProse('1girl, red hair, ' + manyTags)
    expect(out.length).toBeGreaterThan(1200)
    expect(out.startsWith('a girl with red hair')).toBe(true)
  })

  it('带权重的质量词被剔除，角色与场景内容仍保留', () => {
    const out = tagsToVideoProse('(masterpiece:1.2), (best quality:1.1), (surtr_(arknights):0.9), 1girl, solo, techwear_jacket, dorm room')
    expect(out).not.toMatch(/masterpiece|best quality/)
    expect(out).toContain('surtr (arknights)')
    expect(out).toContain('techwear jacket')
    expect(out).toContain('dorm room')
  })

  it('少于 5 个 token 或平均长度过长时视为自然语言，原样返回', () => {
    expect(tagsToVideoProse('a cinematic shot of the two heroines in a cozy cafe at night')).toBe(
      'a cinematic shot of the two heroines in a cozy cafe at night',
    )
    expect(tagsToVideoProse('1girl, solo')).toBe('1girl, solo')
    const sentence = 'A silver-haired girl stands by the library window, snow falling softly outside, warm lamplight on her face.'
    expect(tagsToVideoProse(sentence)).toBe(sentence)
  })
})
