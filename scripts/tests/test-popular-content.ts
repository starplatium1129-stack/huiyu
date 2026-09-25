'use strict';

let assert: typeof import('assert') = require('assert');
let fs: typeof import('fs') = require('fs');
let path: typeof import('path') = require('path');
let test: typeof import('node:test') = require('node:test');
let popular: typeof import('../../src/utils/popularContent.ts') = require('../../src/utils/popularContent.ts');
let recipes: typeof import('../../src/config/kreaStyleRecipes.ts') = require('../../src/config/kreaStyleRecipes.ts');
let persistence: typeof import('../../src/utils/promptBuilderPersistence.ts') = require('../../src/utils/promptBuilderPersistence.ts');
let animaRoute: typeof import('../../routes/anima.js') = require('../../routes/anima.js');

let ROOT = path.resolve(__dirname, '..', '..');
function readData(file: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', file), 'utf8'));
}
let characterData: unknown = readData('popular-characters.json');
let blueprintData: unknown = readData('scene-blueprints.json');

let coverageRepairs: typeof import('./fixtures/scene-coverage-repairs.json') = require('./fixtures/scene-coverage-repairs.json');
let { hasAtmosphericSceneProse }: typeof import('./scene-prose-contract') = require('./scene-prose-contract');
let characters = popular.parsePopularCharacters(characterData);
let blueprints = popular.parseSceneBlueprints(blueprintData);

let sfwOnlyIds = new Set(characters.filter(c => c.adultEligibility !== 'adult').map(c => c.id));
let legacyAdultIds = new Set(['shiina_mashiro', 'izumi_sagiri', 'takarada_rikka', 'hayasaka_ai', 'arima_kana', 'hori_kyouko']);
let remainingOnboarding = (require('../../data/popular-onboarding.json') as typeof import('../../data/popular-onboarding.json')).characters;
let onboardingIds = new Set(remainingOnboarding.map(c => c.id));
let extendedOnboardingIds = new Set(remainingOnboarding.filter(c => c.sceneCount > 10).map(c => c.id));

test('explicit SFW composition survives core and showcase guards without relaxing adult gates', () => {
  const policy: typeof import('../../src/utils/blueprintComposition.ts') = require('../../src/utils/blueprintComposition.ts');
  const generator: typeof import('../maintenance/generate-popular-showcase-anima11.js') = require('../maintenance/generate-popular-showcase-anima11.js');
  const profile: any = (require('../../data/presets.json') as typeof import('../../data/presets.json')).model_profiles.find(p => p.model_id === 'anima-miaomiao-v1.2');
  const tokens = (text: any) => text.split(',').map((t: any) => t.trim().toLowerCase().replaceAll('_', ' '));
  for (const id of ['marcille_donato_sfw_b9_01', 'togawa_sakiko_sfw_b9_06', 'illyasviel_grail_war']) {
    const b = blueprints.find(b => b.id === id)!, c = characters.find(c => c.id === b!.characterId)!;
    const p = generator.buildCandidate(c, b, profile, 1), neg = tokens(p.negative);
    assert.ok(!/single girl only|one person only|no other person|single subject only/.test(p.prompt), id);
    assert.ok(!tokens(p.prompt.split('\n')[0]).includes('solo'), id + ' identity must allow composition');
    for (const token of ['multiple girls', 'second person', 'two people', '2girls']) assert.ok(!neg.includes(token), id + ': ' + token);
    assert.ok(neg.includes('nude'), 'SFW content protection remains');
    if (b!.compositionIntent === 'triptych') {
      assert.ok(/three sequential panels/.test(p.prompt));
      for (const token of ['triptych', 'comic strip', 'multiple frames', 'duplicated subject', 'same character twice']) assert.ok(!neg.includes(token), token);
    } else {
      assert.ok(neg.includes('duplicate'), 'group still prevents accidental clones');
      assert.ok(neg.includes('triptych'), 'group remains one frame');
    }
    const k = popular.buildPopularPromptPlan({character:c,blueprint:b,outfit:popular.findOutfit(c,b!.outfitId!)!,engine:'krea2',adultEnabled:false});
    assert.ok(k && k.prompt.includes(b!.promptProse.split('.')[0]));
    assert.strictEqual(popular.buildPopularPromptPlan({character:c,blueprint:{...b,adult:true},outfit:popular.findOutfit(c,b!.outfitId!)!,engine:'anima',profile: profile as any,adultEnabled:false}),null);
    assert.strictEqual(policy.compositionIntent({...b,adult:true}), 'single');
  }
  assert.throws(() => policy.parseCompositionIntent('anything'), /Invalid/);
  assert.strictEqual(policy.parseCompositionIntent(undefined), 'single');
  const ordinary = blueprints.find(b => !b.adult && b.compositionIntent === 'single');
  const c = characters.find(c => c.id === ordinary!.characterId);
  const a = generator.buildCandidate(c, ordinary, profile, 1);
  const without = {...ordinary}; delete without.compositionIntent;
  const b = generator.buildCandidate(c, without, profile, 1);
  assert.strictEqual(a.prompt, b.prompt); assert.strictEqual(a.negative, b.negative);
  assert.ok(a.prompt.includes('(single girl only:1.4), (one person only:1.4)'));
  assert.ok(tokens(a.negative).includes('triptych'));
  assert.ok(policy.showcaseSubjectGuards({adult:true,compositionIntent:'group'}).prompt.includes('(solo:1.5)'));
});
let onboardingExtraSceneCount = remainingOnboarding.reduce((sum, c) => sum + Math.max(0, c.sceneCount - 10), 0);

test('remaining batches: complete roster, ten scenes each, MiaoMiao default and both-engine compilation', function () {
  const fs: typeof import('node:fs') = require('node:fs'), path: typeof import('node:path') = require('node:path');
  const planSource = fs.readFileSync(path.join(__dirname, '../../docs/research/characters/future-popular-characters-candidate-plan.md'), 'utf8');
  const candidateNames = [...planSource.matchAll(/^#### 🎭 ([^（\r\n]+)/gm)].map(m => m[1].trim());
  assert.strictEqual(candidateNames.length, 49);
  for (const name of candidateNames) assert.ok(characters.some(c => c.displayName === name), name + ' from the approved candidate plan must be registered');
  const { resolveModelProfile }: typeof import('../../src/utils/promptPolicy.ts') = require('../../src/utils/promptPolicy.ts');
  const catalog = persistence.parsePresetCatalog((require('../../data/presets.json') as typeof import('../../data/presets.json')));
  assert.strictEqual(onboardingIds.size, 36);
  const counts: any = {};
  for (const entry of remainingOnboarding) {
    counts[entry.batch] = (counts[entry.batch] || 0) + 1;
    const character = characters.find(c => c.id === entry.id);
    assert.ok(character, entry.id + ' must appear in the parsed catalog');
    assert.strictEqual(character.recommendedEngine, 'anima-miaomiao-v1.2');
    const owned = blueprints.filter(b => b.characterId === entry.id);
    const expectedSceneCount = entry.sceneCount;
    assert.ok(expectedSceneCount === 6 || expectedSceneCount === 10 || expectedSceneCount === 11,
      entry.id + ' must use a supported onboarding scene count');
    assert.strictEqual(owned.length, expectedSceneCount, entry.id + ' must have its complete parsed scene set');
    assert.strictEqual(entry.sceneCount, owned.length);
    assert.strictEqual(typeof entry.portraitPending, 'boolean');
    if (!entry.portraitPending) {
      for (const asset of [`assets/characters/popular-${entry.id}.png`, `assets/characters/thumbs/popular-${entry.id}.webp`, `assets/particles/p_${entry.id}.json`]) {
        assert.ok(fs.existsSync(path.join(__dirname, '../..', asset)), entry.id + ' published portrait requires ' + asset);
      }
    }
    assert.strictEqual(owned.filter(blueprint => blueprint.adult).length,
      expectedSceneCount >= 10 ? (entry.id === 'yukinoshita_haruno' ? 5 : 4) : 0,
      entry.id + ' adult scene count must follow its eligibility');
    for (const blueprint of owned) {
      const outfit: any = character.outfits.find(o => o.id === blueprint.outfitId);
      assert.ok(outfit, blueprint.id + ' must resolve an outfit');
      if (blueprint.adult) {
        assert.strictEqual(character.adultEligibility, 'adult');
        assert.strictEqual(blueprint.sampleRating, 'R18');
      }
      for (const engine of ['anima', 'krea2'] as const) {
        const model = engine === 'anima' ? 'anima-miaomiao-v1.2' : 'krea2-turbo-fp8';
        const profile: any = resolveModelProfile(catalog.modelProfiles, model, engine);
        const plan = popular.buildPopularPromptPlan({ character, outfit, blueprint, engine, profile, adultEnabled: true });
        assert.ok(plan, blueprint.id + ' must compile for ' + engine);
        assert.strictEqual(plan.adult, blueprint.adult);
        if (!blueprint.adult) assert.ok(!/\bnsfw\b|\bnude\b|\blingerie\b|bare breasts|exposed pussy/i.test(plan.prompt));
        if (engine === 'krea2') assert.strictEqual(plan.negative, '');
      }
    }
  }
  assert.deepStrictEqual(counts, { 6: 10, 7: 10, 8: 7, 9: 9 });
});

test('new onboarding SFW coverage includes authored bridal and beach variants', function () {
  for (const entry of remainingOnboarding) {
    const owned = blueprints.filter(blueprint => blueprint.characterId === entry.id && !blueprint.adult);
    const bridal = owned.find(blueprint => blueprint.outfitId === 'sfw_bridal');
    const beach = owned.find(blueprint => blueprint.outfitId === 'sfw_beach');
    assert.ok(bridal, entry.id + ' must include a bridal SFW scene');
    assert.ok(beach, entry.id + ' must include a beach SFW scene');
    assert.ok(bridal.promptTokens.some(token => /wedding|bridal|veil/.test(token)), bridal.id + ' must carry bridal tokens');
    assert.ok(beach.promptTokens.some(token => /beach|swimsuit|ocean|sea/.test(token)), beach.id + ' must carry beach tokens');
    assert.ok(bridal.promptProse.length >= 300 && bridal.promptProse.length <= 500, bridal.id + ' prose must stay within SFW density range');
    assert.ok(beach.promptProse.length >= 300 && beach.promptProse.length <= 500, beach.id + ' prose must stay within SFW density range');
  }
});

test('batch five: six migrated adult characters each have six SFW plus four R18 scenes', function () {
  const ids = [...legacyAdultIds];
  const { resolveModelProfile }: typeof import('../../src/utils/promptPolicy.ts') = require('../../src/utils/promptPolicy.ts');
  const catalog = persistence.parsePresetCatalog((require('../../data/presets.json') as typeof import('../../data/presets.json')));
  for (const id of ids) {
    const character = characters.find(c => c.id === id);
    assert.ok(character, id + ' must be registered');
    assert.strictEqual(character.adultEligibility, 'adult');
    const owned = blueprints.filter(b => b.characterId === id);
    assert.strictEqual(owned.length, 10, id + ' needs six SFW and four adult scenes');
    assert.strictEqual(owned.filter(b => b.adult).length, 4, id + ' needs four adult scenes');
    for (const blueprint of owned) {
      if (blueprint.adult) assert.strictEqual(blueprint.sampleRating, 'R18');
      const outfit: any = character.outfits.find(o => o.id === blueprint.outfitId);
      assert.ok(outfit, blueprint.id + ' must resolve its exact outfit');
      for (const engine of ['anima', 'krea2'] as const) {
        const model = engine === 'anima' ? 'anima-miaomiao-v1.2' : 'krea2-turbo-fp8';
        const profile: any = resolveModelProfile(catalog.modelProfiles, model, engine);
        const plan = popular.buildPopularPromptPlan({ character, outfit, blueprint, engine, profile, adultEnabled: true });
        assert.ok(plan, blueprint.id + ' must compile for ' + engine);
        assert.strictEqual(plan.adult, blueprint.adult);
        if (!blueprint.adult) assert.ok(!/rating:explicit|\bnsfw\b|\bnude\b|bare breasts|exposed pussy/i.test(plan.prompt), blueprint.id + ' positive prompt must stay SFW');
        if (engine === 'krea2') assert.strictEqual(plan.negative, '');
      }
    }
  }
});

test('popular data: preserve existing catalog, unique ids, exactly one default outfit per character', function () {
  // 2026-08-31 扩容：新增 11 位现象级角色（波奇酱/EVA双壁/芙宁娜/胡桃/卡芙卡/优香/伊织/德克萨斯/拉普兰德/薇薇安娜），57 -> 68。
  // 2026-09-02 扩容：新增 7 位顶流热门角色（艾莲·乔/星见雅/柴郡/大凤/一之濑明日奈/露西/2B），68 -> 75。
  // 2026-09-02 柚子社专栏：新增 3 位千恋万花核心角色（丛雨/常陆茉子/朝武芳乃），75 -> 78。
  // 2026-09-02 灰色果实专栏：新增 4 位核心角色（风见一姬/周防天音/小岭幸/春寺由梨亚JB），78 -> 82。
  // 2026-09-02 天降与出包专栏：新增 6 位核心角色（伊卡洛斯/小暗/菈菈/梦梦/古手川唯/娜娜），82 -> 88。
  // 2026-09-02 第一批殿堂级女神：新增 5 位角色（莉雅丝/朱乃/雅儿贝德/花火/C.C.，5 位各 11 蓝图 = +55 场景，93 角色 = 994 场景）。
  // 2026-09-02 第二批型月神作三大源流：新增 5 位角色（两仪式/爱尔奎特/希耶尔/卡莲/黑呆，5 位各 11 蓝图 = +55 场景，98 角色 = 1049 场景）。
  assert.strictEqual(characters.length, 116 + legacyAdultIds.size + onboardingIds.size,
    'preserve the existing catalog alongside the six migrated adult and 36 onboarding characters');
  let ids = new Set(characters.map(function (character) { return character.id; }));
  assert.strictEqual(ids.size, characters.length, 'character ids must be unique');
  characters.forEach(function (character) {
    // 2026-08-24 B1 衣橱扩容：上限 8 -> 10（陈衍生服装试点 10 套；后续角色扩容按需再演进）。
    assert.ok(character.outfits.length >= 2 && character.outfits.length <= 10, character.id + ' must have 2-10 outfits (researched official skins + derived casual wear)');
    let defaults = character.outfits.filter(function (outfit) { return outfit.default; });
    assert.strictEqual(defaults.length, 1, character.id + ' must have exactly one default outfit');
    let outfitIds = new Set(character.outfits.map(function (outfit) { return outfit.id; }));
    assert.strictEqual(outfitIds.size, character.outfits.length, character.id + ' outfit ids must be unique');
    assert.ok(character.identityTokens.length > 0, character.id + ' needs identityTokens');
    assert.ok(character.exactTokens.length > 0, character.id + ' needs exactTokens');
    assert.ok(character.supportedEngines.includes('anima-miaomiao-v1.2') || character.supportedEngines.includes('anima-aesthetic-v1.1'), character.id + ' must support Anima MiaoMiao or Aesthetic');
    assert.ok(character.supportedEngines.includes('krea2-turbo-fp8'), character.id + ' must support Krea 2');
  });
    // 2026-08-21 exactTokens 括号消歧按 Anima 官方空格规则（A/B 实测还原度不降）：
    // `rem (re zero)` 而非 Danbooru 下划线形式——Anima tokenizer 不做下划线转换。
    assert.strictEqual(popular.findCharacter!(characters, 'rem_rezero')!.exactTokens[0], 'rem (re zero)', 'rem must use the space-form disambiguated tag');
  assert.strictEqual(popular.findCharacter!(characters, 'emilia_rezero')!.exactTokens[0], 'emilia (re zero)', 'emilia must use the space-form disambiguated tag');
  assert.strictEqual(popular.findCharacter!(characters, 'kisara_engage_kiss')!.exactTokens[0], 'kisara (engage kiss)', 'kisara must use the space-form disambiguated tag');
let adults = characters.filter(function (character) { return character.adultEligibility === 'adult'; });
  let nonAdults = characters.filter(function (character) { return character.adultEligibility !== 'adult'; });
  assert.ok(adults.length >= 1, 'at least one clearly-adult character must be available for adult blueprints');
  // 原有成年资格约定由专属任务维护，本次只审计 SFW。
  nonAdults.forEach(function (character) {
    assert.ok(!blueprints.some(b => b.characterId === character.id && b.adult), character.id + ' non-adult characters must not include adult scenes');
  });
});

test('popular data: all character fields never leak nene/natsume anchors', function () {
  characters.forEach(function (character) {
    // 全字段扫描：identityTokens/exactTokens/identityProse/aliases/exactPrefixes/outfit prose+tokens。
    let leaks = popular.scanCharacterPollution(character);
    assert.deepStrictEqual(leaks, [], character.id + ' leaked studio LoRA anchors: ' + leaks.join(' | '));
    character.identityTokens.concat(character.exactTokens).forEach(function (token) {
      assert.ok(!/(?:ayachi_nene|shiki_natsume|^nene_|^natsume_)/i.test(token),
        character.id + ' leaked studio LoRA token ' + token);
    });
  });
  let synthetic = JSON.parse(JSON.stringify(characters[0]));
  synthetic.identityProse = 'a girl who looks like ayachi_nene in the rain';
  assert.deepStrictEqual(popular.scanCharacterPollution(synthetic), ['raiden_shogun.identityProse: studio character name']);
  synthetic.identityProse = 'plain prose';
  synthetic.outfits[0].tokens = ['nene_school_uniform', 'school_uniform'];
  assert.deepStrictEqual(popular.scanCharacterPollution(synthetic), ['raiden_shogun.outfit.shogun_robes: studio control prefix']);
});

test('blueprints: preserve existing scenes, add adult onboarding batches, and fail closed for non-adults', function () {
  // 2026-08-15 扩容：新增 15 位方舟/终末地热门角色；2026-08-18 新增 9 位跨作品热门角色
  // （43 角色 = 9x6 + 27x10 + 7x11 = 401 场景）；
  // 2026-08-18 审视优化：9 位新角色场景补足至每角色 10 个（6 原型 + 4 成人）
  // （43 角色 = 36x10 + 7x11 = 437 场景）；
  // 2026-08-23 场景库二次优化：海梦补 cosplay 泛用套日常场景（后台试装），
  // （43 角色 = 35x10 + 8x11 = 438 场景）。
  // 2026-08-24 B1 衣橱扩容试点（陈）：衍生服装入库配套专属场景，
  // 陈 11 -> 14（43 角色 = 35x10 + 7x11 + 1x14 = 441 场景）；
  // 2026-08-27 圣园未花专属晨曦私语场景扩容（全年龄+纯白裸态NSFW，未花 13 -> 15，48 角色 = 34x10 + 8x11 + 5x13 + 1x15 = 508 场景）。
  // 2026-08-30 明日方舟「令」接入（ling_arknights，6 原型 + 4 成人，49 角色 = 35x10 + 8x11 + 5x13 + 1x15 = 518 场景）。
  // 2026-08-31 新增 8 位热门角色（各 6 原型 + 4 成人，57 角色 = 43x10 + 8x11 + 5x13 + 1x15 = 598 场景）。
  // 2026-08-31 新增 11 位现象级角色（11 位角色各 11 蓝图 = +121 场景，68 角色 = 719 场景）。
  // 2026-09-02 新增 7 位顶流热门角色（7 位角色各 11 蓝图 = +77 场景，75 角色 = 796 场景）。
  // 2026-09-02 柚子社专栏：新增 3 位千恋万花核心角色（3 位角色各 11 蓝图 = +33 场景，78 角色 = 829 场景）。
  // 2026-09-02 灰色果实专栏：新增 4 位核心角色（4 位角色各 11 蓝图 = +44 场景，82 角色 = 873 场景）。
  // 2026-09-02 天降与出包专栏：新增 6 位核心角色（6 位角色各 11 蓝图 = +66 场景，88 角色 = 939 场景）。
  // 2026-09-02 第一批殿堂级女神：新增 5 位角色（5 位角色各 11 蓝图 = +55 场景，93 角色 = 994 场景）。
  // 2026-09-02 第二批型月神作三大源流：新增 5 位角色（5 位角色各 11 蓝图 = +55 场景，98 角色 = 1049 场景）。
  assert.strictEqual(blueprints.length, 1249 + legacyAdultIds.size * 10 + onboardingIds.size * 10 + onboardingExtraSceneCount + coverageRepairs.additions.length,
    'preserve existing scenes alongside the complete adult onboarding batches');
  let ids = new Set(blueprints.map(function (blueprint) { return blueprint.id; }));
  assert.strictEqual(ids.size, blueprints.length, 'blueprint ids must be unique');
  let byCharacter: any = {};
  blueprints.forEach(function (blueprint) {
    let text = JSON.stringify(blueprint);
    assert.ok(!/(?:ayachi_nene|shiki_natsume|nene_|natsume_)/i.test(text), blueprint.id + ' must not reference studio LoRA tokens');
    assert.ok(!/(?:official_cg|visual_audited)/i.test(text), blueprint.id + ' must not leak retrieval metadata');
    assert.ok(blueprint.promptProse.length > 20, blueprint.id + ' needs a prose prompt');
    assert.ok(blueprint.promptTokens.length > 0, blueprint.id + ' needs prompt tokens');
    if (blueprint.characterId) byCharacter[blueprint.characterId] = (byCharacter[blueprint.characterId] || 0) + 1;
  });
  // 每个角色 10、11、13 或 15 个场景：10=6 原型+4 成人（43 既有角色 + 6 第五批 + 36 第六至九批）、11=7 原型+4 成人（67 角色）、
  // 13=陈/日奈/和纱/时/莉音扩容（5 角色）、15=未花专属双场景扩容（1 角色）。
  let sceneDist: any = {};
  Object.entries(byCharacter).forEach(function (entry) {
    const additionCount = coverageRepairs.additions.filter(item => item.characterId === entry[0]).length;
    if (additionCount) {
      assert.strictEqual(entry[1], (coverageRepairs.baselineCounts as Record<string, any>)[entry[0]] + additionCount, entry[0] + ' must add only its declared wardrobe scenes');
    }
    else if (onboardingIds.has(entry[0])) {
      const onboardingEntry = remainingOnboarding.find(item => item.id === entry[0]);
      assert.strictEqual(entry[1], onboardingEntry!.sceneCount, entry[0] + ' must own the declared onboarding scene count');
    }
    else assert.ok(entry[1] === 10 || entry[1] === 11 || entry[1] === 13 || entry[1] === 15, entry[0] + ' must preserve its existing scene count, got ' + entry[1]);
    sceneDist[entry[1]] = (sceneDist[entry[1]] || 0) + 1;
  });
  const expectedSceneDist: any = {
    10: 43 + legacyAdultIds.size + onboardingIds.size - extendedOnboardingIds.size,
    11: 66 + extendedOnboardingIds.size,
    13: 6,
    15: 1,
  };
  for (const [id, count] of Object.entries(coverageRepairs.baselineCounts)) {
    const next = count + coverageRepairs.additions.filter(item => item.characterId === id).length;
    expectedSceneDist[count] -= 1;
    expectedSceneDist[next] = (expectedSceneDist[next] || 0) + 1;
  }
  assert.deepStrictEqual(sceneDist, expectedSceneDist,
    'remaining batches add the declared daily/adult scenes without removing existing content');
  assert.strictEqual(blueprints.filter(function (blueprint) { return !blueprint.characterId; }).length, 0,
    'every blueprint must belong to a character (generic blueprints were removed)');
  // 每角色 4、5 或 6 个带 characterId 的成人场景。
  let adultDist: any = {};
  Object.entries(byCharacter).forEach(function (entry) {
    let adultOwned = blueprints.filter(function (blueprint) { return blueprint.characterId === entry[0] && blueprint.adult; });
    if (sfwOnlyIds.has(entry[0])) {
      assert.strictEqual(adultOwned.length, 0, entry[0] + ' must remain non-adult');
      return;
    }
    assert.ok(adultOwned.length === 4 || adultOwned.length === 5 || adultOwned.length === 6 || adultOwned.length === 10,
      entry[0] + ' must own 4, 5 or 6 character-specific adult scenes, got ' + adultOwned.length);
    adultDist[adultOwned.length] = (adultDist[adultOwned.length] || 0) + 1;
  });
  assert.deepStrictEqual(adultDist, { 4: 98 + legacyAdultIds.size + onboardingIds.size, 5: 15, 6: 2, 10: 1 },
    'adult distribution must include four scenes for each newly adult character');

  let adultBlueprints = blueprints.filter(function (blueprint) { return blueprint.adult; });
  assert.ok(adultBlueprints.length >= 1, 'adult-only blueprints must exist');
  let nonAdultCharacters = characters.filter(function (character) { return character.adultEligibility !== 'adult'; });
  nonAdultCharacters.forEach(function (character) {
    adultBlueprints.forEach(function (blueprint) {
      assert.strictEqual(popular.blueprintEligible(blueprint, character, { adultEnabled: true }), false,
        character.id + ' must never see adult blueprint ' + blueprint.id);
      assert.strictEqual(popular.buildPopularPromptPlan({
        character: character, outfit: character.outfits[0], blueprint: blueprint,
        engine: 'anima', adultEnabled: true,
      }), null, character.id + ' must fail closed when building an adult blueprint');
    });
  });
  let adult = characters.find(function (character) { return character.adultEligibility === 'adult'; })!;
  assert.strictEqual(popular.blueprintEligible(adultBlueprints[0], adult, { adultEnabled: true }), true);
  assert.strictEqual(popular.blueprintEligible(adultBlueprints[0], adult, { adultEnabled: false }), false,
    'adult gate must require the mature-content switch as well');
});

// 2026-08-29 产品运营审计 P0-3：adult 与 sampleRating 曾三套字段各管各的，
// 出现过 adult=true 却标 All/R15 的矛盾条目（如 artoria_r18_nape）。这里把
// 双向互锁固化为契约：adult=true ⇔ sampleRating='R18'，杜绝 R18 内容借
// All/R15 徽章漏进全年龄展示流（红线 4 fail-closed 的内容侧互锁）。
test('blueprints: adult ⇔ sampleRating=R18 interlock', function () {
  blueprints.forEach(function (blueprint) {
    if (blueprint.adult === true) {
      assert.strictEqual(blueprint.sampleRating, 'R18',
        blueprint.id + ': adult=true 必须 sampleRating=R18（当前 ' + JSON.stringify(blueprint.sampleRating) + '）');
    }
    if (blueprint.sampleRating === 'R18') {
      assert.strictEqual(blueprint.adult, true,
        blueprint.id + ': sampleRating=R18 必须 adult=true（缺 adult 门控）');
    }
  });
});

test('source-audited adult records cannot re-enter SFW planning', function () {
  for (const id of ['raiden_shogun_tenshukaku', 'raiden_shogun_convenience', 'haruno_record_player_melancholy']) {
    const blueprint = blueprints.find(b => b.id === id)!;
    assert.ok(blueprint && blueprint.adult && blueprint.sampleRating === 'R18', id + ' must retain its reviewed classification');
    const character = characters.find(c => c.id === blueprint.characterId)!;
    for (const engine of ['anima', 'krea2'] as const) {
      assert.strictEqual(popular.buildPopularPromptPlan({ character, outfit: popular.findOutfit(character, blueprint.outfitId!)!, blueprint, engine, adultEnabled: false }), null, id + ' must fail closed in ' + engine);
    }
  }
});

test('SFW character variants keep intended hairstyles and exclude sexualized junior-high body cues', function () {
  const megumi = characters.find(c => c.id === 'katou_megumi')!;
  const anna = characters.find(c => c.id === 'yamada_anna')!;
  assert.ok(anna!.identityProse.includes('junior-high'), 'keep the stated school-age identity; do not age it up');
  for (const blueprint of blueprints.filter(b => !b.adult && ['katou_megumi', 'yamada_anna'].includes(b.characterId!))) {
    const character = blueprint.characterId === megumi!.id ? megumi : anna;
    for (const engine of ['anima', 'krea2'] as const) {
      const plan = popular.buildPopularPromptPlan({ character, outfit: popular.findOutfit(character, blueprint.outfitId!)!, blueprint, engine, adultEnabled: false });
      assert.ok(plan);
      if (character === anna) assert.ok(!/large[_ ]breasts|voluptuous|full bust|endlessly long|jaw-dropping/i.test(plan.prompt), blueprint.id + ' must remain a nonsexual everyday depiction');
      if (character === megumi && ['casual_ponytail_summer', 'sfw_kitchen_apron'].includes(blueprint.outfitId!)) {
        assert.ok(/ponytail/.test(plan.prompt), blueprint.id + ' must retain its ponytail');
        assert.ok(!/short[_ ]hair|bob[_ ]cut|short brown bob/i.test(plan.prompt), blueprint.id + ' must not also force a short bob');
      }
    }
  }
});

test('Mahiru first meeting follows the official umbrella lending direction', function () {
  const scene = blueprints.find(b => b.id === 'mahiru_rain_umbrella_park');
  assert.ok(scene!.promptTokens.includes('receiving_umbrella'));
  assert.ok(!scene!.promptTokens.includes('offering_umbrella'));
  assert.ok(scene!.promptProse.includes('Amane offers her his umbrella'));
});

// 2026-08-23 场景库二次优化：用户验收标准契约化——
// ① 每套服装至少被 1 个场景引用；② 每角色 ≥1 名场面(iconic) + ≥1 日常(daily)；
// ③ 成人侧每角色 ≥1 特殊NSFW（coverageTags=special_nsfw）。
test('scene coverage: every outfit referenced, >=1 iconic + >=1 daily per character, >=1 special_nsfw among adults', function () {
  characters.forEach(function (character) {
    let owned = blueprints.filter(function (blueprint) { return blueprint.characterId === character.id; });
    let usedOutfits = new Set(owned.map(function (blueprint) { return blueprint.outfitId; }).filter(Boolean));
    character.outfits.forEach(function (outfit) {
      assert.ok(usedOutfits.has(outfit.id),
        character.id + ' outfit ' + outfit.id + ' must be referenced by at least one scene');
    });
    let hasTag = function (tag: any) {
      return owned.some(function (blueprint) {
        return Array.isArray(blueprint.coverageTags) && blueprint.coverageTags.includes(tag);
      });
    };
    assert.ok(hasTag('iconic'), character.id + ' must own at least one iconic scene');
    assert.ok(hasTag('daily'), character.id + ' must own at least one daily scene');
    let ownedAdult = owned.filter(function (blueprint) { return blueprint.adult; });
    if (sfwOnlyIds.has(character.id)) {
      assert.strictEqual(ownedAdult.length, 0, character.id + ' must remain non-adult');
      return;
    }
    assert.ok(ownedAdult.length >= 4, character.id + ' must own adult scenes');
    assert.ok(ownedAdult.some(function (blueprint) {
      return Array.isArray(blueprint.coverageTags) && blueprint.coverageTags.includes('special_nsfw');
    }), character.id + ' must own at least one special_nsfw scene');
  });
});

// 2026-08-23 壁纸级质感契约——成人 hint 必须是 r18_* 配方 id（自由短语会以垃圾前缀
// 直接拼进 Krea 提示词开头）；尺寸收敛到高分辨率；原型场景须有实质环境描述。
// 一句完整叙事可含动作和具体光影，不以追加模板句凑句号。质量词属于 profile 装配层（quality_prefix 恰好一次，且
// aesthetic/2.9B 均 strip_quality_tokens=true），场景数据严禁携带政策质量词与玄学词；
// 具体光影/环境 tag（detailed_background/cinematic_lighting 等）作为壁纸层保留。
test('wallpaper-grade scenes: legal r18 hints, high-res sizes, no quality words in data layer', function () {
  let forbidden = [
    'masterpiece', 'best_quality', 'amazing_quality', 'very_aesthetic',
    'absurdres', 'newest', 'highres', 'highly_detailed',
    'intricate_details', 'ultra_detailed', '8k', '4k',
  ];
  blueprints.forEach(function (blueprint) {
    if (blueprint.adult && !["mash_kyrielight_dangerous_beast","caren_blizzard_shroud_magdalene_exorcism","caren_stigmata_fever_hugged_blush","caren_fireplace_bible_shoulder_lean","caren_cloister_sunlit_breeze_smile","ishtar_pool_mismatched_bikini","caren_summer_poolside_white_swimsuit","raiden_shogun_tenshukaku","raiden_shogun_convenience","haruno_record_player_melancholy","sakurajima_mai_library"].includes(blueprint.id)) {
      assert.ok(blueprint.kreaStyleHint && /^r18_/.test(blueprint.kreaStyleHint),
        blueprint.id + ' adult kreaStyleHint must be an r18_* recipe id');
    }
    let legalSizes = ['1152x1536', '1536x1152', '1216x832', '832x1216'];
    assert.ok(legalSizes.includes(blueprint.recommendedSize),
      blueprint.id + ' recommendedSize must be wallpaper high-res, got ' + blueprint.recommendedSize);
    forbidden.forEach(function (token) {
      assert.ok(!blueprint.promptTokens.includes(token),
        blueprint.id + ' promptTokens must not carry assembly-layer quality word ' + token);
    });
    // New daily scenes specify their actual light source rather than forcing fog and
    // cinematic volumetric light into every kitchen, classroom and shop.
    if (["mash_kyrielight_dangerous_beast","caren_blizzard_shroud_magdalene_exorcism","caren_stigmata_fever_hugged_blush","caren_fireplace_bible_shoulder_lean","caren_cloister_sunlit_breeze_smile","ishtar_pool_mismatched_bikini","caren_summer_poolside_white_swimsuit","raiden_shogun_tenshukaku","raiden_shogun_convenience","haruno_record_player_melancholy","sakurajima_mai_library"].includes(blueprint.id)) return; // Only classification was audited; adult authoring belongs to the other task.
    if (sfwOnlyIds.has(blueprint.characterId!) || legacyAdultIds.has(blueprint.characterId!)
      || (onboardingIds.has(blueprint.characterId!) && !blueprint.adult)) {
      assert.ok(blueprint.promptTokens.some(t => /light|sun|dawn|morning|afternoon|noon|night|evening|lantern|neon|lamp|shade/.test(t)), blueprint.id + ' must specify scene lighting or time');
      assert.ok(blueprint.promptProse.length >= 300, blueprint.id + ' needs a complete independently written scene');
    } else ['detailed_background', 'cinematic_lighting', 'volumetric_lighting', 'depth_of_field'].forEach(function (token) {
      const phrase = token.replaceAll('_', ' ');
      if (blueprint.promptTokens.includes(token)) return;
      assert.ok(blueprint.promptProse.toLowerCase().includes(phrase),
        blueprint.id + ' missing atmosphere in both tags and authored prose: ' + token);
      // Prose is a production input, not a UI label. When it supplies an anchor,
      // verify both actual engine payloads retain it instead of adding duplicate tags.
      const character = characters.find(item => item.id === blueprint.characterId)!;
      const outfit = popular.findOutfit(character, blueprint.outfitId!)!;
      const profiles = (require('../../data/presets.json') as typeof import('../../data/presets.json')).model_profiles;
      for (const engine of ['anima', 'krea2'] as const) {
        const model = engine === 'anima' ? 'anima-miaomiao-v1.2' : 'krea2-turbo-fp8';
        const profile: any = profiles.find(item => item.model_id === model);
        const plan = popular.buildPopularPromptPlan({ character, outfit, blueprint, engine, profile, adultEnabled: false });
        assert.ok(plan && plan.prompt.toLowerCase().includes(phrase),
          blueprint.id + ':' + engine + ' must preserve prose atmosphere ' + token);
      }
    });
    if (!blueprint.adult) {
      assert.ok(hasAtmosphericSceneProse(blueprint.promptProse),
        blueprint.id + ' needs complete scene prose with atmospheric content, not punctuation padding');
    }
  });
});

// 2026-09-02 故事还原度与防过度精简契约（studio-prompt-craft 门禁化）：
// ① 严禁使用 "Masterpiece visual novel H-CG artistry" 等无实质出图意义的元评论替代动作；
// ② description/action 中明确定义的两性结合（贯穿/中出/骑乘/交尾/后入/交尾压等）必须在 prose/nsfwProse 中有明确的动作动词，严禁尺度降级为单人露胸写真；
// ③ prose 长度不得过短（>=100 字符），防止干瘪一句话概括；
// ④ 体位与画幅轴向绑定防崩（后入/俯身强制横画幅，交尾压/垂直POV强制竖画幅）。
test('blueprints: adult story fidelity, anti-truncation, and aspect-ratio integrity', function () {
  let metaCommentaryRegex = /Masterpiece (?:visual novel|anime visual novel|event CG|H-CG) (?:artistry|craftsmanship|aesthetic)/i;
  let sexActionInDesc = /(?:贯穿|抽送|中出|骑乘|交尾|性交|后入|肉棒|内射|深顶|承欢|做爱|破身|初夜|交尾压|撕咬)/;
  let sexActionInProse = /(?:penetrat|creampie|mating press|thrust|straddl|intercourse|doggystyle|missionary|riding|cumshot|rear thrust|masturbat|finger|touching herself|fingering)/i;

  blueprints.forEach(function (blueprint) {
    if (!blueprint.adult) return;

    let descText = (blueprint.description || '') + ' ' + (blueprint.action || '');
    let proseText = blueprint.promptProse || '';
    let nsfwProseText = blueprint.nsfwProse || '';
    let fullProse = proseText + ' ' + nsfwProseText;

    // ① 无元评论套话
    assert.ok(!metaCommentaryRegex.test(proseText),
      blueprint.id + ' promptProse must not use meta-commentary filler phrases');

    // ② 防尺度降级（故事还原契约）
    if (sexActionInDesc.test(descText)) {
      assert.ok(sexActionInProse.test(fullProse),
        blueprint.id + ' description defines intimate intercourse, but prose lacks explicit physical action (de-escalation bug)');
    }

    // ③ 防短小干瘪
    assert.ok(proseText.length >= 100,
      blueprint.id + ' promptProse is too short (' + proseText.length + ' chars), needs concrete environment/pose/action detail');

    // ④ 画幅轴向防崩
    let tokens = (blueprint.promptTokens || []).concat(blueprint.nsfwTokens || []).join(' ');
    let isDoggystyle = /doggystyle|bent_over|sex_from_behind/.test(tokens) && !/missionary|mating_press|on_back/.test(tokens);
    let isMatingPress = /mating_press|legs_folded_to_chest/.test(tokens);

    if (isDoggystyle) {
      assert.ok(['1536x1152', '1216x832'].includes(blueprint.recommendedSize),
        blueprint.id + ' doggystyle/bent over must use horizontal framing (1536x1152), got ' + blueprint.recommendedSize);
    }
    if (isMatingPress) {
      assert.ok(['1152x1536', '832x1216'].includes(blueprint.recommendedSize),
        blueprint.id + ' mating press must use vertical framing (1152x1536), got ' + blueprint.recommendedSize);
    }
  });
});

// 2026-08-24 词条出图语义研究产物：自造「场景逻辑否定」tag 是扩散编码器反模式
// （negation-blind，「no X」可能反向召唤 X）；prose 同步正向化。
// 注意：no_panties/no_bra 是 Danbooru 高频习得概念（白名单保留），empty_场所/
// deserted_形容词/alone 为可渲染表达（不在禁列）。
test('negation-free prompts: no invented no_* tags, prose carries positive solitude phrasing', function () {
  let bannedTokens = ['no_opponent', 'no_customers', 'no_visitors', 'no_walkers', 'no_colleagues'];
  blueprints.forEach(function (blueprint) {
    bannedTokens.concat(['crowd_implied']).forEach(function (token) {
      assert.ok(!blueprint.promptTokens.includes(token),
        blueprint.id + ' must not carry negation-style tag ' + token);
    });
    ['promptProse', 'nsfwProse'].forEach(function (field) {
      let text = (blueprint as Record<string, any>)[field] || '';
      assert.ok(!/\bno (?:other )?(?:people|customers|visitors|walkers|colleagues|opponent)\b|\bnobody else\b|\bno one else\b/i.test(text),
        blueprint.id + ' ' + field + ' must not use negation phrasing');
    });
    // 负面位双重否定同样有害（2026-08-24 实机验证确认「no opponent」会召唤对手）
    assert.ok(!(blueprint.negativeTokens || []).some(function (token) { return /^no /i.test(token); }),
      blueprint.id + ' negativeTokens must not carry negation phrases');
  });
});

test('blueprint rotation: deterministic, changes per cursor, avoids immediate repeat', function () {
  let raiden = popular.findCharacter(characters, 'raiden_shogun');
  let pool = popular.eligibleBlueprints(blueprints, raiden, { adultEnabled: true });
  let first = popular.recommendBlueprints(pool, 'raiden_shogun#shogun_robes', 0, null, 3);
  assert.strictEqual(first.length, 3);
  let repeat = popular.recommendBlueprints(pool, 'raiden_shogun#shogun_robes', 0, null, 3);
  assert.deepStrictEqual(first.map(function (blueprint) { return blueprint.id; }), repeat.map(function (blueprint) { return blueprint.id; }),
    'same cursor must be deterministic');
  let second = popular.recommendBlueprints(pool, 'raiden_shogun#shogun_robes', 1, first.map(function (blueprint) { return blueprint.id; }), 3);
  assert.notDeepStrictEqual(second.map(function (blueprint) { return blueprint.id; }), first.map(function (blueprint) { return blueprint.id; }),
    'consecutive cursor must avoid the previous set');
});

test('prompt compiler: Anima keeps identity anchors exact, no studio pollution, Krea negative always empty', function () {
  let raiden = popular.findCharacter(characters, 'raiden_shogun')!;
  let outfit = raiden!.outfits.find(function (item) { return item.default; }) || raiden!.outfits[0];
  let blueprint = blueprints.find(function (item) { return item.id === 'raiden_shogun_narukami_shrine'; })!;

  let anima = popular.buildPopularPromptPlan({
    character: raiden, outfit: outfit, blueprint: blueprint, engine: 'anima', profile: null, adultEnabled: true,
  });
  assert.ok(anima, 'anima plan must build for a safe blueprint');
  assert.ok(anima.prompt.includes('raiden_shogun'), 'canonical identity anchor must be preserved exactly');
  assert.ok(anima.prompt.includes('narukami'), 'blueprint tokens must be synthesized');
  assert.ok(anima.prompt.includes('japanese_clothes') || anima.prompt.includes('kimono'), 'outfit tokens must be synthesized');
  assert.ok(anima.negative.length > 0, 'Anima no-LoRA workflow keeps negative tokens');

  let visualAnima = popular.buildPopularPromptPlan({
    character: raiden, outfit: outfit, blueprint: blueprint, engine: 'anima', profile: null, adultEnabled: true,
    visualDescription: 'The girl gently holds a bouquet of flowers, petals drifting onto her shoulder.',
    palette: ['pink theme', 'warm light'],
  });
  assert.ok(visualAnima!.prompt.includes('bouquet'), 'user visual description must enter the no-LoRA prompt');
  assert.ok(visualAnima!.prompt.includes('pink theme') && visualAnima!.prompt.includes('warm light'),
    'director color mood must enter the Anima request');
  assert.ok(visualAnima!.prompt.includes('japanese_clothes') || visualAnima!.prompt.includes('kimono'),
    'user visual description must not replace the selected outfit');
  let fallbackAnima = popular.buildPopularPromptPlan({
    character: raiden, outfit: outfit, blueprint: blueprint, engine: 'anima', profile: null, adultEnabled: true,
  });
  assert.ok(fallbackAnima!.prompt.includes('japanese_clothes') || fallbackAnima!.prompt.includes('kimono'),
    'empty visual description still keeps the selected outfit tokens');

  let animaText = [anima.prompt, anima.negative].join(' ');
  assert.ok(!/(?:ayachi_nene|shiki_natsume)/i.test(animaText), 'no studio character name');
  assert.ok(!/(?:nene_|natsume_)[a-z0-9_]+/i.test(animaText), 'no studio control tokens');
  assert.ok(!/<lora:/i.test(animaText), 'no lora syntax');
  assert.ok(!/official_cg|visual_audited/i.test(animaText), 'no retrieval metadata');
  assert.ok(!/这是故事|台词|心理活动/i.test(animaText), 'no story/dialogue/psychology leakage');

  let krea = popular.buildPopularPromptPlan({
    character: raiden, outfit: outfit, blueprint: blueprint, engine: 'krea2', profile: null, adultEnabled: true,
    palette: ['pink theme', 'warm light'],
  });
  assert.ok(krea, 'krea plan must build');
  assert.strictEqual(krea.negative, '', 'Krea must never carry a negative');
  let kreaText = krea.prompt;
  assert.ok(!/(?:ayachi_nene|shiki_natsume|nene_|natsume_)/i.test(kreaText), 'krea no studio pollution');
  assert.ok(!/<lora:/i.test(kreaText), 'krea no lora syntax');
  assert.ok(!/official_cg|visual_audited/i.test(kreaText), 'krea no retrieval metadata');
  assert.ok(kreaText.includes('color palette uses pink theme and warm light'), 'director color mood must enter Krea prose');
  assert.strictEqual((kreaText.match(/flowing purple Japanese robes/gi) || []).length, 1, 'selected outfit must appear exactly once');
  assert.ok(!/completely deserted|not a single other person|no commuters/i.test(kreaText), 'Krea must not force every public scene to be deserted');
});

test('adult blueprints compile as explicit adult versions in both engines', function () {
  let adultBlueprints = blueprints.filter(function (blueprint) { return blueprint.adult; });
  assert.ok(adultBlueprints.length > 0, 'adult blueprint corpus must not be empty');
  const { resolveModelProfile }: typeof import('../../src/utils/promptPolicy.ts') = require('../../src/utils/promptPolicy.ts');
  const catalog = persistence.parsePresetCatalog((require('../../data/presets.json') as typeof import('../../data/presets.json')));
  const animaProfile: any = resolveModelProfile(catalog.modelProfiles, 'anima-miaomiao-v1.2', 'anima');
  const kreaProfile: any = resolveModelProfile(catalog.modelProfiles, 'krea2-turbo-fp8', 'krea2');
  adultBlueprints.forEach(function (blueprint) {
    let character = popular.findCharacter(characters, blueprint.characterId!)!;
    let outfit = character!.outfits.find(function (item) { return item.id === blueprint.outfitId; })
      || character!.outfits.find(function (item) { return item.default; })
      || character!.outfits[0];
    let anima = popular.buildPopularPromptPlan({
      character: character, outfit: outfit, blueprint: blueprint,
      engine: 'anima', profile: animaProfile, adultEnabled: true,
    });
    let krea = popular.buildPopularPromptPlan({
      character: character, outfit: outfit, blueprint: blueprint,
      engine: 'krea2', profile: kreaProfile, adultEnabled: true,
    });
    assert.ok(anima && krea, blueprint.id + ' must compile for both adult engines');
    assert.ok(anima.prompt.split('\n')[0].split(',').map(function (token) { return token.trim(); }).includes('adult'),
      blueprint.id + ' Anima prompt must carry the exact adult token');
    assert.ok(/unmistakably adult, age-twenty-plus version/i.test(krea.prompt),
      blueprint.id + ' Krea prompt must explicitly describe the adult version');
    assert.strictEqual(krea.negative, '', blueprint.id + ' Krea negative must stay empty');
    ['nsfw', 'nude', 'explicit'].forEach(function (token) {
      assert.ok(!anima!.negative.split(',').map(function (part) { return part.trim().toLowerCase(); }).includes(token),
        blueprint.id + ' Anima negative must not block ' + token);
    });
    assert.ok(anima.negative.split(',').map(function (part) { return part.trim().toLowerCase(); }).includes('extra limbs'),
      blueprint.id + ' Anima negative must suppress extra limbs');
    const malformedWear = /\bShe wears (?:standing|sitting|kneeling|lying|on back|pov|completely nude|masturbation|sensual alone|sitting in water)\b/i;
    assert.ok(!malformedWear.test(anima.prompt), blueprint.id + ' Anima caption must not turn pose/body controls into clothing');
    assert.ok(!malformedWear.test(krea.prompt), blueprint.id + ' Krea prose must not turn pose/body controls into clothing');
  });
});

test('blueprint framing: authored and compiled directions match recommended dimensions', function () {
  const { resolveModelProfile }: typeof import('../../src/utils/promptPolicy.ts') = require('../../src/utils/promptPolicy.ts');
  const catalog = persistence.parsePresetCatalog(require('../../data/presets.json'));
  const profiles = {
    anima: resolveModelProfile(catalog.modelProfiles, 'anima-miaomiao-v1.2', 'anima'),
    krea2: resolveModelProfile(catalog.modelProfiles, 'krea2-turbo-fp8', 'krea2'),
  };
  const framing = /\b(horizontal|vertical)\s+(?:[a-z-]+\s+){0,4}(?:portrait|composition|framing)\b/gi;
  let checked = 0;
  for (const blueprint of blueprints) {
    if (![...blueprint.promptProse.matchAll(framing)].length) continue;
    const [width, height] = blueprint.recommendedSize.split(/[x×]/).map(Number);
    if (width === height) continue;
    assert.ok(width > 0 && height > 0, blueprint.id + ' must have valid dimensions');
    const expected = width > height ? 'horizontal' : 'vertical';
    const checkDirection = (text: string, label: string) => {
      const matches = [...text.matchAll(framing)];
      assert.ok(matches.length > 0, blueprint.id + ' ' + label + ' must retain authored framing');
      for (const match of matches) {
        assert.strictEqual(match[1].toLowerCase(), expected,
          blueprint.id + ' ' + label + ' framing conflicts with ' + blueprint.recommendedSize);
      }
    };
    checkDirection(blueprint.promptProse, 'source');
    const character = popular.findCharacter(characters, blueprint.characterId!)!;
    const outfit = popular.findOutfit(character, blueprint.outfitId!)!;
    for (const engine of ['anima', 'krea2'] as const) {
      const result = popular.buildPopularPromptPlan({
        character, outfit, blueprint, engine, profile: profiles[engine], adultEnabled: true,
      });
      assert.ok(result, blueprint.id + ' must compile for ' + engine);
      checkDirection(result.prompt, engine);
    }
    checked++;
  }
  assert.ok(checked >= 20, 'framing regression must cover the repaired corpus');
});

test('blueprint lighting: explicit emitters outrank prose colors, titles and time-only tags', function () {
  const base = blueprints.find(b => b.id === 'raiden_shogun_narukami_shrine');
  const decide = (fields: any) => popular.inferBlueprintDecisions({ ...base, ...fields }).lighting;
  assert.strictEqual(decide({ lighting: 'soft daylight', timeOfDay: 'day', promptProse: 'Saber from Fate/stay night with golden eyes.', sceneTags: [] }), null);
  assert.strictEqual(decide({ lighting: 'blue neon through the window', timeOfDay: 'night', sceneTags: ['night', 'golden_eyes'] }), null);
  assert.strictEqual(decide({ lighting: '月光透过窗户', timeOfDay: 'night', sceneTags: [] }), 'moon');
  assert.strictEqual(decide({ lighting: 'warm desk lamp', timeOfDay: 'night', sceneTags: ['moonlight'] }), 'lantern');
  assert.strictEqual(decide({ lighting: '', timeOfDay: 'night', sceneTags: ['night', 'golden_hair'] }), null);
  assert.strictEqual(decide({ lighting: '', timeOfDay: 'day', sceneTags: ['golden_hour'] }), 'golden');
  assert.strictEqual(decide({ lighting: 'soft afternoon window light', timeOfDay: 'afternoon' }), 'window');
  assert.strictEqual(decide({ lighting: '窗光', timeOfDay: '冬夜', sceneTags: [] }), null);
  assert.strictEqual(decide({ lighting: 'warm morning sunlight', timeOfDay: 'morning', sceneTags: [] }), 'golden');
  assert.strictEqual(decide({ lighting: 'bright sunlight', timeOfDay: 'noon', sceneTags: [] }), null);
  assert.strictEqual(decide({ lighting: 'golden hologram light', timeOfDay: 'day', sceneTags: [] }), null);
});

test('blueprint lighting: all SFW decisions are independent of prose, mood and camera contamination', function () {
  for (const blueprint of blueprints.filter(b => !b.adult)) {
    const expected = popular.inferBlueprintDecisions(blueprint).lighting;
    const noisy = { ...blueprint, camera: 'window portrait', mood: 'golden autumn night', promptProse: 'Golden eyes and moon-shaped jewelry from Fate/stay night, sunlight, candlelight.' };
    assert.strictEqual(popular.inferBlueprintDecisions(noisy).lighting, expected, blueprint.id + ': prose/camera/mood must not override the authored light');
  }
});

test('blueprint decisions: angle keywords outrank framing substrings; every blueprint resolves a shot', function () {
  let thunderNight = blueprints.find(function (item) { return item.id === 'raiden_shogun_thunder_night'; })!;
  let decision = popular.inferBlueprintDecisions(thunderNight);
  assert.strictEqual(decision.shot, 'wide', 'the corrected beach scene must retain its authored full-body framing');
  assert.strictEqual(popular.inferBlueprintDecisions({ ...thunderNight, camera: 'wide shot, dramatic low angle' } as any).shot, 'low',
    'authored "wide shot, dramatic low angle" must resolve to low angle, not lose to the longer "wide shot"/"medium" substring');
  assert.strictEqual(popular.inferBlueprintDecisions({ ...thunderNight, camera: 'medium shot', sceneTags: ['looking_back'], promptProse: 'Looking back over her shoulder.' } as any).shot, 'medium',
    'an action in scene prose must not replace the explicit camera distance');
  assert.strictEqual(popular.inferBlueprintDecisions({ ...thunderNight, camera: 'full body, front view' } as any).shot, 'wide', 'frontal full-body camera must not become looking back');
  assert.strictEqual(popular.inferBlueprintDecisions({ ...thunderNight, camera: 'medium close-up, front view' } as any).shot, 'close', 'frontal close view must retain its framing');
  let maiLibrary = blueprints.find(function (item) { return item.id === 'sakurajima_mai_library'; })!;
  assert.strictEqual(popular.inferBlueprintDecisions(maiLibrary).shot, 'low',
    '"cinematic low angle medium shot" must keep the authored low angle');
  let unresolved = blueprints.filter(function (item) { return !popular.inferBlueprintDecisions(item).shot; });
  assert.strictEqual(unresolved.length, 0,
    'every blueprint camera field must resolve to a director shot; unresolved: ' + unresolved.map(function (b) { return b.id; }).join(', '));
});

test('krea prose: director shot/lighting decisions must reach the compiled prompt', function () {
  let yor = popular.findCharacter(characters, 'yor_forger')!;
  let outfit = yor!.outfits.find(function (item) { return item.default; }) || yor!.outfits[0];
  let blueprint = blueprints.find(function (item) { return item.id === 'yor_moonlit_rooftop_stiletto'; })!;
  let built = popular.buildPopularPromptPlan({
    character: yor, outfit: outfit, blueprint: blueprint, engine: 'krea2', profile: null,
    adultEnabled: false, shot: 'medium', lighting: 'moon', composition: 'rule3',
  });
  assert.ok(built, 'krea plan must build');
  assert.ok(built.prompt.includes('a medium shot'), 'director shot must enter krea prose');
  assert.ok(/lit by /.test(built.prompt), 'director lighting must enter krea prose');
  assert.ok(!/lit by moonlight and night/.test(built.prompt),
    'time words are not light sources; night/stars stay out of krea lighting prose');
  assert.ok(!/wearing wearing|wears wearing/i.test(built.prompt),
    'outfit prose starting with "wearing" must not duplicate the verb in krea composition');
  let anima = popular.buildPopularPromptPlan({
    character: yor, outfit: outfit, blueprint: blueprint, engine: 'anima', profile: null,
    adultEnabled: false, shot: 'medium', lighting: 'moon', composition: 'rule3',
  });
  let animaTags = anima!.prompt.split('\n')[0];
  assert.ok(animaTags.includes('medium shot') && animaTags.includes('moonlight'),
    'anima tag stream keeps receiving director decisions (underscores normalize to spaces)');
  assert.ok(!/wears wearing|wearing wearing/i.test(anima!.prompt),
    'outfit prose must not duplicate the wearing verb in anima caption');
});

test('prompt compiler: manual expert tags are sanitized against studio control tokens', function () {
  let raiden = popular.findCharacter(characters, 'raiden_shogun')!;
  let outfit = raiden!.outfits[0];
  let manual = ['nene_school_uniform', 'shiki_natsume', 'raiden_shogun', 'thighhighs', 'natsume_cafe_uniform'];
  let sanitized = popular.sanitizePopularManual(manual);
  assert.deepStrictEqual(sanitized, ['raiden_shogun', 'thighhighs']);
  let anima = popular.buildPopularPromptPlan({
    character: raiden, outfit: outfit, blueprint: null, engine: 'anima', profile: null, manual: manual, adultEnabled: true,
  });
  let text = anima!.prompt;
  assert.ok(!/(?:nene_|natsume_)/i.test(text), 'manual studio tokens must be stripped');
  assert.ok(text.includes('thighhighs'), 'valid manual tag survives');
});

test('krea style recipes: >=8 common recipes, explicit adult recipes, unique ids, no studio pollution', function () {
  let all = recipes.KREA_STYLE_RECIPES;
  let common = all.filter(function (recipe) { return !recipe.adult; });
  let adult = all.filter(function (recipe) { return recipe.adult; });
  assert.ok(all.length >= 9, 'must ship at least 8 common + explicit adult recipes, got ' + all.length);
  assert.ok(common.length >= 8, 'must ship at least 8 common recipes, got ' + common.length);
  assert.ok(adult.length >= 1, 'must ship explicit adult-only recipes');
  let ids = new Set(all.map(function (recipe) { return recipe.id; }));
  assert.strictEqual(ids.size, all.length, 'recipe ids must be unique');
  all.forEach(function (recipe) {
    assert.ok(recipe.lead && recipe.lead.trim().length > 10, recipe.id + ' needs a real lead phrase');
    assert.ok(!/(?:ayachi_nene|shiki_natsume|nene_|natsume_)/i.test(recipe.lead + ' ' + (recipe.medium || '')),
      recipe.id + ' leaked studio anchors');
  });
  assert.ok(adult.every(function (recipe) { return /^r18_/.test(recipe.id); }), 'adult recipes must be independently and explicitly id-prefixed');
});

test('krea style recipes: adult recipes fail closed for unknown/underage and without the mature switch', function () {
  let adult = recipes.KREA_STYLE_RECIPES.filter(function (recipe) { return recipe.adult; })[0];
  assert.ok(adult);
  let adultChar = characters.find(function (character) { return character.adultEligibility === 'adult'; });
  assert.ok(adultChar, 'at least one adult-eligible character must exist');
  // 数据已按「全部开放」升为 adult；用合成 underage/unknown 对象保持 fail-closed 契约。
  let ineligible = [
    { id: 'synthetic-underage', adultEligibility: 'underage' as const },
    { id: 'synthetic-unknown', adultEligibility: 'unknown' as const },
  ];
  assert.strictEqual(recipes.recipeEligible(adult, adultChar, { adultEnabled: true }), true);
  assert.strictEqual(recipes.recipeEligible(adult, adultChar, { adultEnabled: false }), false,
    'adult recipe must require the mature-content switch');
  ineligible.forEach(function (character) {
    assert.strictEqual(recipes.recipeEligible(adult, character, { adultEnabled: true }), false,
      character.id + ' must never be eligible for an adult recipe');
    assert.ok(recipes.eligibleStyleRecipes(recipes.KREA_STYLE_RECIPES, character, { adultEnabled: true })
      .every(function (recipe) { return !recipe.adult; }), character.id + ' must see no adult recipes');
  });
});

test('krea style recipes: resolution is engine-default -> blueprint hint -> selection, gated fail-closed', function () {
  let raiden = popular.findCharacter(characters, 'raiden_shogun')!;
  let flower = blueprints.find(function (blueprint) { return blueprint.id === 'raiden_shogun_narukami_shrine'; })!;
  let adultBp = blueprints.find(function (blueprint) { return blueprint.adult; })!;

  // 无 hint / 无手选：引擎缺省。
  let auto = recipes.resolveStyleRecipe(recipes.KREA_STYLE_RECIPES, 'krea2', null, null, raiden, { adultEnabled: true });
  assert.strictEqual(auto!.lead, 'A polished visual novel event CG with refined cel shading, flat colors and crisp character work');
  let animaAuto = recipes.resolveStyleRecipe(recipes.KREA_STYLE_RECIPES, 'anima', null, null, raiden, { adultEnabled: true });
  assert.ok(animaAuto!.lead.indexOf('anime key visual') !== -1, 'anima default must be the key visual recipe');
  // 解析层照常返回自然语言 lead；Anima 组装改取同配方的模型原生短标签。
  let animaBuilt = popular.buildPopularPromptPlan({
    character: raiden, outfit: raiden!.outfits[0], blueprint: null, engine: 'anima', profile: null, adultEnabled: true, style: animaAuto,
  });
  assert.ok(animaBuilt!.prompt.indexOf('anime key visual') !== -1, 'anima must include the model-native style tags');
  assert.ok(!/anime key visual\.$/i.test(animaBuilt!.prompt), 'anima must not append the style medium');
  assert.ok(animaBuilt!.prompt.includes('Raiden Shogun from Genshin Impact'), 'Anima must receive the popular character identity prose');

  // 角色原型场景无 hint：引擎缺省即兜底（hint 仅成人蓝图与手选携带）。
  let hinted = recipes.resolveStyleRecipe(recipes.KREA_STYLE_RECIPES, 'krea2', flower, null, raiden, { adultEnabled: true });
  assert.strictEqual(hinted!.lead, auto!.lead, 'character scene without kreaStyleHint must fall back to the engine default');
  let hintedAnima = recipes.resolveStyleRecipe(recipes.KREA_STYLE_RECIPES, 'anima', flower, null, raiden, { adultEnabled: true });
  assert.strictEqual(hintedAnima!.lead, animaAuto!.lead, 'character scene without animaStyleHint must fall back to the engine default');

  // 手选覆盖 hint。
  let selected = recipes.resolveStyleRecipe(recipes.KREA_STYLE_RECIPES, 'krea2', flower, 'dreamy_pastel', raiden, { adultEnabled: true });
  assert.strictEqual(selected!.medium, 'dreamy pastel art', 'selection must override the blueprint hint');

  // 成人蓝图 hint → 成人配方，仅对 adult 角色可达。
  let adultStyle = recipes.resolveStyleRecipe(recipes.KREA_STYLE_RECIPES, 'krea2', adultBp, null, raiden, { adultEnabled: true });
  assert.strictEqual(adultStyle!.adult, true, 'adult blueprint hint must resolve to an adult recipe');
  let ineligible: any = { id: 'synthetic-underage', adultEligibility: 'underage' };
  assert.strictEqual(recipes.resolveStyleRecipe(recipes.KREA_STYLE_RECIPES, 'krea2', adultBp, null, ineligible, { adultEnabled: true }), null,
    'underage character must fail closed on an adult recipe hint');
  assert.strictEqual(recipes.resolveStyleRecipe(recipes.KREA_STYLE_RECIPES, 'krea2', adultBp, null, raiden, { adultEnabled: false }), null,
    'adult recipe must fail closed when the mature switch is off');

  // hint 可以是自由风格短语（未命中配方 id 时原样作为前置短语）。
  let freeHint = recipes.resolveStyleRecipe(recipes.KREA_STYLE_RECIPES, 'krea2', { kreaStyleHint: 'soft watercolor anime style' }, null, raiden, { adultEnabled: true });
  assert.strictEqual(freeHint!.lead, 'soft watercolor anime style');
  assert.strictEqual(freeHint!.adult, false, 'free phrase hints are never adult');
});

test('krea prose: automatic style first, 3-5 visual sentences, no meta phrases or tag stuffing', function () {
  let raiden = popular.findCharacter(characters, 'raiden_shogun')!;
  let outfit = raiden!.outfits.find(function (item) { return item.default; }) || raiden!.outfits[0];
  let blueprint = blueprints.find(function (item) { return item.id === 'raiden_shogun_narukami_shrine'; })!;
  let style = recipes.resolveStyleRecipe(recipes.KREA_STYLE_RECIPES, 'krea2', blueprint, null, raiden, { adultEnabled: true });

  let krea = popular.buildPopularPromptPlan({
    character: raiden, outfit: outfit, blueprint: blueprint, engine: 'krea2', profile: null, adultEnabled: true, style: style,
  });
  assert.ok(krea);
  assert.strictEqual(krea.negative, '');
  let text = krea.prompt;

  // 风格配方开头（角色场景无 hint → 引擎默认）。
  assert.ok(text.startsWith('A polished visual novel event CG'), 'engine default style lead must open the Krea prompt');
  // 无 meta 短语 / 无检索元数据 / 无工作室污染。
  assert.ok(!/(?:In this image|The image shows|Scene details:|Composition and lighting|A visual novel event CG featuring)/i.test(text));
  assert.ok(!/official_cg|visual_audited/i.test(text));
  assert.ok(!/(?:ayachi_nene|shiki_natsume|nene_|natsume_|<lora:)/i.test(text));
  // 无逗号标签堆砌：不出现下划线 token，也不出现连续逗号标签。
  assert.ok(!/[a-z]+_[a-z]+/i.test(text), 'krea prose must not carry raw danbooru tokens');
  assert.ok(!/,\s*\w+,\s*\w+,\s*\w+,\s*$/.test(text), 'krea prose must not end with a comma-stuffed list');
  // identityProse / outfitProse / promptProse 作为自然语言织入，未退化成标签流。
  assert.ok(text.includes('Raiden Shogun from Genshin Impact, also known as Raiden Ei, the Electro Archon'),
    'identityProse must be woven verbatim');
  assert.ok(/the Raiden Shogun's flowing purple Japanese robes, bare shoulders, thigh-highs and a long braid/i.test(text),
    'outfitProse must be woven verbatim');
  assert.ok(text.includes("A single cherry petal settles on Raiden Ei's open palm beneath the Sacred Sakura"),
    'blueprint promptProse must be woven verbatim');
  // 散文句子必须以句号收束。
  let sentences = text.split(/(?<=\.)\s/);
  assert.ok(sentences.length >= 3 && sentences.length <= 5, 'Krea prompt must contain 3-5 concise visual sentences');
  sentences.forEach(function (sentenceText) {
    assert.ok(/\.$/.test(sentenceText.trim()), 'each prose sentence must end with a period');
  });
});

test('krea prose: adult recipe fails closed inside buildPopularPromptPlan for ineligible characters', function () {
  let ineligible = JSON.parse(JSON.stringify(characters[0]));
  ineligible.adultEligibility = 'underage';
  let adultBp = blueprints.find(function (blueprint) { return blueprint.adult; })!;
  let adultStyle = recipes.resolveStyleRecipe(recipes.KREA_STYLE_RECIPES, 'krea2', adultBp, null, ineligible, { adultEnabled: true });
  assert.strictEqual(adultStyle, null, 'underage must never resolve an adult style');
  // 即便调用方绕过解析直接传 adult 配方，build 层也要再 fail-closed 一次。
  let sneaked = popular.buildPopularPromptPlan({
    character: ineligible, outfit: ineligible.outfits[0], blueprint: adultBp, engine: 'krea2',
    profile: null, adultEnabled: true, style: { lead: 'mature sensual content', adult: true },
  });
  assert.strictEqual(sneaked, null, 'build layer must reject an adult style for an ineligible character');
  let raiden = popular.findCharacter(characters, 'raiden_shogun')!;
  let legit = popular.buildPopularPromptPlan({
    character: raiden, outfit: raiden!.outfits[0], blueprint: adultBp, engine: 'krea2',
    profile: null, adultEnabled: true, style: { lead: 'mature sensual content', medium: 'mature art', adult: true },
  });
  assert.ok(legit, 'adult character + mature switch must build with an adult style');
  assert.ok(/mature sensual content/i.test(legit.prompt), 'adult style lead must reach the prompt');
  assert.ok(legit.prompt.split(/(?<=\.)\s/).length <= 5, 'adult Krea prompt must remain concise');
});

test('blueprint hints: kreaStyleHint/animaStyleHint stay optional; adult blueprints must carry an adult hint', function () {
  let shrine = blueprints.find(function (blueprint) { return blueprint.id === 'raiden_shogun_narukami_shrine'; });
  assert.ok(shrine && shrine.kreaStyleHint === undefined, 'character prototype scenes may omit style hints');
  let adultBp = blueprints.find(function (blueprint) { return blueprint.adult; });
  assert.ok(adultBp!.kreaStyleHint && /^r18_/.test(adultBp!.kreaStyleHint), 'adult blueprint must carry an adult recipe hint');
  let unknown = blueprints.find(function (blueprint) { return blueprint.kreaStyleHint === undefined; });
  assert.ok(unknown, 'hints must be optional for blueprints without a strong style identity');
});

test('prompt compiler: Anima negative merges profile negative_prefix per negative_mode, Krea stays empty', function () {
  let raiden = popular.findCharacter(characters, 'raiden_shogun')!;
  let outfit = raiden!.outfits[0];
  let blueprint = blueprints.find(function (item) { return item.id === 'raiden_shogun_thunder_night'; })!;
  blueprint = { ...blueprint, negativeTokens: [...blueprint!.negativeTokens, 'neon'] };
  // anima_aesthetic_v11：negative_mode=replace, replace_scope=boilerplate。
  let profile: any = { engine: 'anima', negative_prefix: 'worst quality, low quality, artist name, blurry, jpeg artifacts, chromatic aberration', negative_mode: 'replace', negative_replace_scope: 'boilerplate', exact_tokens: ['best_quality'] };

  let anima = popular.buildPopularPromptPlan({
    character: raiden, outfit: outfit, blueprint: blueprint, engine: 'anima', profile: profile, adultEnabled: true,
  });
  assert.ok(anima, 'anima plan must build');
  assert.ok(anima.negative.includes('artist name'), 'profile negative_prefix must be merged in');
  assert.ok(anima.negative.includes('chromatic aberration'), 'profile negative_prefix tail must be merged in');
  assert.ok(anima.negative.includes('neon'), 'fixture non-boilerplate negative must be kept');
  assert.ok(!anima.negative.includes('<lora:'), 'no lora syntax in negative');

  let krea = popular.buildPopularPromptPlan({
    character: raiden, outfit: outfit, blueprint: blueprint, engine: 'krea2', profile: profile, adultEnabled: true,
  });
  assert.ok(krea);
  assert.strictEqual(krea.negative, '', 'Krea negative must always be empty regardless of profile prefix');
});

test('curated artist styles use native Anima tags and Krea prose', function () {
  let raiden = popular.findCharacter(characters, 'raiden_shogun')!;
  let outfit = raiden!.outfits[0];
  let blueprint = blueprints.find(function (item) { return item.id === 'raiden_shogun_narukami_shrine'; })!;
  let anima = popular.buildPopularPromptPlan({
    character: raiden, outfit: outfit, blueprint: blueprint, engine: 'anima', profile: { engine:'anima' },
    artistTags: ['@kantoku', '@mika pikazo'], artistProse: 'with visual styling inspired by Kantoku and Mika Pikazo',
  });
  assert.ok(anima!.prompt.includes('@kantoku') && anima!.prompt.includes('@mika pikazo'));
  let krea = popular.buildPopularPromptPlan({
    character: raiden, outfit: outfit, blueprint: blueprint, engine: 'krea2', profile: { engine:'krea2' },
    style: { lead:'A polished visual novel event CG', medium:'visual novel event CG' },
    artistTags: [], artistProse: 'with visual styling inspired by Kantoku and Mika Pikazo',
  });
  assert.ok(krea!.prompt.startsWith('A polished visual novel event CG, with visual styling inspired by Kantoku and Mika Pikazo.'));
  assert.ok(!krea!.prompt.includes('@kantoku'));
});

test('prompt compiler: restored adult blueprint fails closed for ineligible characters', function () {
  let ineligible = JSON.parse(JSON.stringify(characters[0]));
  ineligible.adultEligibility = 'underage';
  let adultBlueprint = blueprints.find(function (item) { return item.adult; });
  assert.ok(adultBlueprint);
  // 无论 manualTags / profile 是否携带显式词，组装必须整体拒绝。
  let rejected = popular.buildPopularPromptPlan({
    character: ineligible, outfit: ineligible.outfits[0], blueprint: adultBlueprint, engine: 'anima', profile: null, adultEnabled: true,
  });
  assert.strictEqual(rejected, null, 'underage character must never assemble an adult blueprint');
  assert.ok(!adultBlueprint.promptTokens.join(' ').match(/nsfw|nude|explicit/i), 'adult blueprint should not smuggle explicit tokens via assembly');
});

test('persistence round-trip: popular subject/outfit/blueprint/noLora survive parse and old drafts stay studio', function () {
  let draft = {
    updatedAt: 1700000000000,
    story: 'test',
    sceneId: null,
    subject: 'popular',
    characterId: 'raiden_shogun',
    outfitId: 'shogun_robes',
    blueprintId: 'raiden_shogun_tenshukaku',
     noLora: true,
     kreaStyleId: 'legacy-style-ignored',
     artistInfluences: ['legacy artist ignored'],
     artistStyleIds: ['kantoku', 'rella', 'unknown-third'],
  };
  let parsed: any = persistence.parsePromptBuilderDraft(draft);
  assert.ok(parsed, 'draft must parse');
  assert.strictEqual(parsed.subject, 'popular');
  assert.strictEqual(parsed.characterId, 'raiden_shogun');
  assert.strictEqual(parsed.outfitId, 'shogun_robes');
  assert.strictEqual(parsed.blueprintId, 'raiden_shogun_tenshukaku');
  assert.strictEqual(parsed.noLora, true);
   assert.strictEqual(parsed.kreaStyleId, undefined, 'manual style state is not restored');
    assert.strictEqual(parsed.artistInfluences, undefined, 'manual artist state is not restored');
    assert.deepStrictEqual(parsed.artistStyleIds, ['kantoku', 'rella'], 'curated artist ids restore with whitelist and two-item limit');

  let serialized = JSON.parse(JSON.stringify(parsed));
  assert.strictEqual(serialized.subject, 'popular');
  assert.strictEqual(serialized.characterId, 'raiden_shogun');
    assert.strictEqual(serialized.kreaStyleId, undefined);
    assert.strictEqual(serialized.artistInfluences, undefined);
    assert.deepStrictEqual(serialized.artistStyleIds, ['kantoku', 'rella']);

  // 热门角色草稿没有 story/sceneId 也能恢复（蓝图驱动场景）。
  let storyless = {
    updatedAt: 1700000000001,
    subject: 'popular',
    characterId: 'raiden_shogun',
    outfitId: 'shogun_robes',
    blueprintId: null,
    noLora: true,
  };
  let parsedStoryless: any = persistence.parsePromptBuilderDraft(storyless);
  assert.ok(parsedStoryless, 'storyless popular draft must restore');
  assert.strictEqual(parsedStoryless.subject, 'popular');
  assert.strictEqual(parsedStoryless.kreaStyleId, undefined);

  let legacy: any = persistence.parsePromptBuilderDraft({ updatedAt: 1, sceneId: 'sc001', story: 'old' });
  assert.ok(legacy, 'legacy draft must parse');
  assert.strictEqual(legacy.subject, 'studio', 'legacy draft must default to studio');
  assert.strictEqual(legacy.characterId, undefined);
  assert.strictEqual(legacy.noLora, undefined);
  assert.strictEqual(legacy.kreaStyleId, undefined);
});

test('anima no-LoRA route contract: validate + workflow have no LoraLoader and keep a negative encode', function () {
  let input = animaRoute.validateInput({
    prompt: 'raiden_shogun, 1girl, flower field',
    negative: 'worst quality, low quality',
    modelId: 'anima-aesthetic-v1.1',
    width: 832,
    height: 1216,
    seed: 7,
  });
  assert.strictEqual(input.family, 'anima');
  assert.strictEqual(input.loraId, undefined, 'no-LoRA input must not carry a loraId');
  assert.strictEqual(input.loraStrength, null);
  assert.strictEqual(input.character, undefined);

  let workflow = animaRoute.buildWorkflow(input);
  let classes = Object.values(workflow).map(function (node) { return node.class_type; });
  assert.ok(!classes.includes('LoraLoader'), 'no-LoRA workflow must not contain LoraLoader');
  assert.ok(classes.includes('CLIPTextEncode'), 'no-LoRA workflow must keep prompt encoding');
  assert.strictEqual(workflow['2'].inputs.type, 'qwen_image');
  assert.strictEqual(workflow['2'].inputs.clip_name, 'qwen_3_06b_base.safetensors');
  assert.strictEqual(workflow['5'].inputs.text, 'worst quality, low quality', 'negative encode must receive the negative');
  assert.strictEqual(workflow['7'].inputs.sampler_name, 'res_multistep');
  assert.strictEqual(workflow['7'].inputs.scheduler, 'simple');
  assert.strictEqual(workflow['7'].inputs.steps, 30);
  assert.strictEqual(workflow['7'].inputs.cfg, 4.5);
  assert.deepStrictEqual(workflow['7'].inputs.negative, ['5', 0]);
  assert.strictEqual(workflow['10'].class_type, 'SaveImage');

  // 无 LoRA 模式仍保持原有 lora 校验：提供 lora 时走原路径。
  let withLora = animaRoute.validateInput({
    prompt: 'x', negative: 'n', modelId: 'anima-aesthetic-v1.1',
    loraId: 'L_NENE_V21_ANIMA', loraStrength: 0.85, width: 832, height: 1216, character: 'nene',
  });
  assert.strictEqual(withLora.loraId, 'L_NENE_V21_ANIMA');
  assert.throws(function () {
    animaRoute.validateInput({ prompt: 'x', modelId: 'anima-aesthetic-v1.1', loraId: 'unknown', width: 832, height: 1216 });
  }, function (error: any) { return error && error.code === 'UNKNOWN_LORA'; });
  assert.throws(function () {
    animaRoute.validateInput({
      prompt: 'x', modelId: 'anima-aesthetic-v1.1', loraId: 'L_NAT_V21_ANIMA', width: 832, height: 1216, character: 'nene',
    });
  }, function (error: any) { return error && error.code === 'INCOMPATIBLE_CHARACTER'; });
  assert.throws(function () {
    animaRoute.validateInput({ prompt: 'x', modelId: 'anima-base-v1.0', width: 832, height: 1216 });
  }, function (error: any) { return error && error.code === 'UNKNOWN_LORA'; }, 'non-noLora anima model must still require a LoRA');

  // Hires.fix workflow validation
  let hiresInput = animaRoute.validateInput({
    prompt: 'raiden_shogun, 1girl',
    negative: 'worst quality',
    modelId: 'anima-aesthetic-v1.1',
    width: 832,
    height: 1216,
    seed: 42,
    hiresFix: true,
    hiresScale: 2.0,
    hiresDenoise: 0.35,
  });
  assert.strictEqual(hiresInput.hiresFix, true);
  assert.strictEqual(hiresInput.hiresScale, 2.0);
  assert.strictEqual(hiresInput.hiresDenoise, 0.35);
  let hiresWf = animaRoute.buildWorkflow(hiresInput);
  assert.ok(hiresWf['11'], 'hires workflow must contain LatentUpscaleBy');
  assert.strictEqual(hiresWf['11'].class_type, 'LatentUpscaleBy');
  assert.strictEqual(hiresWf['11'].inputs.scale_by, 2.0);
  assert.ok(hiresWf['12'], 'hires workflow must contain 2nd KSampler');
  assert.strictEqual(hiresWf['12'].class_type, 'KSampler');
  assert.strictEqual(hiresWf['12'].inputs.denoise, 0.35);
  assert.strictEqual(hiresWf['12'].inputs.scheduler, 'sgm_uniform', 'hires 2nd pass scheduler turned on by user A/B (first pass stays simple)');
  assert.strictEqual(hiresWf['12'].inputs.sampler_name, 'res_multistep', 'hires 2nd pass keeps the decoupled res_multistep sampler');
  // 2026-08-25 确认：二阶段与首轮同走 TeaCache（全链加速，用户实测质量无差）；
  // hires 末端不挂 RCAS（433f93f 原样）。8 是解码节点，直接消费二阶段 latent。
  assert.strictEqual(hiresWf['12'].inputs.model[0], '13', 'hires 2nd pass follows TeaCache like first pass (full-chain acceleration)');
  assert.deepStrictEqual(hiresWf['8'].inputs.samples, ['12', 0], 'decode node consumes 2nd pass latent');
  assert.strictEqual(hiresWf['26'] === undefined, true, 'hires path must NOT attach RCAS (433f93f)');

  // 2026-08-25 转正：Remacri 路径改纯像素放大直出（二阶段低 denoise 重绘在 4MP
  // 外推 latent 上实测全脏——采样器/调度器/TeaCache/RCAS/显存机制穷举排除，
  // P1 纯像素直出与 Z1 VAE 往返直出均干净）。VAEDecode→UpscaleModelLoader→
  // ImageUpscaleWithModel→ImageScale→直出保存，无 VAEEncode/KSampler 重绘段。
  let srInput = Object.assign({}, hiresInput, { superResModel: '4x_foolhardy_Remacri.safetensors' });
  let srWf = animaRoute.buildWorkflow(srInput);
  assert.strictEqual(srWf['20'].class_type, 'VAEDecode', 'super-res: first-pass decode');
  assert.strictEqual(srWf['21'].class_type, 'UpscaleModelLoader', 'super-res: upscale model loader');
  assert.strictEqual(srWf['21'].inputs.model_name, '4x_foolhardy_Remacri.safetensors');
  assert.strictEqual(srWf['22'].class_type, 'ImageUpscaleWithModel', 'super-res: ESRGAN upscale');
  assert.strictEqual(srWf['22'].inputs.upscale_model[0], '21');
  assert.strictEqual(srWf['23'].class_type, 'ImageScale', 'super-res: scale to target');
  assert.strictEqual(srWf['23'].inputs.width, 1664, '832x2.0 = 1664 (8-aligned)');
  assert.deepStrictEqual(srWf['10'].inputs.images, ['23', 0], 'super-res: pure pixel output straight to SaveImage');
  assert.strictEqual(srWf['24'] === undefined && srWf['25'] === undefined, true, 'super-res: no VAEEncode/KSampler re-draw stage (dirty-chain removal 2026-08-25)');
  assert.strictEqual(srWf['35'] === undefined, true, 'super-res pure pixel path must NOT attach RCAS');

  // 2026-08-25 回归盲区修复：LoRA 分支 + superRes 组合——非 hires 文生图 RCAS 分支
  // 曾把 10 覆盖回 ['35',0]（Remacri 节点孤立、ComfyUI 跳过未消费节点、输出退回
  // 原尺寸；gateway 全链路实测根因）。lora 分支必须同样直出像素放大结果。
  let srLoraInput = {
    prompt:'ayachi_nene, 1girl', negative:'worst quality',
    modelId:'anima-base-v1.0', loraId:'L_NENE_V21_ANIMA', loraStrength:0.85,
    width:832, height:1216, steps:30, cfg:4.5,
    sampler:'res_multistep', scheduler:'simple', seed:42, character:'nene',
    hiresFix:true, hiresScale:2.0, hiresDenoise:0.35,
    superResModel:'4x_foolhardy_Remacri.safetensors',
  };
  let srLoraWf = animaRoute.buildWorkflow(srLoraInput);
  assert.strictEqual(srLoraWf['23'].class_type, 'ImageScale', 'lora super-res: scale node present');
  assert.deepStrictEqual(srLoraWf['10'].inputs.images, ['23', 0], 'lora super-res: SaveImage must consume the pure pixel output (isHires must exclude the non-hires RCAS branch)');
  assert.strictEqual(srLoraWf['35'] === undefined, true, 'lora super-res: no RCAS override on hires pixel path');
  assert.strictEqual(srLoraWf['25'] === undefined, true, 'lora super-res: no second-pass KSampler');
});

// 2026-08-16 审计：单条坏数据只被跳过并告警，不再让整份解析抛错丢弃。
test('parse isolates a single invalid entry instead of failing the whole dataset', () => {
  const charA = { id: 'ok_a', displayName: 'OK A', originalName: 'OK A', franchise: 'F', identityProse: 'a person', identityTokens: ['1girl'], exactTokens: [], exactPrefixes: [], recommendedEngine: 'anima-aesthetic-v1.1', supportedEngines: ['anima-aesthetic-v1.1'], adultEligibility: 'adult', outfits: [{ id: 'o1', name: 'O', prose: 'clothes', tokens: ['x'] }] };
  const charB = { id: 'ok_b', displayName: 'OK B', originalName: 'OK B', franchise: 'F', identityProse: 'a person', identityTokens: ['1girl'], exactTokens: [], exactPrefixes: [], recommendedEngine: 'anima-aesthetic-v1.1', supportedEngines: ['anima-aesthetic-v1.1'], adultEligibility: 'adult', outfits: [{ id: 'o1', name: 'O', prose: 'clothes', tokens: ['x'] }] };
  const chars = popular.parsePopularCharacters({ characters: [charA, { id: 'bad_char' }, charB] });
  assert.strictEqual(chars.length, 2, 'invalid entry skipped, valid entries kept');
  assert.deepStrictEqual(chars.map(c => c.id), ['ok_a', 'ok_b']);

  const bpA = { id: 'bp_ok_a', title: 'T', category: 'C', description: 'D', location: 'L', action: 'A', timeOfDay: 'night', lighting: 'moon', camera: 'wide', mood: 'calm', sceneTags: [], promptProse: 'prose', promptTokens: ['t'], negativeTokens: [], recommendedSize: '832x1216' };
  const bpB = { id: 'bp_ok_b', title: 'T', category: 'C', description: 'D', location: 'L', action: 'A', timeOfDay: 'night', lighting: 'moon', camera: 'wide', mood: 'calm', sceneTags: [], promptProse: 'prose', promptTokens: ['t'], negativeTokens: [], recommendedSize: '832x1216' };
  const bps = popular.parseSceneBlueprints({ blueprints: [bpA, { id: 'bp_bad' }, bpB] });
  assert.strictEqual(bps.length, 2, 'invalid blueprint skipped, valid ones kept');
});
