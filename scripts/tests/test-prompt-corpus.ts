'use strict';

// 298 场景全量语料 + 金标测试（确定性模型原生 Prompt 契约）。
// 覆盖 sceneInference 合法镜头/画幅、WAI 官方前缀与作者 LoRA 权重、
// Anima Base 下划线/去重、Anima Aesthetic 无质量/score、Krea 禁语与空负面、
// 单人净化保留 POV/牵手/互动。

const assert: typeof import('assert') = require('assert');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { test }: typeof import('node:test') = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const infer: typeof import('../../src/utils/sceneInference.ts') = require('../../src/utils/sceneInference.ts');
const policy: typeof import('../../src/utils/promptPolicy.ts') = require('../../src/utils/promptPolicy.ts');
const compiler: typeof import('../../src/utils/promptCompiler.ts') = require('../../src/utils/promptCompiler.ts');
const presets: typeof import('../../data/presets.json') = require('../../data/presets.json');
const loras: typeof import('../../data/loras.json') = require('../../data/loras.json');

const scenes = [
  ...JSON.parse(fs.readFileSync(path.join(root, 'data', 'scenes-nene.json'), 'utf8')),
  ...JSON.parse(fs.readFileSync(path.join(root, 'data', 'scenes-natsume.json'), 'utf8')),
  ...JSON.parse(fs.readFileSync(path.join(root, 'data', 'scenes-shared.json'), 'utf8')),
];

const CHAR_PROMPT = {
  nene: '1girl, solo, ayachi_nene, white_hair, very_long_hair, low_twintails, purple_eyes, ahoge, pink_hair_ribbons',
  natsume: '1girl, solo, shiki_natsume, very_long_black_hair, golden_yellow_eyes, two_red_hairclips, mole_under_eye, no_hair_ribbon',
  triad: '2girls',
};

const FALLBACK_LORA = { nene: 'ayachi_nene_v18_wd14', natsume: 'shiki_natsume_v18_wd14' };
const SUBJECT_PROSE = {
  nene: 'Ayachi Nene is the only prominent character, a young adult woman with white hair, purple eyes, an ahoge, and pink hair ribbons',
  natsume: 'Shiki Natsume is the only prominent character, a young adult woman with black hair, golden-yellow eyes, two red hairclips, and a small mole beneath one eye',
  triad: 'Ayachi Nene and Shiki Natsume are the two prominent young adult women in the scene',
};
const SHOT_PROMPT = {
  close:'close_up', medium:'medium_shot', wide:'wide_shot', pov:'pov', low:'low_angle',
  high:'high_angle', side:'side_view', turn:'looking_back', over:'selfie', detail:'close_up_detail',
};
const LIGHT_PROMPT = {
  golden:'golden_hour', window:'window_light', back:'backlit', moon:'moonlight', lantern:'lantern_light', overcast:'overcast',
};
const COMPOSITION_PROMPT = {
  center:'centered_composition', rule3:'rule_of_thirds', left:'left_composition', right:'right_composition',
  foreground:'foreground_framing', frame:'framed_composition', bywindow:'by_window',
};

// 1216x832 为 sc234（月夜主卧魔女契约）的字节级定稿尺寸（prompt-pinned-scenes.json，
// AGENTS.md 红线 #8 禁改 recommendedSize），标准 SDXL 横幅桶，纳入合法白名单。
const ORIENTATIONS = new Set(['768x1344', '1344x768', '896x896', '832x1216', '1344x896', '1216x832']);
const QUALITY_RE = /^(?:masterpiece|best_quality|amazing_quality|very_aesthetic|absurdres|newest|highres|highly_detailed)$/i;
const SCORE_RE = /^score_\d+$/i;

function charOf(scene: { char: string; }) {
  if (scene.char === 'natsume') return 'natsume'
  if (scene.char === 'triad' || scene.char === 'both') return 'triad'
  return 'nene'
}

function profileOf(id: string) {
  return presets.model_profiles.find(profile => profile.id === id) || null
}

/** 镜像 usePromptAssembly.modelProfile：把选中 LoRA 的 prompt_contract 并入 profile。 */
function animaProfile(profile: any, scene: unknown) {
  const char = charOf(scene)
  const loraId = char === 'nene' ? 'L_NENE_V21_ANIMA' : char === 'natsume' ? 'L_NAT_V21_ANIMA' : ''
  const contract = loras.find(lora => lora.id === loraId)?.prompt_contract
  if (!contract) return profile
  return Object.assign({}, profile, {
    exact_tokens: [...new Set([...(profile.exact_tokens || []), ...(contract.exact_tokens || [])])],
    exact_prefixes: [...new Set([...(profile.exact_prefixes || []), ...(contract.exact_prefixes || [])])],
  })
}

function contractExactTokens(scene: { char: string; }) {
  const char = charOf(scene)
  const loraId = char === 'nene' ? 'L_NENE_V21_ANIMA' : char === 'natsume' ? 'L_NAT_V21_ANIMA' : ''
  const contract = loras.find(lora => lora.id === loraId)?.prompt_contract
  return new Set((contract?.exact_tokens || []).map(token => String(token).toLowerCase()))
}

function planFor(scene: any, profile: any, engine: string) {
  const char = charOf(scene)
  const effective = engine === 'anima' ? animaProfile(profile, scene) : profile
  const shot = infer.sceneShot(scene)
  const lighting = infer.sceneLighting(scene)
  const composition = infer.sceneComposition(scene)
  const activeLoras = engine === 'anima'
    ? (char === 'nene' ? { nene:'L_NENE_V21_ANIMA' } : char === 'natsume' ? { natsume:'L_NAT_V21_ANIMA' } : {})
    : FALLBACK_LORA
  return compiler.createPromptPlan({
    profile: effective,
    identity: CHAR_PROMPT[char],
    controls: policy.characterControlTokens(scene, char, activeLoras),
    scenePrompt: policy.sceneTemplateText(scene, { char, shot: null, engine, profile: effective }),
    emotion: [],
    camera: shot ? [SHOT_PROMPT[shot] || ''] : [],
    lighting: lighting ? [LIGHT_PROMPT[lighting] || ''] : [],
    composition: composition ? [COMPOSITION_PROMPT[composition] || ''] : [],
    manual: [],
    negative: scene.negative || '',
    rating: policy.profileRatingTag(effective, scene) || (engine === 'sd' ? '' : policy.sceneRating(scene).toLowerCase()),
    visualDescription: '',
    subjectProse: SUBJECT_PROSE[char],
    scene: {
      title:scene.title, category:scene.category, tags:scene.tags, location:scene.location,
      time:scene.time, timeOfDay:scene.timeOfDay, weather:scene.weather, camera:scene.camera,
      lighting:scene.lighting, emotion:scene.emotion, rating:scene.rating,
      recommendedSize:scene.recommendedSize, usage:scene.usage,
      animaCaption:scene.animaCaption,
    },
  })
}

test('corpus: all scenes infer only valid shot/lighting/mood/composition ids and orientations', () => {
  // 2026-08-15 新增 4 个真正露点的 R18 场景（sc301-sc304），2026-08-23 新增 sc305；
  // 2026-08-28 删除 sc196/sc198 两个真重复场景（1a77ad7），303 → 301
  assert.strictEqual(scenes.length, 302, 'corpus must cover the full scene library');
  const shotIds = new Set(infer.SHOT_IDS)
  const lightingIds = new Set(infer.LIGHTING_IDS)
  const moodIds = new Set(infer.MOOD_IDS)
  const compositionIds = new Set(infer.COMPOSITION_IDS)
  for (const scene of scenes) {
    const shot = infer.sceneShot(scene)
    assert(shot === null || shotIds.has(shot), `${scene.id} invalid shot ${shot}`)
    const lighting = infer.sceneLighting(scene)
    assert(lighting === null || lightingIds.has(lighting), `${scene.id} invalid lighting ${lighting}`)
    const mood = infer.sceneColorMood(scene)
    assert(mood === null || moodIds.has(mood), `${scene.id} invalid mood ${mood}`)
    const composition = infer.sceneComposition(scene)
    assert(composition === null || compositionIds.has(composition), `${scene.id} invalid composition ${composition}`)
    const size = infer.sceneRecommendedSize(scene)
    assert(ORIENTATIONS.has(size), `${scene.id} invalid orientation ${size}`)
  }
})

test('golden scenes: sc001 medium/window, sc153 close, sc050 holding-hands preserved, sc280 landscape, triad set', () => {
  const byId = Object.fromEntries(scenes.map(scene => [scene.id, scene]))

  assert.strictEqual(infer.sceneShot(byId.sc001), 'medium', 'sc001 medium_shot/upper_body must resolve to medium')
  assert.strictEqual(infer.sceneLighting(byId.sc001), 'window', 'sc001 window_light must resolve to window')
  assert.strictEqual(infer.sceneRecommendedSize(byId.sc001), '832x1216', 'sc001 default portrait')

  assert.strictEqual(infer.sceneShot(byId.sc300), 'medium', 'sc300 explicit medium bar stool camera must resolve to medium')
  assert.strictEqual(infer.sceneLighting(byId.sc300), 'golden', 'sc300 explicit sunset lighting must resolve to golden')

  assert.strictEqual(infer.sceneShot(byId.sc153), 'close', 'sc153 close_up must resolve to close')

  assert.strictEqual(infer.sceneShot(byId.sc050), 'side', 'sc050 explicit Chinese side camera must resolve to side')
  // 单人净化保留 POV / 望向 viewer / 牵手 / 中心互动。
  const anima050 = policy.sceneTemplateText(byId.sc050, { char: 'natsume', engine: 'anima' })
  assert(anima050.includes('holding hands'), 'sc050 must preserve holding hands for solo engines')
  assert(anima050.includes('movie screen'), 'sc050 must preserve its cinema screen-light anchor (1326be66 肃清后月光改为银幕光)')
  assert(!/1girl|shiki_natsume|black_hair/.test(anima050), 'sc050 must drop redundant identity anchors')
  assert(anima050.includes('hand on armrest'), 'sc050 must specify the off-frame viewer hand (1326be66 改写后以扶手受力锚点表述)')

  const anima010 = policy.sceneTemplateText(byId.sc010, { char: 'nene', engine: 'anima' })
  assert(anima010.includes('holding sandals'), 'sc010 must preserve the sandals carried in its shoreline story')
  assert(!anima010.includes('holding sun hat'), 'sc010 must not substitute a sun hat for its carried sandals')

  const anima166 = policy.sceneTemplateText(byId.sc166, { char: 'nene', engine: 'anima' })
  assert(anima166.includes('backs of both hands visible to camera'), 'sc166 must constrain mirror-facing hand orientation')

  const anima280 = policy.sceneTemplateText(byId.sc280, { char: 'natsume', engine: 'anima' })
  assert(anima280.includes('holding pastry pouch'), 'sc280 must make the opaque pastry pouch explicit (防断词改写后锚点词)')

  const explicitCaptionIds = ['sc001', 'sc010', 'sc012', 'sc015', 'sc029', 'sc030', 'sc034', 'sc037', 'sc050', 'sc053', 'sc056', 'sc075', 'sc141', 'sc166', 'sc280']
  for (const id of explicitCaptionIds) {
    assert.strictEqual(typeof byId[id].animaCaption, 'string', `${id} must carry a curated Anima caption`)
    assert(byId[id].animaCaption.length > 20, `${id} curated Anima caption must not be empty`)
  }

  assert.strictEqual(infer.sceneShot(byId.sc280), null, 'sc280 banner composition must not be misread as shot distance')
  assert.strictEqual(infer.sceneRecommendedSize(byId.sc280), '1344x768', 'sc280 explicit recommendedSize wins')

  const landscapeIds = scenes.filter(scene => scene.tags?.includes('landscape'))
  assert.ok(landscapeIds.length >= 20, 'landscape-tagged scenes must exist')
  for (const scene of landscapeIds) {
    const size = infer.sceneRecommendedSize(scene)
    assert(size.startsWith('1344'), `${scene.id} landscape orientation must be wide, got ${size}`)
  }

  const triadIds = scenes.filter(scene => scene.char === 'triad')
  assert.strictEqual(triadIds.length, 6, 'triad scenes must be the shared six')
  for (const scene of triadIds) assert.strictEqual(scene.char, 'triad')
})

test('corpus: WAI LoRA parser preserves authored weight for every scene before stripping', () => {
  for (const scene of scenes) {
    const refs = policy.parseScenePromptLoras(scene)
    const hasFieldLora = String(scene.lora || '').trim().length > 0
    assert.ok(refs.length >= 1 || hasFieldLora, `${scene.id} must carry an explicit <lora:name:weight> or scene.lora`)
    for (const ref of refs) {
      assert.ok(ref.name.trim().length > 0, `${scene.id} lora name`)
      assert.ok(typeof ref.weight === 'number' && ref.weight > 0, `${scene.id} authored weight`)
    }
    const specs = policy.resolveLoraSpecs(charOf(scene), scene, loras, FALLBACK_LORA, {})
    if (refs.length) {
      assert.strictEqual(specs.length, refs.length, `${scene.id} spec count`)
      for (let index = 0; index < refs.length; index += 1) {
        assert.ok(/ayachi_nene|shiki_natsume/.test(specs[index].name), `${scene.id} canonical lora name`)
        assert.strictEqual(
          Number(specs[index].weight),
          Number(refs[index].weight),
          `${scene.id} authored lora weight must be preserved (${specs[index].weight} != ${refs[index].weight})`,
        )
      }
    } else {
      assert.ok(specs.length >= 1, `${scene.id} fallback lora spec must exist`)
      for (const spec of specs) {
        assert.ok(/ayachi_nene|shiki_natsume/.test(spec.name), `${scene.id} canonical lora name`)
        assert.ok(typeof spec.weight === 'number' && spec.weight > 0, `${scene.id} fallback weight`)
      }
    }
  }
})

test('corpus: WAI official prefix exactly once with spaces and rating once across all scenes', () => {
  const wai = profileOf('wai_illustrious_v17')
  assert(wai, 'WAI profile must exist')
  for (const scene of scenes) {
    const q = policy.qualityPrefix(wai, scene, 'sd')
    const tokens = q.split(',').map(token => token.trim())
    assert.strictEqual(tokens.filter(token => token === 'masterpiece').length, 1, `${scene.id} masterpiece once`)
    assert.strictEqual(tokens.filter(token => token === 'best quality').length, 1, `${scene.id} best quality once`)
    assert.strictEqual(tokens.filter(token => token === 'amazing quality').length, 1, `${scene.id} amazing quality once`)
    const rating = policy.profileRatingTag(wai, scene)
    if (rating) {
      assert.strictEqual(tokens.filter(token => token === rating).length, 1, `${scene.id} rating ${rating} once`)
    }
    const rendered = compiler.renderPromptPlan(planFor(scene, wai, 'sd'), 'sd', wai)
    assert.strictEqual((rendered.prompt.match(/masterpiece, best quality, amazing quality/g) || []).length, 1,
      `${scene.id} WAI prefix must appear exactly once in the rendered prompt`)
  }
})

test('corpus: Anima Base single tag stream, underscores only on score/contract tokens, no duplicates', () => {
  const base = profileOf('anima_base_v10')
  for (const scene of scenes) {
    const effective = animaProfile(base, scene)
    const rendered = compiler.renderPromptPlan(planFor(scene, base, 'anima'), 'anima', effective)
    const prompt = rendered.prompt
    const [tagStream, prose = ''] = prompt.split('\n')
    assert.strictEqual(policy.assembleNegative(effective, scene, 'anima', { shot: null, character: charOf(scene) }).length > 0, true,
      `${scene.id} anima negative must be independent of SD toggle`)
    const contract = contractExactTokens(scene)
    // BREAK 是角色作用域边界：triad 两个角色可以合法重复服装/动作。
    for (const section of tagStream.split(/\s*BREAK\s*/i)) {
      const seen = new Set()
      for (const token of section.split(',').map(item => item.trim()).filter(Boolean)) {
        const key = policy.normalizeKey(token)
        assert(!seen.has(key), `${scene.id} duplicate anima token ${token}`)
        seen.add(key)
        if (!token.includes('_')) continue
        const allowed = SCORE_RE.test(key)
          || /^(?:ayachi_nene|shiki_natsume)$/i.test(key)
          || /^(?:nene_|natsume_)[a-z0-9_]+$/i.test(key)
          || contract.has(key)
        assert(allowed, `${scene.id} unexpected underscore token ${token}`)
      }
    }
    assert(tagStream.includes('best quality'), `${scene.id} Base must carry official quality prefix`)
    assert(tagStream.includes('score_7'), `${scene.id} Base must carry score_7`)
    assert.strictEqual(prose.split(/(?<=\.)\s/).filter(Boolean).length, 1, `${scene.id} studio Anima caption must stay at one sentence`)
    assert(!/[\u3400-\u9fff]/.test(prose), `${scene.id} Anima prose must not leak untranslated metadata`)
  }
})

test('corpus: Anima Aesthetic strips all quality/score tokens from positive and score from negative', () => {
  const aesthetic = profileOf('anima_aesthetic_v11')
  assert.strictEqual(aesthetic.strip_quality_tokens, true, 'Aesthetic profile must declare strip_quality_tokens')
  for (const scene of scenes) {
    const effective = animaProfile(aesthetic, scene)
    const rendered = compiler.renderPromptPlan(planFor(scene, aesthetic, 'anima'), 'anima', effective)
    const positiveTokens = rendered.prompt.split('\n')[0].split(',').map(token => token.trim()).filter(Boolean)
    for (const token of positiveTokens) {
      assert(!QUALITY_RE.test(token) && !SCORE_RE.test(token), `${scene.id} Aesthetic positive leaked ${token}`)
    }
    const negative = policy.assembleNegative(effective, scene, 'anima', { shot: null, character: charOf(scene) })
    for (const token of negative.split(',').map(token => token.trim()).filter(Boolean)) {
      assert(!SCORE_RE.test(token), `${scene.id} Aesthetic negative leaked score token ${token}`)
    }
  }
})

test('corpus: Krea 2 forbids underscores/lora/score/quality/weights and keeps negative empty', () => {
  const krea = profileOf('krea2_turbo_fp8')
  for (const scene of scenes) {
    const rendered = compiler.renderPromptPlan(planFor(scene, krea, 'krea2'), 'krea2', krea)
    assert.strictEqual(rendered.negative, '', `${scene.id} Krea negative must be empty`)
    const prompt = rendered.prompt
    assert.ok(prompt.length > 0, `${scene.id} Krea prompt must not be empty`)
    assert(!/[a-z]+_[a-z]+/i.test(prompt), `${scene.id} Krea must not carry danbooru underscores`)
    assert(!/<lora:/i.test(prompt), `${scene.id} Krea must not carry LoRA syntax`)
    assert(!/score_\d+/i.test(prompt), `${scene.id} Krea must not carry score tokens`)
    assert(!/masterpiece|best_quality|amazing_quality|very_aesthetic|absurdres/i.test(prompt), `${scene.id} Krea must not carry quality tokens`)
    assert(!/:\s*-?\d+(?:\.\d+)?\b/.test(prompt.replace(/\d+:\d+/g, '')), `${scene.id} Krea must not carry weights`)
    assert(!/[\u3400-\u9fff]/.test(prompt), `${scene.id} Krea must not leak untranslated scene metadata`)
    const sentences = prompt.split(/(?<=\.)\s/).filter(Boolean)
    assert.ok(sentences.length >= 3 && sentences.length <= 6,
      `${scene.id} Krea should read as 3-6 visual sentences, got ${sentences.length}`)
  }
})
