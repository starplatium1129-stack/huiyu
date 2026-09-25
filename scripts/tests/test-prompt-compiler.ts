const assert: typeof import('assert') = require('assert');
const { test }: typeof import('node:test') = require('node:test');
const compiler: typeof import('../../src/utils/promptCompiler.ts') = require('../../src/utils/promptCompiler.ts');
const policy: typeof import('../../src/utils/promptPolicy.ts') = require('../../src/utils/promptPolicy.ts');
const animaRoute: typeof import('../../routes/anima.js') = require('../../routes/anima.js');
const presets: typeof import('../../data/presets.json') = require('../../data/presets.json');
const loras: typeof import('../../data/loras.json') = require('../../data/loras.json');
const artistStyles: typeof import('../../src/config/artistStyles.ts') = require('../../src/config/artistStyles.ts');
const artistCatalog: typeof import('../../src/config/artistStyleCatalog.ts') = require('../../src/config/artistStyleCatalog.ts');

test('prompt compiler keeps story and search metadata outside all model families', () => {
  const input = {
    story: '这是故事，不可见的心理活动，以及“台词”',
    identity: '1girl, ayachi_nene, white_hair',
    controls: ['natsume_r18', 'natsume_cafe_uniform'],
    exactTokens: ['natsume_r18', 'natsume_cafe_uniform'],
    scenePrompt: 'warm_lighting, cafe interior',
    visualDescription: 'Nene stands beside a rain-covered cafe window.',
    manual: [],
  };
  const anima = compiler.renderPromptPlan(compiler.createPromptPlan(input), 'anima');
  const krea = compiler.renderPromptPlan(compiler.createPromptPlan(input), 'krea2');
  const sd = compiler.renderPromptPlan(compiler.createPromptPlan(input), 'sd');
  for (const value of [anima.prompt, anima.negative, krea.prompt, krea.negative, sd.prompt, sd.negative]) {
    assert(!value.includes('official_cg'), 'scene search metadata must not be compiled');
    assert(!value.includes('visual_audited'), 'audit metadata must not be compiled');
    assert(!value.includes('这是故事'), 'story must never be compiled');
    assert(!value.includes('台词'), 'dialogue must never be compiled');
  }
  assert(anima.prompt.includes('natsume_r18'));
  assert(anima.prompt.includes('natsume_cafe_uniform'));
  assert(anima.prompt.includes('warm lighting'));
  assert(!anima.prompt.includes('<lora:'));
  assert(!anima.prompt.includes('A visual novel event CG'), 'anima prose tail must not use meta phrases');
  assert(!krea.prompt.includes('masterpiece'));
  assert(!krea.prompt.includes('score_'));
  assert(!krea.prompt.includes('Identity is not guaranteed'));
  assert(!krea.prompt.includes('natsume_r18'));
  assert(!krea.prompt.includes('natsume_cafe_uniform'));
  assert(!krea.prompt.includes(':1.4'));
  assert.strictEqual(krea.negative, '');
  for (const value of [krea.prompt, anima.prompt]) {
    assert(!/(?:In this image|The image shows|Scene details:|Composition and lighting|A visual novel event CG featuring)/i.test(value), 'must not leak meta phrases');
  }
  assert(!/[a-z]+_[a-z]+/i.test(krea.prompt), 'krea prose must not carry raw danbooru tokens');
  // 官方服装触发词映射为自然英文词组（docs/model-prompting-and-parameters-guide 排查点 2），不得被擦除。
  const clothed = compiler.renderPromptPlan(compiler.createPromptPlan({
    identity: 'ayachi_nene, nene_school_uniform, white_hair',
    scenePrompt: 'natsume_cafe_uniform, warm_lighting',
    manual: [],
  }), 'krea2');
  assert(clothed.prompt.includes('navy school uniform'), 'nene_school_uniform must map to readable navy school uniform');
  assert(/cafe maid uniform/i.test(clothed.prompt), 'natsume_cafe_uniform must map to readable cafe maid uniform');
  assert(!clothed.prompt.includes('nene_school_uniform'), 'raw trigger token must not leak into krea prose');
  assert(krea.prompt.includes('Nene stands beside a rain-covered cafe window.'), 'krea must weave visualDescription prose verbatim');
  assert(/warm lighting/i.test(krea.prompt) && /inside a cafe/i.test(krea.prompt), 'krea must weave scene fragments as readable prose');
  assert.strictEqual(policy.formatPromptForEngine('natsume_r18, natsume_cafe_uniform, warm_lighting', 'anima'), 'natsume_r18, natsume_cafe_uniform, warm lighting');
  assert.strictEqual(policy.formatPromptForEngine('nene_school_uniform, natsume_cafe_uniform', 'anima', [], ['nene_', 'natsume_']), 'nene_school_uniform, natsume_cafe_uniform');
});

test('prompt compiler renders curated artist styles in each model-native syntax', () => {
  const sd = compiler.renderPromptPlan(compiler.createPromptPlan({ identity:'1girl', artists:['kantoku', 'rella'] }), 'sd');
  assert.ok(sd.prompt.includes('kantoku') && sd.prompt.includes('rella'));
  const anima = compiler.renderPromptPlan(compiler.createPromptPlan({ identity:'1girl', artists:['@kantoku', '@mika pikazo'] }), 'anima');
  assert.ok(anima.prompt.includes('@kantoku') && anima.prompt.includes('@mika pikazo'));
  const krea = compiler.renderPromptPlan(compiler.createPromptPlan({
    identity:'1girl', style:['A polished anime key visual'], artistProse:'with visual styling inspired by Kantoku and Rella',
  }), 'krea2');
  assert.ok(krea.prompt.startsWith('A polished anime key visual, with visual styling inspired by Kantoku and Rella.'));
  assert.ok(!krea.prompt.includes('@kantoku') && !krea.prompt.includes('mika_pikazo'));
});

test('artist style catalog is unique, allowlisted, limited, and model-native', () => {
  const ids = artistCatalog.ARTIST_STYLE_OPTIONS.map(option => option.id);
  // 2026-08-30 收录 @gweda/@eufoniuz/@solar_(happymonk)+6 位用户点名画师后为 44 位；2026-08-31 收录明日方舟系 4 位（xiayehongming/huanxiang_heitu/liduke/alchemaniac）后为 48 位；2026-09-05 b9b8eaa0 收录 asano_kyoji/isayama_hajime/yokoyari_mengo/wei_at_w 后为 52 位；2026-09-17 5e0c796 收录 hidulume 后为 53 位
  assert.strictEqual(ids.length, 53);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.deepStrictEqual(artistStyles.normalizeArtistStyleIds(['kantoku', 'rella', 'swav', 'unknown']), ['kantoku', 'rella']);
  assert.deepStrictEqual(artistStyles.normalizeArtistStyleIds(['azure', 'rella']), ['azuuru', 'rella']);
  assert.deepStrictEqual(artistStyles.artistTagsForEngine(['mika_pikazo', 'so-bin'], 'sd'), ['mika_pikazo', 'so-bin']);
  assert.deepStrictEqual(artistStyles.artistTagsForEngine(['mika_pikazo', 'so-bin'], 'anima'), ['@mika pikazo', '@so-bin']);
  assert.deepStrictEqual(artistStyles.artistTagsForEngine(['muririn', 'kobuichi'], 'anima'), ['@muririn', '@kobuichi']);
  // 消歧括号是画师名称的一部分，必须转义以免被 ComfyUI 当作权重语法。
  assert.deepStrictEqual(artistStyles.artistTagsForEngine(['hiten_(hitenkei)', 'ask_(askzy)'], 'anima'), [String.raw`@hiten \(hitenkei\)`, String.raw`@ask \(askzy\)`]);
  assert.deepStrictEqual(artistStyles.artistTagsForEngine(['lam_(ramdayo)'], 'anima'), [String.raw`@lam \(ramdayo\)`]);
  assert.deepStrictEqual(artistStyles.artistTagsForEngine(['azuuru'], 'anima'), ['@azuuru']);
  assert.strictEqual(artistStyles.artistStyleProse(['bunbun', 'rella']), 'with visual styling inspired by Bunbun and Rella');
  assert.strictEqual(artistStyles.artistStyleProse(['yoneyama_mai', 'lack']), 'with visual styling inspired by Yoneyama Mai and Lack');
  assert.strictEqual(artistStyles.artistStyleProse(['azuuru', 'rella']), 'with visual styling inspired by Azure and Rella');
  // Krea2 不识别 Danbooru tag，必须输出自然语言风格描述而非 @tag / 下划线。
  const kreaProse = artistStyles.artistStyleProse(['muririn', 'kobuichi'], 'krea2');
  assert.ok(kreaProse.includes('Yuzusoft-style'), 'Krea2 prose must use natural style descriptors');
  assert.ok(!kreaProse.includes('@') && !kreaProse.includes('_'), 'Krea2 prose must not contain Danbooru tag syntax');
  assert.deepStrictEqual(ids.filter(id => artistStyles.normalizeArtistStyleIds([id]).length !== 1), []);
  assert.deepStrictEqual(
    artistCatalog.ARTIST_STYLE_OPTIONS.filter(option => option.verification === 'project').map(option => option.id),
    ['muririn', 'kobuichi'],
  );
  // 2026-08-30 收录 @gweda/@eufoniuz/@solar_(happymonk)（均 verification=tag）后为 13 位
  assert.strictEqual(artistCatalog.ARTIST_STYLE_OPTIONS.filter(option => option.verification === 'tag').length, 15);
});

test('artist token previews match the compiled catalog for both tag engines', () => {
  for (const option of artistCatalog.ARTIST_STYLE_OPTIONS) {
    for (const [engine, preview] of [['sd', option.waiTag], ['anima', option.animaTag]]) {
      const artists = artistStyles.artistTagsForEngine([option.id], engine as any);
      assert.deepStrictEqual(artists, [preview], `${engine} preview differs for ${option.id}`);
      const output = compiler.renderPromptPlan(compiler.createPromptPlan({ identity: '1girl', artists }), engine as any);
      assert.strictEqual(output.prompt, `1girl, ${preview}`);
    }
  }
});

test('Anima artist name escapes survive compilation, JSON transport, and both workflow branches', () => {
  const cases = [
    ['ask_(askzy)', String.raw`@ask \(askzy\)`],
    ['hiten_(hitenkei)', String.raw`@hiten \(hitenkei\)`],
    ['lam_(ramdayo)', String.raw`@lam \(ramdayo\)`],
    ['solar_(happymonk)', String.raw`@solar \(happymonk\)`],
  ];
  for (const [id, expectedTag] of cases) {
    const artists = artistStyles.artistTagsForEngine([id], 'anima');
    const output = compiler.renderPromptPlan(compiler.createPromptPlan({
      identity: '1girl', artists, manual: ['(soft lighting:1.2)'],
    }), 'anima');
    assert.strictEqual(output.prompt, `1girl, ${expectedTag}, (soft lighting:1.2)`);
    assert.strictEqual(policy.formatPromptForEngine(output.prompt, 'anima'), output.prompt,
      'reformatting must not double-escape artist names or change explicit weights');
    for (const model of [
      { modelId: 'anima-miaomiao-v1.2' },
      { modelId: 'anima-base-v1.0', loraId: 'L_NENE_V21_ANIMA', loraStrength: 0.85, character: 'nene' },
    ]) {
      const body = JSON.parse(JSON.stringify({
        ...model, prompt: output.prompt, width: 832, height: 1216, seed: 42,
      }));
      const input = animaRoute.validateInput(body, 'anima');
      const graph = animaRoute.buildWorkflow(input);
      const sampler = Object.values(graph).find(node => node.class_type === 'KSampler');
      assert.ok(sampler, 'workflow must have a sampler');
      const positiveNode = graph[sampler.inputs.positive[0]];
      assert.strictEqual(positiveNode.class_type, 'CLIPTextEncode');
      assert.strictEqual(positiveNode.inputs.text, output.prompt, `${id} / ${model.modelId}`);
    }
    assert.deepStrictEqual(artistStyles.artistTagsForEngine([id], 'sd'), [id]);
    assert.deepStrictEqual(artistStyles.artistTagsForEngine([id], 'krea2'), []);
  }
});

test('Krea official style LoRA is allowlisted and family-scoped', () => {
  const input = animaRoute.validateInput({ prompt: 'a rainy cafe', modelId: 'krea2-turbo-fp8', width: 1024, height: 1024, styleLoraId: 'rainywindow' }, 'krea2');
  const graph = animaRoute.buildWorkflow(input);
  assert.strictEqual(graph['12'].class_type, 'LoraLoaderModelOnly');
  assert.strictEqual(graph['12'].inputs.lora_name, 'krea2_rainywindow.safetensors');
  assert.strictEqual(graph['12'].inputs.strength_model, 1);
  assert.throws(() => animaRoute.validateInput({ prompt: 'x', modelId: 'anima-base-v1.0', loraId: 'L_NENE_V21_ANIMA', loraStrength: 0.85, width: 832, height: 1216, character: 'nene', styleLoraId: 'rainywindow' }, 'anima'), /Style LoRA/);
  assert.throws(() => animaRoute.validateInput({ prompt: 'x', modelId: 'krea2-turbo-fp8', width: 1024, height: 1024, styleLoraId: 'not-approved' }, 'krea2'), /未知 Krea/);
});

test('prompt compiler: Krea style leads the automatic 3-5 sentence description', () => {
  const input = {
    identity: 'a girl with long hair',
    scenePrompt: 'a quiet cafe interior',
    visualDescription: 'she wears a navy dress',
    style: ['A polished visual novel event CG with refined cel shading'],
    medium: 'visual novel event CG',
  };
  const krea = compiler.renderPromptPlan(compiler.createPromptPlan(input), 'krea2');
  assert(krea.prompt.startsWith('A polished visual novel event CG with refined cel shading.'),
    'style language must come first');
  const sentences = krea.prompt.split(/(?<=\.)\s/).filter(Boolean);
  assert.ok(sentences.length >= 3 && sentences.length <= 5, `Krea must stay concise, got ${sentences.length} sentences`);
  assert.strictEqual((krea.prompt.match(/visual novel event CG/gi) || []).length, 1, 'medium must not duplicate the style lead');
  assert(!/[a-z]+_[a-z]+/i.test(krea.prompt), 'no raw tokens even with style phrases');
});

test('prompt compiler renders Anima style exactly once while SD keeps style tags', () => {
  const plan = compiler.createPromptPlan({ identity: '1girl', style: ['cel shaded anime', 'cel shaded anime'] });
  const anima = compiler.renderPromptPlan(plan, 'anima').prompt;
  const sd = compiler.renderPromptPlan(plan, 'sd').prompt;
  assert.strictEqual((anima.match(/cel shaded anime/gi) || []).length, 1);
  assert.strictEqual((sd.match(/cel shaded anime/gi) || []).length, 1);
});

test('Anima keeps exact LoRA tags and adds one short visual-directing sentence', () => {
  const profile = { quality_prefix: 'masterpiece, best_quality, score_7', exact_tokens: [], exact_prefixes: ['nene_'] };
  const plan = compiler.createPromptPlan({
    profile,
    identity: '1girl, solo, ayachi_nene, white_hair, purple_eyes',
    controls: ['nene_school_uniform'],
    scenePrompt: 'holding_papers, waiting, classroom_window, classroom, afternoon, window_light, medium_shot',
    rating: 'safe',
    subjectProse: 'Ayachi Nene is the only prominent character, a young adult woman with white hair and purple eyes',
    scene: { title: '不可进入提示词的标题', location: '教室', timeOfDay: 'afternoon', weather: '晴' },
  });
  const prompt = compiler.renderPromptPlan(plan, 'anima', profile).prompt;
  const [tags, prose] = prompt.split('\n');
  assert.ok(tags.includes('nene_school_uniform'), 'exact LoRA control must remain in the native tag stream');
  assert.ok(tags.includes('holding papers') && tags.includes('classroom window'));
  assert.ok(/holding (?:a stack of )?papers/.test(prose) && prose.includes('inside a classroom'));
  assert.strictEqual(prose.split(/(?<=\.)\s/).filter(Boolean).length, 1, 'automatic studio Anima direction must stay at one sentence');
  assert.ok(!prompt.includes('不可进入提示词的标题'));
  assert.ok(!/[\u3400-\u9fff]/.test(prose), 'automatic prose must not leak untranslated scene metadata');
});

test('structured Chinese scene fields reach Anima and Krea without leaking Chinese metadata', () => {
  const plan = compiler.createPromptPlan({
    identity: '1girl, ayachi_nene',
    scenePrompt: 'sitting_on_bar_stool, holding_one_coffee_cup, cafe, golden_hour, full_body',
    subjectProse: 'Ayachi Nene is the only prominent character',
    scene: {
      location: '闭店后的暖金咖啡馆', weather: '晴朗夕照', camera: '纵向全身三分之四视角',
      lighting: '拱窗夕阳与室内暖灯的柔和轮廓光',
    },
  });
  const anima = compiler.renderPromptPlan(plan, 'anima').prompt.split('\n')[1];
  const krea = compiler.renderPromptPlan(plan, 'krea2').prompt;
  for (const prompt of [anima, krea]) {
    assert.match(prompt, /cafe/i);
    assert.match(prompt, /full-body wide shot/i);
    assert.match(prompt, /three-quarter view/i);
    assert.match(prompt, /golden-hour light/i);
    assert.match(prompt, /warm lighting/i);
    assert.match(prompt, /rim light/i);
    assert(!/[\u3400-\u9fff]/.test(prompt), 'structured Chinese fields must be translated, not copied');
  }
});

test('automatic Anima caption keeps prop relationships ahead of generic poses', () => {
  const prompt = compiler.renderPromptPlan(compiler.createPromptPlan({
    identity: '1girl, ayachi_nene',
    scenePrompt: 'standing, looking_at_viewer, holding_one_coffee_cup',
    subjectProse: 'Ayachi Nene is the only prominent character',
    scene: { location: '咖啡馆' },
  }), 'anima').prompt.split('\n')[1];
  assert.match(prompt, /holding one coffee cup/i);
  assert.match(prompt, /looking toward the viewer/i);
  assert.doesNotMatch(prompt, /She is standing/i);
});

test('Anima action prose keeps composite hand, prop, and wrapper relationships', () => {
  const rendered = compiler.renderPromptPlan(compiler.createPromptPlan({
    subjectProse: 'Ayachi Nene is the only prominent character',
    scenePrompt: [
      'one_hand_adjusting_hair_ribbon',
      'holding_papers_in_other_arm',
      'carrying_sandals_in_one_hand',
      'holding_one_clearly_wrapped_sweet_with_visible_folded_paper_wrapper_in_both_cupped_hands_toward_viewer',
    ].join(', '),
  }), 'anima').prompt;
  assert.ok(rendered.includes('using one hand to adjust her pink hair ribbon'));
  assert.ok(rendered.includes('holding lecture papers securely in her other arm'));
  assert.ok(rendered.includes('carrying her sandals visibly in one hand'));
  assert.ok(rendered.includes('folded paper wrapper fully visible'));
});

test('Anima studio scene caption overrides automatic prose without repeating identity', () => {
  const prompt = compiler.renderPromptPlan(compiler.createPromptPlan({
    identity: '1girl, ayachi_nene, white_hair',
    subjectProse: 'Ayachi Nene is the only prominent character with white hair',
    scenePrompt: 'classroom, holding_papers',
    scene: { animaCaption: 'Ayachi Nene points at one open exam paper while seated behind a classroom desk' },
  }), 'anima').prompt;
  const prose = prompt.split('\n')[1];
  assert.strictEqual(prose, 'Ayachi Nene points at one open exam paper while seated behind a classroom desk.');
  assert.strictEqual((prose.match(/white hair/gi) || []).length, 0);
});

test('creative catalog rejects Krea LoRA/negative and emits the official Krea core workflow', () => {
  const input = animaRoute.validateInput({ prompt: 'A rainy cafe scene.', modelId: 'krea2-turbo-fp8', width: 1024, height: 1024, seed: 7 });
  assert.strictEqual(input.family, 'krea2');
  assert.strictEqual(input.steps, 12);
  assert.strictEqual(input.cfg, 1);
  for (const size of [[1024, 1536], [1536, 1024]]) {
    const sized = animaRoute.validateInput({ prompt: 'x', modelId: 'krea2-turbo-fp8', width: size[0], height: size[1] });
    assert.deepStrictEqual([sized.width, sized.height], size);
  }
  assert.throws(() => animaRoute.validateInput({ prompt: 'x', modelId: 'krea2-turbo-fp8', width: 1024, height: 1024, steps: 7 }), /steps/);
  assert.throws(() => animaRoute.validateInput({ prompt: 'x', modelId: 'krea2-turbo-fp8', width: 1024, height: 1024, cfg: 3 }), /CFG/);
  assert.throws(() => animaRoute.validateInput({ prompt: 'x', modelId: 'krea2-turbo-fp8', width: 1024, height: 1024, loraId: 'L_NENE_V21_ANIMA' }), /Krea/);
  assert.throws(() => animaRoute.validateInput({ prompt: 'x', negative: 'bad anatomy', modelId: 'krea2-turbo-fp8', width: 1024, height: 1024 }), /Krea/);
  const workflow = animaRoute.buildWorkflow(input);
  const classes = Object.values(workflow).map(node => node.class_type);
  assert.deepStrictEqual(classes, ['UNETLoader', 'CLIPLoader', 'VAELoader', 'CLIPTextEncode', 'ConditioningZeroOut', 'EmptyLatentImage', 'KSampler', 'VAEDecode', 'SaveImage', 'ConditioningKrea2Rebalance', 'ComfyUI-Krea2T-Enhancer', 'ImageSharpenKJ']);
  assert.strictEqual(workflow['2'].inputs.type, 'krea2');
  assert.strictEqual(workflow['7'].inputs.steps, 12);
  assert.strictEqual(workflow['7'].inputs.cfg, 1);
  assert.strictEqual(workflow['7'].inputs.sampler_name, 'er_sde');
  assert.strictEqual(workflow['7'].inputs.scheduler, 'simple');
  assert.deepStrictEqual(workflow['7'].inputs.negative, ['5', 0]);
  // 2026-08-23 链路替换：Krea 图无条件经 T-Enhancer 采样并落盘 RCAS 锐化结果。
  assert.strictEqual(workflow['14'].class_type, 'ComfyUI-Krea2T-Enhancer');
  assert.deepStrictEqual(workflow['7'].inputs.model, ['14', 0]);
  assert.strictEqual(workflow['15'].class_type, 'ImageSharpenKJ');
  assert.deepStrictEqual(workflow['10'].inputs.images, ['15', 0]);
});

test('Anima rating and controls remain aligned without safe/R18 contradiction', () => {
  const profile = { quality_prefix: 'best_quality', rating_all: 'safe', rating_r18: 'nsfw', exact_tokens: [], exact_prefixes: ['nene_'] };
  const safe = compiler.renderPromptPlan(compiler.createPromptPlan({ profile, identity: 'ayachi_nene', controls: ['nene_school_uniform'], rating: 'safe' }), 'anima', profile);
  const adult = compiler.renderPromptPlan(compiler.createPromptPlan({ profile, identity: 'ayachi_nene', controls: ['nene_r18'], rating: 'nsfw' }), 'anima', profile);
  assert(safe.prompt.includes('safe'));
  assert(safe.prompt.includes('nene_school_uniform'));
  assert(!safe.prompt.includes('nene_r18'));
  assert(adult.prompt.includes('nsfw'));
  assert(adult.prompt.includes('nene_r18'));
});

test('Anima profiles do not bind one character and LoRA contracts own exact controls from the selected service LoRA id', () => {
  const animaProfiles: any[] = presets.model_profiles.filter(profile => profile.engine === 'anima');
  for (const profile of animaProfiles) {
    assert.strictEqual(profile.lora_id, undefined);
    assert.strictEqual(profile.lora_name, undefined);
    assert.strictEqual(profile.lora_strength, undefined);
    assert.deepStrictEqual(profile.exact_tokens, [], 'profile must not carry family-level exact tokens');
    assert.strictEqual(profile.steps, 30, 'Anima profiles must default to the validated 30 steps');
  }
  const nene = loras.find(lora => lora.id === 'L_NENE_V21_ANIMA');
  const natsume = loras.find(lora => lora.id === 'L_NAT_V21_ANIMA');
  assert(nene!.prompt_contract!.exact_prefixes.includes('nene_'));
  assert(natsume!.prompt_contract!.exact_prefixes.includes('natsume_'));
  assert(!nene!.prompt_contract!.exact_prefixes.includes('natsume_'));
  assert(!natsume!.prompt_contract!.exact_prefixes.includes('nene_'));
});

test('WAI profile owns the adaptive automatic hires preset', () => {
  const wai = presets.model_profiles.find(profile => profile.id === 'wai_illustrious_v17');
  assert.ok(wai);
  assert.strictEqual(wai.steps, 30);
  assert.strictEqual(wai.cfg, 6);
  assert.strictEqual(wai.sampler, 'Euler a');
  // 2026-08-31 对齐 78fd83d P0-6：hires_fix 有意默认关（basic 模式下不可见且关不掉，
  // 每次出图默认多跑 1.5x/20 步二阶段）。预设能力仍在（Auto 放大/1.5x/20 步/0.4 降噪），
  // 仅默认开关为 false，expert 模式可手动开启。
  assert.strictEqual(wai.hires_fix, false);
  assert.strictEqual(wai.hires_upscaler, 'Auto');
  assert.strictEqual(wai.hires_scale, 1.5);
  assert.strictEqual(wai.hires_steps, 20);
  assert.strictEqual(wai.hires_denoising_strength, 0.4);
});
