import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
const assert: typeof import('assert') = require('assert');
const { test }: typeof import('node:test') = require('node:test');
const { randomPromptPlan }: typeof import('../../src/utils/randomPromptAssembler.ts') = require('../../src/utils/randomPromptAssembler.ts');
const { EMOTION, SHOT, LIGHTING, COMPOSITION, COLOR_MOODS }: typeof import('../../src/config/promptConstants.ts') = require('../../src/config/promptConstants.ts');
const { createPromptPlan, renderPromptPlan }: typeof import('../../src/utils/promptCompiler.ts') = require('../../src/utils/promptCompiler.ts');
const { artistStyleProse, artistTagsForEngine, normalizeArtistStyleIds }: typeof import('../../src/config/artistStyles.ts') = require('../../src/config/artistStyles.ts');
const { ARTIST_STYLE_OPTIONS }: typeof import('../../src/config/artistStyleCatalog.ts') = require('../../src/config/artistStyleCatalog.ts');
const { mutualGroupWithCategory, isManualR18Tags }: typeof import('../../src/utils/promptPolicy.ts') = require('../../src/utils/promptPolicy.ts');
const tagsData: typeof import('../../data/tags.json') = require('../../data/tags.json');

// 与采样器同源的身份 token（断言用）：随机结果绝不能污染角色身份
const IDENTITY_TOKENS: any = {
  nene: new Set(['1girl', 'solo', 'ayachi_nene', 'white_hair', 'very_long_hair', 'low_twintails', 'purple_eyes', 'ahoge', 'pink_hair_ribbons']),
  natsume: new Set(['1girl', 'solo', 'shiki_natsume', 'very_long_black_hair', 'golden_yellow_eyes', 'two_red_hairclips', 'mole_under_eye', 'no_hair_ribbon']),
  triad: new Set(['2girls', '1girl', 'solo']),
};
const CHAR_PROMPT: any = {
  nene: '1girl, solo, ayachi_nene, white_hair, very_long_hair, low_twintails, purple_eyes, ahoge, pink_hair_ribbons',
  natsume: '1girl, solo, shiki_natsume, very_long_black_hair, golden_yellow_eyes, two_red_hairclips, mole_under_eye, no_hair_ribbon',
  triad: '2girls',
};

/** 确定性伪随机源（mulberry32）。 */
function seededRng(seed: any) {
  let state = seed >>> 0;
  return function next() {
    state |= 0; state = state + 0x6D2B79F5 | 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function makeOptions(overrides: any = {}) {
  return {
    char: 'nene',
    tags: tagsData.map(t => ({ en: t.en, cat: t.cat })),
    officialOutfits: {
      official_witch: ['nene_witch_canonical', 'witch_hat', 'black_cape', 'criss-cross_halter', 'crop_top', 'black_skirt', 'striped_thighhighs'],
      official_school: ['nene_school_uniform', 'school_uniform', 'blazer', 'yellow_bowtie', 'plaid_skirt', 'black_thighhighs'],
      official_sailor: ['nene_sailor_uniform', 'grey_sailor_collar', 'sailor_shirt'],
    },
    artists: ARTIST_STYLE_OPTIONS,
    rng: seededRng(42),
    ...overrides,
  };
}

const promptById = (list: any, id: any) => list.find((item: any) => item.id === id)?.prompt || '';

function drawToPlanInput(draw: any, char: any, engine: any) {
  return {
    identity: CHAR_PROMPT[char] || CHAR_PROMPT.nene,
    artists: artistTagsForEngine(draw.artistStyleIds, engine),
    artistProse: artistStyleProse(draw.artistStyleIds, engine),
    emotion: draw.emotions.map((id: any) => promptById(EMOTION, id)).filter(Boolean),
    camera: draw.shot ? [promptById(SHOT, draw.shot)] : [],
    lighting: draw.lighting ? [promptById(LIGHTING, draw.lighting)] : [],
    composition: draw.composition ? [promptById(COMPOSITION, draw.composition)] : [],
    colorMood: draw.colorMood ? promptById(COLOR_MOODS, draw.colorMood) : undefined,
    manual: draw.manualTags,
  };
}

test('固定种子确定性：同种子两次采样结果完全一致', () => {
  const a = randomPromptPlan(makeOptions());
  const b = randomPromptPlan(makeOptions());
  assert.deepStrictEqual(JSON.stringify(a), JSON.stringify(b));
});

test('默认无画师：includeArtists 缺省/关闭时 artistStyleIds 恒为空', () => {
  for (let i = 0; i < 100; i += 1) {
    const draw = randomPromptPlan(makeOptions({ rng: seededRng(i) }));
    assert.strictEqual(draw.artistStyleIds.length, 0, `第 ${i} 次采样应无画师`);
  }
});

test('固定画师保留：keepArtists 恒出现在结果中', () => {
  for (let i = 0; i < 100; i += 1) {
    const draw = randomPromptPlan(makeOptions({ keepArtists: ['kantoku'], rng: seededRng(i * 7 + 1) }));
    assert.ok(draw.artistStyleIds.includes('kantoku'), `第 ${i} 次采样应保留 kantoku`);
  }
});

test('随机画师：includeArtists 开启后结果全部通过白名单归一且最多 2 位', () => {
  const whitelist = new Set(ARTIST_STYLE_OPTIONS.map(option => option.id));
  for (let i = 0; i < 200; i += 1) {
    const draw = randomPromptPlan(makeOptions({ includeArtists: true, rng: seededRng(i * 13 + 5) }));
    assert.ok(draw.artistStyleIds.length <= 2, '最多 2 位画师');
    for (const id of draw.artistStyleIds) {
      assert.ok(whitelist.has(id), `画师 ${id} 必须在白名单内`);
    }
    assert.strictEqual(normalizeArtistStyleIds(draw.artistStyleIds).length, draw.artistStyleIds.length, '结果必须已归一');
  }
});

test('身份契约：任意 500 次采样，身份 token 恒不进入 manualTags', () => {
  for (const char of ['nene', 'natsume', 'triad']) {
    const identity = IDENTITY_TOKENS[char];
    for (let i = 0; i < 500; i += 1) {
      const draw = randomPromptPlan(makeOptions({ char, rng: seededRng(i * 31 + (char.charCodeAt(0))) }));
      for (const tag of draw.manualTags) {
        assert.ok(!identity.has(tag), `身份 token ${tag} 不得进入随机 manualTags`);
      }
    }
  }
});

test('互斥组：500 次采样，同掷内不出现互斥冲突（服装/时段/天气 + 室内外）', () => {
  for (let i = 0; i < 500; i += 1) {
    const draw = randomPromptPlan(makeOptions({ rng: seededRng(i * 17 + 3) }));
    const groups = new Map<string, Set<string>>();
    for (const tag of draw.manualTags) {
      const hit = mutualGroupWithCategory(tag);
      if (!hit) continue;
      const families = groups.get(hit.category) ?? new Set<string>();
      families.add(hit.group);
      groups.set(hit.category, families);
    }
    for (const [category, families] of groups) {
      assert.ok(families.size <= 1, `${category} mixes conflicting families: ${[...families]}`);
    }
    const indoor = draw.manualTags.some(tag => ['indoor', 'indoors', 'classroom', 'bedroom', 'cafe', 'library', 'living_room', 'kitchen', 'bathroom'].includes(tag));
    const outdoor = draw.manualTags.some(tag => ['beach', 'park', 'street', 'rooftop', 'shrine', 'train_station'].includes(tag));
    assert.ok(!(indoor && outdoor), `第 ${i} 次采样室内外互斥冲突`);
  }
});

test('三引擎健壮性：100 次随机 × sd/anima/krea2 渲染不抛错且语法合规', () => {
  const KREA_BANNED = /_|@|score_\d+|(?:best_quality|amazing_quality|masterpiece|very_aesthetic|absurdres|newest|highres|highly_detailed)\b|\(\s*[a-z][^)]*:\s*-?\d+(?:\.\d+)?\s*\)/i;
  for (let i = 0; i < 100; i += 1) {
    const draw = randomPromptPlan(makeOptions({ includeArtists: true, rng: seededRng(i * 23 + 9) }));
    const plan = createPromptPlan(drawToPlanInput(draw, 'nene', 'sd'));

    const sd = renderPromptPlan(plan, 'sd');
    assert.strictEqual(typeof sd.prompt, 'string');
    assert.ok(sd.prompt.length > 0);

    const anima = renderPromptPlan(createPromptPlan(drawToPlanInput(draw, 'nene', 'anima')), 'anima');
    assert.strictEqual(typeof anima.prompt, 'string');
    for (const id of draw.artistStyleIds) {
      const option = ARTIST_STYLE_OPTIONS.find(artist => artist.id === id);
      assert.ok(option, `随机画师 ${id} 必须存在于目录`);
      const tag = option.animaTag;
      assert.ok(anima.prompt.includes(tag), `Anima 输出应含画师标签 ${tag}`);
    }

    const krea = renderPromptPlan(createPromptPlan(drawToPlanInput(draw, 'nene', 'krea2')), 'krea2');
    assert.strictEqual(typeof krea.prompt, 'string');
    assert.ok(!KREA_BANNED.test(krea.prompt), `Krea 输出含违禁语法：${krea.prompt.slice(0, 120)}`);
  }
});

test('Krea 全标签单点渲染：tags.json 全量标签逐一注入不抛错且无语法泄漏', () => {
  const KREA_BANNED = /_|@|score_\d+|\(\s*[a-z][^)]*:\s*-?\d+(?:\.\d+)?\s*\)/i;
  let handled = 0;
  for (const tag of tagsData) {
    if (!tag.en) continue;
    const plan = createPromptPlan({ identity: '1girl', manual: [tag.en] });
    let output;
    try {
      output = renderPromptPlan(plan, 'krea2').prompt;
    } catch (error) {
      assert.fail(`标签 ${tag.en} 渲染崩溃：${runtimeErrorMessage(error)}`);
    }
    assert.ok(!KREA_BANNED.test(output), `标签 ${tag.en} 泄漏违禁语法`);
    if (output.trim().length > 2) handled += 1;
  }
  const coverage = handled / tagsData.length;
  // v1 保守目标 ≥ 90%：其余标签被净化/丢弃仍不破坏散文
  assert.ok(coverage >= 0.9, `Krea 可读覆盖率为 ${(coverage * 100).toFixed(1)}%，低于 90%`);
});

test('官方服装采样：triad 不抽服装，单人 100 次恒出官方或通用服装', () => {
  const clothingSet = new Set(tagsData.filter(t => t.cat === 'Clothing').map(t => t.en));
  for (let i = 0; i < 100; i += 1) {
    const draw = randomPromptPlan(makeOptions({ char: 'nene', rng: seededRng(i * 29 + 11) }));
    const hasOutfit = draw.manualTags.some(tag =>
      clothingSet.has(tag) || tag.startsWith('nene_') || tag.startsWith('natsume_'),
    );
    assert.ok(hasOutfit, `第 ${i} 次单人采样应带服装（官方或通用）`);
  }
  const triad = randomPromptPlan(makeOptions({ char: 'triad', rng: seededRng(1) }));
  assert.ok(!triad.manualTags.some(tag => tag.startsWith('nene_')), 'triad 不抽宁宁官方服装');
});

// ── 2026-08-29 随机灵感优化：Mature 提额 / 热门角色开放 / 评级联动 ──────────

test('Mature 池提额：500 次采样命中率 ≥ 35%（采样概率 50%）', () => {
  const matureSet = new Set(tagsData.filter(t => t.cat === 'Mature').map(t => t.en));
  const total = 500;
  let hit = 0;
  for (let i = 0; i < total; i += 1) {
    const draw = randomPromptPlan(makeOptions({ rng: seededRng(i * 41 + 7) }));
    if (draw.manualTags.some(tag => matureSet.has(tag))) hit += 1;
  }
  const rate = hit / total;
  assert.ok(rate >= 0.35, `Mature 命中率 ${(rate * 100).toFixed(1)}% 低于 35% 下限（应约 50%）`);
});

test('热门角色模式：identityExclude 传入后身份词恒不出现且不抽服装', () => {
  // 芙莉莲身份集（identityTokens + outfit tokens 的代表子集）
  const frierenIdentity = new Set([
    'frieren', '1girl', 'solo', 'long_white_hair', 'very_long_hair', 'twin_braids',
    'purple_eyes', 'elf', 'pointy_ears', 'gold_earrings', 'robe', 'white_robe', 'hood', 'staff',
  ]);
  const clothingSet = new Set(tagsData.filter(t => t.cat === 'Clothing').map(t => t.en));
  for (let i = 0; i < 300; i += 1) {
    const draw = randomPromptPlan(makeOptions({ identityExclude: frierenIdentity, rng: seededRng(i * 37 + 2) }));
    for (const tag of draw.manualTags) {
      assert.ok(!frierenIdentity.has(tag), `热门角色身份词 ${tag} 不得进入随机 manualTags`);
    }
    assert.ok(
      !draw.manualTags.some(tag => clothingSet.has(tag)),
      `第 ${i} 次热门角色采样不应抽通用服装（服装由 outfit 系统管理）: ${draw.manualTags.join(', ')}`,
    );
    assert.ok(!draw.manualTags.some(tag => tag.startsWith('nene_')), '热门角色模式不抽宁宁官方服装');
  }
});

test('Mature 评级联动：isManualR18Tags 覆盖词条池 Mature 全部分类词', () => {
  const matureSet = new Set(tagsData.filter(t => t.cat === 'Mature').map(t => t.en));
  const regexOnly = /^(?:nene_r18|natsume_r18|nude|completely_nude|naked|topless|nipples|bare_breasts|pussy|vaginal|penis|sex|uncensored|nsfw)$/i;
  const beyond = tagsData.filter(t => t.cat === 'Mature' && !regexOnly.test(t.en)).map(t => t.en);
  assert.ok(beyond.length > 80, `Mature 非正则词条应超过 80（实际 ${beyond.length}）`);
  for (const tag of beyond.slice(0, 60)) {
    assert.equal(isManualR18Tags([tag], matureSet), true, `Mature 词条 ${tag} 应触发 R18 评级联动`);
  }
  assert.equal(isManualR18Tags(['school_uniform'], matureSet), false, '普通词条不触发评级联动');
  assert.equal(isManualR18Tags(['nude'], matureSet), true, '正则白名单词仍触发');
});


const { appendRandomTag, visibleInRandomShot, compatibleRandomDetail }: typeof import('../../src/utils/randomPromptConstraints.ts') = require('../../src/utils/randomPromptConstraints.ts');

test('same-family details survive while conflicting outfit/time/weather families replace one another', () => {
  const tags: string[] = [];
  for (const tag of ['school_uniform', 'pleated_skirt', 'night', 'city_lights', 'rain', 'raining']) appendRandomTag(tags, tag);
  assert.deepEqual(tags, ['school_uniform', 'pleated_skirt', 'night', 'city_lights', 'rain', 'raining']);
  for (const tag of ['bikini', 'day', 'snow']) appendRandomTag(tags, tag);
  assert.deepEqual(tags, ['bikini', 'day', 'snow']);
  appendRandomTag(tags, 'Bikini');
  assert.equal(tags.length, 3, 'canonical duplicates do not accumulate');
});

test('real caller defaults have artist candidates, explicit empty lists stay empty', () => {
  let hits = 0;
  for (let seed = 0; seed < 80; seed += 1) {
    const draw = randomPromptPlan({ tags: [], includeArtists: true, rng: seededRng(seed) });
    hits += draw.artistStyleIds.length > 0 ? 1 : 0;
    assert.ok(draw.artistStyleIds.length <= 2);
    const empty = randomPromptPlan({ tags: [], artists: [], includeArtists: true, rng: seededRng(seed) });
    assert.deepEqual(empty.artistStyleIds, []);
  }
  assert.ok(hits > 30, `default artist pool must actually be reachable: ${hits}`);
});

test('duplicate IDs/spellings do not change random sampling, and compound identity tokens cannot bypass exclusion', () => {
  const tags = [{ en: 'park', cat: 'Scene' }, { en: 'library', cat: 'Scene' }, { en: 'collarbone', cat: 'Body' }];
  const repeated = [...tags, ...tags, { en: ' PARK ', cat: 'Scene' }];
  for (let seed = 0; seed < 60; seed += 1) {
    assert.deepEqual(randomPromptPlan({ tags, rng: seededRng(seed) }), randomPromptPlan({ tags: repeated, rng: seededRng(seed) }));
    const draw = randomPromptPlan({ tags: [{ en: 'collarbone, white hair', cat: 'Body' }, { en: 'white hair, park', cat: 'Scene' }],
      identityExclude: new Set(['collarbone', 'white_hair']), rng: seededRng(seed) });
    assert.ok(!draw.manualTags.includes('collarbone') && !draw.manualTags.includes('white_hair'));
    assert.ok(!draw.manualTags.some(tag => tag.includes(',')), 'bundles are individual canonical tokens');
  }
});

test('close and generic detail shots filter footwear from generic and official clothing branches', () => {
  let checked = 0;
  for (let seed = 0; seed < 300; seed += 1) {
    const draw = randomPromptPlan({ char: 'nene', tags: [{ en: 'striped_thighhighs', cat: 'Clothing' },
      { en: 'ankle_boots', cat: 'Appearance' }, { en: 'bare_legs', cat: 'Body' }],
      officialOutfits: { school: ['nene_school_uniform', 'school_uniform', 'black_thighhighs', 'brown_boots'] }, rng: seededRng(seed) });
    if (draw.shot !== 'close' && draw.shot !== 'detail') continue;
    checked += 1;
    assert.ok(draw.manualTags.every(tag => visibleInRandomShot(tag, draw.shot)), draw.manualTags.join(', '));
    assert.ok(!draw.manualTags.some(tag => /thighhighs|boots|bare_legs/.test(tag)));
  }
  assert.ok(checked > 20, 'must exercise both clothing paths under near framing');
});

test('new lighting/camera details are reachable and obey their primary-control compatibility', () => {
  const details = ['dappled_light', 'rim_lighting', 'screen_glow', 'firelight', 'three_quarter_view', 'dutch_angle', 'macro_shot'];
  const tags = details.map((en, index) => ({ en, cat: index < 4 ? 'Lighting' : 'Camera' }));
  const seen = new Set<string>();
  for (let seed = 0; seed < 1200; seed += 1) {
    const draw = randomPromptPlan({ tags, rng: seededRng(seed) });
    for (const tag of tags) if (draw.manualTags.includes(tag.en)) {
      seen.add(tag.en);
      assert.equal(compatibleRandomDetail(tag.en, tag.cat as 'Lighting' | 'Camera', draw.shot, draw.lighting), true);
    }
  }
  assert.deepEqual([...seen].sort(), [...details].sort());
});
