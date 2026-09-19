import { describe, expect, it } from 'vitest'
import { plainEnglish, createPromptPlan, renderPromptPlan } from './promptCompiler'

/** plainEnglish：仅放行「纯 ASCII 可打印」的英文短语文本；其余（CJK/空/非字符串）归零。
 *  这是词条→英文短语映射链的守门函数——中文场景描述必须走映射表而非直通。 */
describe('plainEnglish', () => {
  it('纯 ASCII 英文短语原样返回并去除首尾空白', () => {
    expect(plainEnglish('  inside a bedroom  ')).toBe('inside a bedroom')
    expect(plainEnglish('night, window light')).toBe('night, window light')
  })

  it('含 CJK 的输入一律拒绝', () => {
    expect(plainEnglish('卧室')).toBe('')
    expect(plainEnglish('bedroom 卧室')).toBe('')
  })

  it('空值与非字符串安全归零', () => {
    expect(plainEnglish('')).toBe('')
    expect(plainEnglish(null)).toBe('')
    expect(plainEnglish(undefined)).toBe('')
  })
})

/** Krea 2 调研报告（docs/research/prompts/krea2-prompt-research-2026-08-30.md）落地行为：
 *  1) medium 媒介词收尾（官方「命名工作室收尾」，§四/§五.2）——此前被 sanitize
 *     但从未织入渲染输出，此处验证织入与防重复；
 *  2) 空场景散文追加 "no characters, no people, no figures"（§七/§八）。 */
describe('renderPromptPlan krea2', () => {
  it('medium 未出现在 lead 中时，以 polished X finish 收尾织入散文', () => {
    const plan = createPromptPlan({
      style: ['A 1990s cel anime illustration with bold outlines, crisp line art and nostalgic flat colors'],
      medium: 'retro cel anime illustration',
      subjectProse: 'A schoolgirl with a ponytail',
      outfitProse: 'a sailor uniform',
      sceneProse: 'a retro classroom at dusk',
      camera: ['medium_shot'],
      lighting: ['window_light'],
    })
    const { prompt, negative } = renderPromptPlan(plan, 'krea2', null)
    expect(prompt).toContain('Polished retro cel anime illustration finish.')
    expect(negative).toBe('')
  })

  it('medium 已含于 lead 时不再重复织入（防 "visual novel event CG" 双写）', () => {
    const plan = createPromptPlan({
      style: ['A polished visual novel event CG with refined cel shading, flat colors and crisp character work'],
      medium: 'visual novel event CG',
      subjectProse: 'A young anime woman with long silver hair',
      outfitProse: 'a white summer dress',
      sceneProse: 'a sunlit school courtyard',
    })
    const { prompt } = renderPromptPlan(plan, 'krea2', null)
    expect(prompt.match(/visual novel event CG/gi)?.length ?? 0).toBe(1)
  })

  it('空场景（无主体）散文自动追加 no characters, no people, no figures', () => {
    const plan = createPromptPlan({
      style: ['A vibrant anime key visual with crisp line art, flat cel shading and saturated colors'],
      medium: 'anime key visual',
      sceneProse: 'a serene mountain lake at dawn with mist over the water',
      camera: ['wide_shot'],
      lighting: ['golden_hour'],
    })
    const { prompt } = renderPromptPlan(plan, 'krea2', null)
    expect(prompt).toContain('no characters, no people, no figures')
  })

  it('有人物主体的场景不追加 no characters', () => {
    const plan = createPromptPlan({
      style: ['A vibrant anime key visual with crisp line art, flat cel shading and saturated colors'],
      subjectProse: 'A young anime woman with long silver hair and violet eyes',
      outfitProse: 'a white summer dress',
      sceneProse: 'standing in a sunlit school courtyard, cherry blossoms falling',
    })
    const { prompt } = renderPromptPlan(plan, 'krea2', null)
    expect(prompt).not.toContain('no characters, no people, no figures')
  })

  it('把导演台色彩情调写进 Krea 自然语言与 Anima 标签请求', () => {
    const plan = createPromptPlan({
      subjectProse: 'A young anime woman with long silver hair',
      palette: ['pink theme', 'warm light'],
    })
    expect(renderPromptPlan(plan, 'krea2', null).prompt).toContain('color palette uses pink theme and warm light')
    expect(renderPromptPlan(plan, 'anima', null).prompt.split('\n')[0]).toContain('pink theme, warm light')
  })
})
