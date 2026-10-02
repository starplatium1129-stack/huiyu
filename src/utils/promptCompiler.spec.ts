import { describe, expect, it } from 'vitest'
import { plainEnglish, createPromptPlan, renderPromptPlan } from './promptCompiler'
import { formatPromptForEngine, splitBreaks } from './promptPolicy'
import { environmentPhrase } from './promptPhraseTables'
import { usePromptAssembly } from '../composables/prompt/usePromptAssembly'
import { ref } from 'vue'
import sharedScenes from '../../data/scenes/shared.json'

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

/** 当前 Krea 规则（.agents/skills/studio-prompt-craft/references/krea.md）的行为回归：
 *  1) medium 媒介词收尾——此前被 sanitize
 *     但从未织入渲染输出，此处验证织入与防重复；
 *  2) 空场景散文追加 "no characters, no people, no figures"。 */
describe('renderPromptPlan krea2', () => {
  it('preserves ordinary break words while consuming uppercase structural BREAK', () => {
    for (const engine of ['anima', 'krea2'] as const) {
      const prose = renderPromptPlan(createPromptPlan({
        subjectProse: 'A woman', sceneProse: 'During a break beside the breakwater. BREAK Break time continues.',
      }), engine).prompt
      expect(prose).toContain('During a break beside the breakwater')
      expect(prose).toContain('Break time continues')
      expect(prose).not.toContain('BREAK')
      const tags = formatPromptForEngine('taking a break, BREAK, break, windbreaker', engine)
      expect(tags).toContain('taking a break')
      expect(tags).toContain('break, windbreaker')
    }
    expect(splitBreaks('taking a break, BREAK, reading')).toEqual(['taking a break', 'reading'])
  })

  it('places known indoor settings in the environment and keeps outdoor weather and bookstore identity', () => {
    for (const setting of ['backstage', 'supermarket', 'aquarium', 'mirrored_elevator_walls']) {
      const { prompt } = renderPromptPlan(createPromptPlan({
        subjectProse: 'A woman', scenePrompt: setting, scene: { weather: '晴' },
      }), 'krea2')
      expect(prompt).toMatch(/The scene takes place (?:inside|indoors)/)
      expect(prompt).not.toContain('beneath a clear sky')
    }
    const bookstore = renderPromptPlan(createPromptPlan({ subjectProse: 'A woman', scene: { location: '旧书店', weather: '晴' } }), 'krea2').prompt
    expect(bookstore).toContain('inside a bookstore')
    expect(bookstore).not.toMatch(/inside a library|beneath a clear sky/)
    const beach = renderPromptPlan(createPromptPlan({ subjectProse: 'A woman', scene: { location: '海边', weather: '晴' } }), 'krea2').prompt
    expect(beach).toContain('beneath a clear sky')
    expect(environmentPhrase('bamboo_broom')).toBe('with bamboo broom')
    expect(environmentPhrase('empty_classroom')).toBe('inside empty classroom')
  })

  it('keeps clothing and location nouns inside actions even with an explicit outfit', () => {
    const actions = 'sweeping_shrine_steps_with_bamboo_broom, skirt_hem_caught_on_flower_stand, hand_gripping_dress_edge, tripping_on_long_kimono_hem, squeezing_sweater_sleeve'
    for (const outfitProse of ['', 'a blue dress']) {
      const { prompt } = renderPromptPlan(createPromptPlan({
        subjectProse: 'A woman', outfitProse, scenePrompt: `white_dress, ${actions}`,
      }), 'krea2')
      const action = prompt.split('She is ')[1]
      expect(action).toContain('sweeping the shrine steps with a bamboo broom')
      expect(action).toContain('caught by her skirt hem on a flower stand')
      expect(action).toContain('gripping the edge of her dress with one hand')
      expect(action).toContain('tripping on the hem of her long kimono')
      expect(action).toContain('squeezing her sweater sleeve')
      expect(prompt.split('She is ')[0]).not.toMatch(/caught|gripping|tripping|squeezing/)
      expect(prompt).not.toContain('inside sweeping')
      if (outfitProse) expect(prompt).not.toContain('white dress')
    }
  })

  it('binds each studio woman to her own appearance, position, clothes and actions through assembly', () => {
    for (const id of ['sc028', 'sc031']) {
      const scene = sharedScenes.find(scene => scene.id === id)!
      const pb = {
        char: 'triad', charPrompt: '2girls', activeScene: scene, modelProfiles: [], characters: [], loraMeta: [],
        tags: [], manualTags: new Set<string>(), directorMode: 'basic', artistStyleIds: [],
        selections: {}, sdParams: {}, emotionPrompt: '', visualDescription: '',
      } as unknown as Parameters<typeof usePromptAssembly>[0]
      const { positivePrompt } = usePromptAssembly(pb, ref(''), ref('krea2'), ref('krea2'), ref(''))
      const prompt = positivePrompt.value
      const nene = prompt.split('Ayachi Nene on the left: ')[1].split('; Shiki Natsume')[0]
      const natsume = prompt.split('Shiki Natsume on the right: ')[1].split('.')[0]
      expect(nene).toMatch(/white hair.*purple eyes.*pink hair ribbons/)
      expect(natsume).toMatch(/black hair.*mole under eye.*two red hairclips/)
      expect(prompt).not.toMatch(/\bShe is\b|\bher expression is\b|2girls|no characters/)
      if (id === 'sc028') {
        expect(nene).toContain('Nene is holding a marriage contract')
        expect(nene).toContain("Nene is interlacing her fingers with the viewer's")
        expect(natsume).toContain("Natsume is fixing Nene's hair ornament")
        expect(prompt).toContain('elegant white wedding gowns')
      } else {
        expect(nene).toMatch(/white formal gown.*holding the viewer's right hand/)
        expect(natsume).toMatch(/black formal gown.*holding the viewer's left hand/)
      }
    }
  })

  it.each(['anima', 'krea2'] as const)('does not invent a style or background for an undirected character in %s', engine => {
    const plan = createPromptPlan({
      identity: '1girl, solo, black_hair',
      subjectProse: 'A woman with black hair',
      manual: ['blue_background', 'simple_background', 'monochrome'],
    })
    const { prompt } = renderPromptPlan(plan, engine, null)
    expect(prompt).toMatch(/blue[_ ]background/)
    expect(prompt).not.toMatch(/polished|cel shading|flat colors|layered background|cinematic atmosphere|wallpaper/)
  })

  it('retains manual background priority alongside authored scene prose without replacing the subject or action', () => {
    const base = {
      subjectProse: 'Misono Mika from Blue Archive, with pastel pink hair', outfitProse: 'a blue coat',
      sceneProse: 'She holds an open book beside a stone path in a garden.',
      camera: ['close_up'], lighting: ['moonlight'], composition: ['off-center composition'],
    }
    for (const background of [['forest'], ['blue_background', 'simple_background']]) {
      const plan = createPromptPlan({ ...base, manual: ['standing', ...background] })
      const original = JSON.stringify(plan)
      for (const engine of ['anima', 'krea2'] as const) {
        const { prompt, negative } = renderPromptPlan(plan, engine)
        for (const token of background) expect(prompt).toContain(token.replace(/_/g, ' '))
        expect(prompt).toContain('Misono Mika')
        expect(prompt).toContain('blue coat')
        expect(prompt).toContain('standing')
        expect(prompt).toContain(base.sceneProse.replace(/\.$/, ''))
        expect(prompt).toMatch(/close-up.*off-center composition.*moonlight/)
        if (engine === 'krea2') {
          expect(prompt).toContain(`For the background, use ${background.map(tag => tag.replace(/_/g, ' ')).join(' and ')} in preference to the earlier setting`)
          expect(prompt).not.toMatch(/no characters|no people|no figures|_/)
          expect(negative).toBe('')
        }
      }
      expect(JSON.stringify(plan)).toBe(original)
    }
  })

  it('limits the background override to manual environment tags and restores inheritance when cleared', () => {
    const base = { subjectProse: 'A woman', sceneProse: 'A garden beside a stone path.', scenePrompt: 'garden' }
    const render = (manual: string[]) => renderPromptPlan(createPromptPlan({ ...base, manual }), 'krea2').prompt
    const inherited = render([])
    expect(inherited).toContain(base.sceneProse)
    expect(inherited).not.toContain('in preference to the earlier setting')
    expect(render(['forest'])).toContain('For the background, use forest in preference to the earlier setting')
    const otherControls = render(['sweeping_shrine_steps_with_bamboo_broom', 'window_light', 'from_above', 'smile'])
    expect(otherControls).toContain('sweeping the shrine steps with a bamboo broom')
    expect(otherControls).toContain('soft window light')
    expect(otherControls).toContain('a view from above')
    expect(otherControls).toContain('smiling')
    expect(otherControls).not.toContain('in preference to the earlier setting')
    expect(render([])).toBe(inherited)
  })

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
