'use strict';

let assert: typeof import('assert') = require('assert');
let fs: typeof import('fs') = require('fs');
let path: typeof import('path') = require('path');
let test: typeof import('node:test') = require('node:test');
let popular: typeof import('../../src/utils/popularContent.ts') = require('../../src/utils/popularContent.ts');
const popularPrompt: typeof import('../../src/utils/popularPromptBuilder.ts') = require('../../src/utils/popularPromptBuilder.ts');
const blueprintDecisions: typeof import('../../src/utils/popularBlueprintDecisions.ts') = require('../../src/utils/popularBlueprintDecisions.ts');
const popularGuards: typeof import('../../src/utils/popularParseGuards.ts') = require('../../src/utils/popularParseGuards.ts');
const { recommendBlueprints }: typeof import('../../src/utils/blueprintRecommendations.ts') = require('../../src/utils/blueprintRecommendations.ts');
let recipes: typeof import('../../src/config/kreaStyleRecipes.ts') = require('../../src/config/kreaStyleRecipes.ts');
let persistence: typeof import('../../src/utils/promptBuilderPersistence.ts') = require('../../src/utils/promptBuilderPersistence.ts');

let ROOT = path.resolve(__dirname, '..', '..');
function readData(file: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', file), 'utf8'));
}
let characterData: unknown = readData('popular-characters.json');
let blueprintData: unknown = readData('scene-blueprints.json');

let characters = popular.parsePopularCharacters(characterData);
let blueprints = popular.parseSceneBlueprints(blueprintData);

let sfwOnlyIds = new Set(characters.filter(c => c.adultEligibility !== 'adult').map(c => c.id));
let legacyAdultIds = new Set(['shiina_mashiro', 'izumi_sagiri', 'takarada_rikka', 'hayasaka_ai', 'arima_kana', 'hori_kyouko']);
let remainingOnboarding = (require('../../data/popular-onboarding.json') as typeof import('../../data/popular-onboarding.json')).characters;
let onboardingIds = new Set(remainingOnboarding.map(c => c.id));

test('explicit SFW composition survives core and showcase guards without relaxing adult gates', () => {
  const policy: typeof import('../../src/utils/blueprintComposition.ts') = require('../../src/utils/blueprintComposition.ts');
  const generator: typeof import('../maintenance/generate-popular-showcase-anima11.js') = require('../maintenance/generate-popular-showcase-anima11.js');
  const profile: any = (require('../../data/presets.json') as typeof import('../../data/presets.json')).model_profiles.find(p => p.model_id === 'anima-miaomiao-v1.6');
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
      for (const token of ['triptych', 'comic strip', 'comic panel', 'border', 'white border', 'framed', 'multiple frames', 'duplicated subject', 'same character twice']) assert.ok(!neg.includes(token), token);
    } else {
      assert.ok(neg.includes('duplicate'), 'group still prevents accidental clones');
      assert.ok(neg.includes('triptych'), 'group remains one frame');
    }
    const k = popularPrompt.buildPopularPromptPlan({character:c,blueprint:b,outfit:popular.findOutfit(c,b!.outfitId!)!,engine:'krea2',adultEnabled:false});
    assert.ok(k && k.prompt.includes(b!.promptProse.split('.')[0]));
    assert.strictEqual(popularPrompt.buildPopularPromptPlan({character:c,blueprint:{...b,adult:true},outfit:popular.findOutfit(c,b!.outfitId!)!,engine:'anima',profile: profile as any,adultEnabled:false}),null);
    assert.strictEqual(policy.compositionIntent({...b,adult:true}), 'single');
  }
  assert.throws(() => popularGuards.parseCompositionIntent('anything'), /Invalid/);
  assert.strictEqual(popularGuards.parseCompositionIntent(undefined), 'single');
  const ordinary = blueprints.find(b => !b.adult && b.compositionIntent === 'single');
  const c = characters.find(c => c.id === ordinary!.characterId);
  const a = generator.buildCandidate(c, ordinary, profile, 1);
  const without = {...ordinary}; delete without.compositionIntent;
  const b = generator.buildCandidate(c, without, profile, 1);
  assert.strictEqual(a.prompt, b.prompt); assert.strictEqual(a.negative, b.negative);
  assert.ok(a.prompt.includes('(single girl only:1.4), (one person only:1.4)'));
  assert.ok(tokens(a.negative).includes('triptych'));
  assert.ok(policy.showcaseSubjectGuards({adult:true,compositionIntent:'group'}).prompt.includes('(solo:1.5)'));
  const repeated = {...ordinary!,compositionIntent:'group' as const,allowRepeatedSubject:true};
  const reflection = generator.buildCandidate(c!, repeated, profile, 1);
  assert.ok(!reflection.prompt.includes('no cloned characters'));
  for (const token of ['clone','duplicate','same character twice','duplicated subject']) assert.ok(!tokens(reflection.negative).includes(token));
  assert.ok(tokens(reflection.negative).includes('triptych'));
  const child = {...ordinary!,identityTokensOverride:['fixture_child','green_hair'],identityProseOverride:'The nonsexual childhood form of the same character.'};
  const childOutfit = {...popular.findOutfit(c!,child.outfitId!)!,tokens:['blue_coat'],prose:'a closed blue coat over trousers and boots'};
  const childPrompt = popularPrompt.buildPopularPromptPlan({character:c!,blueprint:child,outfit:childOutfit,engine:'anima',profile,adultEnabled:false})!;
  assert.ok(childPrompt.prompt.includes('green hair') && childPrompt.prompt.includes(child.identityProseOverride.replace(/[.!?]+$/,'')));
  assert.strictEqual(popularPrompt.buildPopularPromptPlan({character:c!,blueprint:{...child,adult:true},outfit:childOutfit,engine:'anima',profile,adultEnabled:true}),null);
});

test('onboarding scenes keep their outfit binding and compile safely in both engines', function () {
  const { resolveModelProfile }: typeof import('../../src/utils/promptPolicy.ts') = require('../../src/utils/promptPolicy.ts');
  const catalog = persistence.parsePresetCatalog((require('../../data/presets.json') as typeof import('../../data/presets.json')));
  for (const entry of remainingOnboarding) {
    const character = characters.find(c => c.id === entry.id);
    assert.ok(character, entry.id + ' must appear in the parsed catalog');
    assert.strictEqual(character.recommendedEngine, 'anima-miaomiao-v1.6');
    const owned = blueprints.filter(b => b.characterId === entry.id);
    const expectedSceneCount = entry.sceneCount;
    assert.strictEqual(owned.length, expectedSceneCount, entry.id + ' must have its complete parsed scene set');
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
        const model = engine === 'anima' ? 'anima-miaomiao-v1.6' : 'krea2-turbo-fp8';
        const profile: any = resolveModelProfile(catalog.modelProfiles, model, engine);
        const plan = popularPrompt.buildPopularPromptPlan({ character, outfit, blueprint, engine, profile, adultEnabled: true });
        assert.ok(plan, blueprint.id + ' must compile for ' + engine);
        assert.strictEqual(plan.adult, blueprint.adult);
        if (!blueprint.adult) assert.ok(!/\bnsfw\b|\bnude\b|\blingerie\b|bare breasts|exposed pussy/i.test(plan.prompt));
        if (engine === 'krea2') assert.strictEqual(plan.negative, '');
      }
    }
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
        const model = engine === 'anima' ? 'anima-miaomiao-v1.6' : 'krea2-turbo-fp8';
        const profile: any = resolveModelProfile(catalog.modelProfiles, model, engine);
        const plan = popularPrompt.buildPopularPromptPlan({ character, outfit, blueprint, engine, profile, adultEnabled: true });
        assert.ok(plan, blueprint.id + ' must compile for ' + engine);
        assert.strictEqual(plan.adult, blueprint.adult);
        if (!blueprint.adult) assert.ok(!/rating:explicit|\bnsfw\b|\bnude\b|bare breasts|exposed pussy/i.test(plan.prompt), blueprint.id + ' positive prompt must stay SFW');
        if (engine === 'krea2') assert.strictEqual(plan.negative, '');
      }
    }
  }
});

test('popular data: unique ids, exactly one default outfit and valid character metadata', function () {
  assert.ok(characters.length > 0, 'the production character corpus must not be empty');
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
    let leaks = popularPrompt.scanCharacterPollution(character);
    assert.deepStrictEqual(leaks, [], character.id + ' leaked studio LoRA anchors: ' + leaks.join(' | '));
    character.identityTokens.concat(character.exactTokens).forEach(function (token) {
      assert.ok(!/(?:ayachi_nene|shiki_natsume|^nene_|^natsume_)/i.test(token),
        character.id + ' leaked studio LoRA token ' + token);
    });
  });
  let synthetic = JSON.parse(JSON.stringify(characters[0]));
  synthetic.identityProse = 'a girl who looks like ayachi_nene in the rain';
  assert.deepStrictEqual(popularPrompt.scanCharacterPollution(synthetic), ['raiden_shogun.identityProse: studio character name']);
  synthetic.identityProse = 'plain prose';
  synthetic.outfits[0].tokens = ['nene_school_uniform', 'school_uniform'];
  assert.deepStrictEqual(popularPrompt.scanCharacterPollution(synthetic), ['raiden_shogun.outfit.shogun_robes: studio control prefix']);
});

test('blueprints preserve valid metadata and fail closed for non-adults', function () {
  assert.ok(blueprints.length > 0, 'the production blueprint corpus must not be empty');
  let ids = new Set(blueprints.map(function (blueprint) { return blueprint.id; }));
  assert.strictEqual(ids.size, blueprints.length, 'blueprint ids must be unique');
  blueprints.forEach(function (blueprint) {
    let text = JSON.stringify(blueprint);
    assert.ok(!/(?:ayachi_nene|shiki_natsume|nene_|natsume_)/i.test(text), blueprint.id + ' must not reference studio LoRA tokens');
    assert.ok(!/(?:official_cg|visual_audited)/i.test(text), blueprint.id + ' must not leak retrieval metadata');
    assert.ok(blueprint.promptProse.trim(), blueprint.id + ' needs a nonempty prose prompt');
    assert.ok(blueprint.promptTokens.length > 0, blueprint.id + ' needs prompt tokens');
  });
  assert.strictEqual(blueprints.filter(function (blueprint) { return !blueprint.characterId; }).length, 0,
    'every blueprint must belong to a character (generic blueprints were removed)');
  let adultBlueprints = blueprints.filter(function (blueprint) { return blueprint.adult; });
  assert.ok(adultBlueprints.length >= 1, 'adult-only blueprints must exist');
  let nonAdultCharacters = characters.filter(function (character) { return character.adultEligibility !== 'adult'; });
  nonAdultCharacters.forEach(function (character) {
    adultBlueprints.forEach(function (blueprint) {
      assert.strictEqual(popular.blueprintEligible(blueprint, character, { adultEnabled: true }), false,
        character.id + ' must never see adult blueprint ' + blueprint.id);
      assert.strictEqual(popularPrompt.buildPopularPromptPlan({
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
      assert.strictEqual(popularPrompt.buildPopularPromptPlan({ character, outfit: popular.findOutfit(character, blueprint.outfitId!)!, blueprint, engine, adultEnabled: false }), null, id + ' must fail closed in ' + engine);
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
      const plan = popularPrompt.buildPopularPromptPlan({ character, outfit: popular.findOutfit(character, blueprint.outfitId!)!, blueprint, engine, adultEnabled: false });
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
  assert.ok(scene);
  // The authored relationship is the contract; tags may use natural phrases.
  assert.match(scene.promptProse, /Amane(?: Fujimiya)?[^.]*offers (?:her )?his umbrella/i);
  assert.match(scene.promptProse, /she[^.]*reaches[^.]*handle/i);
  assert.doesNotMatch(scene.promptProse, /(?:Mahiru(?: Shiina)?|she)\s+(?:offers|holds out|hands over)\b[^.]*umbrella/i);
});

// All-outfit/default-SFW coverage is reported together by test-content-gate-repairs.
test('scene coverage: >=1 iconic + >=1 daily per character, >=1 special_nsfw among adults', function () {
  characters.forEach(function (character) {
    let owned = blueprints.filter(function (blueprint) { return blueprint.characterId === character.id; });
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

// Scene completeness is structural here, not visual acceptance. Current authoring
// preserves concrete light/space relations instead of mandating fog or DOF tags.
// Optional style hints and adult eligibility have independent guards below.
test('wallpaper-grade scenes: high-res sizes, authored atmosphere and no assembly quality words', function () {
  let forbidden = [
    'masterpiece', 'best_quality', 'amazing_quality', 'very_aesthetic',
    'absurdres', 'newest', 'highres', 'highly_detailed',
    'intricate_details', 'ultra_detailed', '8k', '4k',
  ];
  blueprints.forEach(function (blueprint) {
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
      || (onboardingIds.has(blueprint.characterId!) && !blueprint.adult)
      // Aisha and Fiona use concrete emitters, not a mandatory fog/DOF template.
      || blueprint.characterId === 'aisha_greyrat'
      || blueprint.characterId === 'fiona_frost') {
      assert.ok([...blueprint.promptTokens, blueprint.promptProse].some(t => /light|sun|dawn|morning|afternoon|noon|night|evening|lantern|neon|lamp|shade/i.test(t)), blueprint.id + ' must specify scene lighting or time in model input');
    }
  });
});

// 可执行的意图一致性约束；完整度按 studio-prompt-craft 审查，不由长度推断。
// ① 严禁使用 "Masterpiece visual novel H-CG artistry" 等无实质出图意义的元评论替代动作；
// ② description/action 中明确定义的两性结合（贯穿/中出/骑乘/交尾/后入/交尾压等）必须在 prose/nsfwProse 中有明确的动作动词，严禁尺度降级为单人露胸写真；
// ③ 体位与画幅轴向绑定防崩（后入/俯身强制横画幅，交尾压/垂直POV强制竖画幅）。
test('blueprints: adult story fidelity, no meta-commentary, and aspect-ratio integrity', function () {
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

    // ③ 画幅轴向防崩
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
  let first = recommendBlueprints(pool, 'raiden_shogun#shogun_robes', 0, null, 3);
  assert.strictEqual(first.length, 3);
  let repeat = recommendBlueprints(pool, 'raiden_shogun#shogun_robes', 0, null, 3);
  assert.deepStrictEqual(first.map(function (blueprint) { return blueprint.id; }), repeat.map(function (blueprint) { return blueprint.id; }),
    'same cursor must be deterministic');
  let second = recommendBlueprints(pool, 'raiden_shogun#shogun_robes', 1, first.map(function (blueprint) { return blueprint.id; }), 3);
  assert.notDeepStrictEqual(second.map(function (blueprint) { return blueprint.id; }), first.map(function (blueprint) { return blueprint.id; }),
    'consecutive cursor must avoid the previous set');
});

// Identity, outfit, scene, user direction and negative behavior use neutral fixtures in
// src/utils/popularPromptBuilder.spec.ts, independent of authored catalogue rewrites.

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
    let anima = popularPrompt.buildPopularPromptPlan({
      character: character, outfit: outfit, blueprint: blueprint,
      engine: 'anima', profile: animaProfile, adultEnabled: true,
    });
    let krea = popularPrompt.buildPopularPromptPlan({
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
      const result = popularPrompt.buildPopularPromptPlan({
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
  const decide = (fields: any) => blueprintDecisions.inferBlueprintDecisions({ ...base, ...fields }).lighting;
  assert.strictEqual(decide({ lighting: 'soft daylight', timeOfDay: 'day', promptProse: 'Saber from Fate/stay night with golden eyes.', sceneTags: [] }), null);
  assert.strictEqual(decide({ lighting: 'blue neon through the window', timeOfDay: 'night', sceneTags: ['night', 'golden_eyes'] }), null);
  assert.strictEqual(decide({ lighting: '月光透过窗户', timeOfDay: 'night', sceneTags: [] }), 'moon');
  assert.strictEqual(decide({ lighting: 'warm desk lamp', timeOfDay: 'night', sceneTags: ['moonlight'] }), null);
  assert.strictEqual(decide({ lighting: '', timeOfDay: 'night', sceneTags: ['night', 'golden_hair'] }), null);
  assert.strictEqual(decide({ lighting: '', timeOfDay: 'day', sceneTags: ['golden_hour'] }), 'golden');
  assert.strictEqual(decide({ lighting: 'soft afternoon window light', timeOfDay: 'afternoon' }), 'window');
  assert.strictEqual(decide({ lighting: '窗光', timeOfDay: '冬夜', sceneTags: [] }), 'window');
  assert.strictEqual(decide({ lighting: 'warm morning sunlight', timeOfDay: 'morning', sceneTags: [] }), null);
  assert.strictEqual(decide({ lighting: 'bright sunlight', timeOfDay: 'noon', sceneTags: [] }), null);
  assert.strictEqual(decide({ lighting: 'golden hologram light', timeOfDay: 'day', sceneTags: [] }), null);
  for (const adult of [false, true]) {
    for (const lighting of ['desk lamp', 'streetlamp', 'spotlight', 'candlelight', 'firelight', 'cool morning light']) {
      assert.strictEqual(decide({ adult, lighting, sceneTags: [] }), null, lighting);
    }
    assert.strictEqual(decide({ adult, lighting: 'cool fluorescent lighting', timeOfDay: 'night',
      promptProse: 'Inside a windowless room at night.', sceneTags: [] }), null);
  }
});

test('blueprint lighting: all SFW decisions are independent of prose, mood and camera contamination', function () {
  for (const blueprint of blueprints.filter(b => !b.adult)) {
    const expected = blueprintDecisions.inferBlueprintDecisions(blueprint).lighting;
    const noisy = { ...blueprint, camera: 'window portrait', mood: 'golden autumn night', promptProse: 'Golden eyes and moon-shaped jewelry from Fate/stay night, sunlight, candlelight.' };
    assert.strictEqual(blueprintDecisions.inferBlueprintDecisions(noisy).lighting, expected, blueprint.id + ': prose/camera/mood must not override the authored light');
  }
});

test('blueprint decisions: authored camera keywords resolve without borrowing prose', function () {
  let thunderNight = blueprints.find(function (item) { return item.id === 'raiden_shogun_thunder_night'; })!;
  let decision = blueprintDecisions.inferBlueprintDecisions(thunderNight);
  assert.strictEqual(decision.shot, 'wide', 'the corrected beach scene must retain its authored full-body framing');
  assert.strictEqual(blueprintDecisions.inferBlueprintDecisions({ ...thunderNight, camera: 'wide shot, dramatic low angle' } as any).shot, 'low',
    'authored "wide shot, dramatic low angle" must resolve to low angle, not lose to the longer "wide shot"/"medium" substring');
  assert.strictEqual(blueprintDecisions.inferBlueprintDecisions({ ...thunderNight, camera: 'medium shot', sceneTags: ['looking_back'], promptProse: 'Looking back over her shoulder.' } as any).shot, 'medium',
    'an action in scene prose must not replace the explicit camera distance');
  for (const adult of [false, true]) assert.strictEqual(blueprintDecisions.inferBlueprintDecisions({ ...thunderNight, adult, camera: 'full body, front view' } as any).shot, 'wide', 'frontal full-body camera must not become looking back');
  for (const adult of [false, true]) assert.strictEqual(blueprintDecisions.inferBlueprintDecisions({ ...thunderNight, adult, camera: 'medium close-up, front view' } as any).shot, 'close', 'frontal close view must retain its framing');
  let maiLibrary = blueprints.find(function (item) { return item.id === 'sakurajima_mai_library'; })!;
  assert.strictEqual(blueprintDecisions.inferBlueprintDecisions(maiLibrary).shot, 'low',
    '"cinematic low angle medium shot" must keep the authored low angle');
  assert.strictEqual(blueprintDecisions.inferBlueprintDecisions({ ...thunderNight, camera: '', promptProse: 'A wide shot.' }).shot, null,
    'unsupported camera metadata must not be filled from scene prose');
});

test('blueprint decisions: word boundaries and authored symmetry preserve explicit choices', () => {
  const mash = blueprints.find(b => b.id === 'mash_kyrielight_ortinax_launch')!;
  assert.strictEqual(blueprintDecisions.inferBlueprintDecisions(mash).shot, 'wide');
  assert.strictEqual(blueprintDecisions.inferBlueprintDecisions({ ...mash, camera: 'close-up of closed fists' }).shot, 'close');
  assert.strictEqual(blueprintDecisions.inferBlueprintDecisions({ ...mash, camera: 'full-body shot, low angle' }).shot, 'low');
  const mika = blueprints.find(b => b.id === 'misono_mika_tea_throne')!;
  const character = characters.find(c => c.id === mika.characterId)!;
  const outfit = popular.findOutfit(character, mika.outfitId!)!;
  const decisions = blueprintDecisions.inferBlueprintDecisions(mika);
  assert.strictEqual(decisions.composition, 'center');
  assert.strictEqual(blueprintDecisions.inferBlueprintDecisions({ ...mika, camera: 'medium shot, asymmetrical composition' }).composition, null);
  for (const engine of ['anima', 'krea2'] as const) {
    const automatic = popularPrompt.buildPopularPromptPlan({ character, outfit, blueprint: mika, engine, ...decisions })!;
    assert.ok(automatic.prompt.includes('centered composition'));
    assert.ok(!automatic.prompt.includes('rule of thirds'));
    const explicit = popularPrompt.buildPopularPromptPlan({ character, outfit, blueprint: mika, engine, ...decisions, shot: 'wide', composition: 'right' })!;
    assert.ok(explicit.prompt.includes('subject on the right side of the image'));
    assert.ok(!explicit.prompt.includes('centered composition'));
    const framed = popularPrompt.buildPopularPromptPlan({ character, outfit, blueprint: mika, engine, composition: 'frame' })!;
    assert.ok(framed.prompt.includes('natural framing'));
    assert.ok(!framed.prompt.split('\n')[0].split(',').map(t => t.trim()).includes('framed'));
  }
});

test('shared compiler retains reference outfit, manual pose, visual background and camera', () => {
  const source = blueprints.find(b => b.id === 'misono_mika_tea_throne')!;
  const character = characters.find(c => c.id === source.characterId)!;
  const outfit = popular.findOutfit(character, source.outfitId!)!;
  const blueprint = { ...source, promptTokens: ['sitting', 'garden'], promptProse: 'A garden beside a stone path.', mood: '' };
  const before = JSON.stringify({ character, outfit, blueprint });
  for (const engine of ['anima', 'krea2'] as const) {
    const result = popularPrompt.buildPopularPromptPlan({ character, outfit, blueprint, engine,
      outfitOverride: ['blue_coat'], manual: ['standing'], visualDescription: 'A forest path continues behind her.',
      shot: 'close', composition: 'left', lighting: 'moon',
    })!;
    assert.ok(/blue coat/.test(result.prompt));
    assert.ok(/standing/.test(result.prompt) && !/\bsitting\b/.test(result.prompt));
    assert.ok(/forest/.test(result.prompt) && /garden/i.test(result.prompt));
    assert.ok(/close-up/.test(result.prompt) && /moonlight/.test(result.prompt));
    assert.ok(/subject on the left side of the image/.test(result.prompt));
    assert.ok(result.prompt.includes('Mika'));
    assert.ok(!result.prompt.includes(outfit.prose));
  }
  assert.strictEqual(JSON.stringify({ character, outfit, blueprint }), before);
});

test('krea prose: director shot/lighting decisions must reach the compiled prompt', function () {
  let yor = popular.findCharacter(characters, 'yor_forger')!;
  let outfit = yor!.outfits.find(function (item) { return item.default; }) || yor!.outfits[0];
  let blueprint = blueprints.find(function (item) { return item.id === 'yor_moonlit_rooftop_stiletto'; })!;
  let built = popularPrompt.buildPopularPromptPlan({
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
  let anima = popularPrompt.buildPopularPromptPlan({
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
  let sanitized = popularPrompt.sanitizePopularManual(manual);
  assert.deepStrictEqual(sanitized, ['raiden_shogun', 'thighhighs']);
  let anima = popularPrompt.buildPopularPromptPlan({
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
  let adultBp = blueprints.find(blueprint => blueprint.adult && recipes.findStyleRecipe(recipes.KREA_STYLE_RECIPES, blueprint.kreaStyleHint)?.adult)!;

  // 无 hint / 无手选：引擎缺省。
  let auto = recipes.resolveStyleRecipe(recipes.KREA_STYLE_RECIPES, 'krea2', null, null, raiden, { adultEnabled: true });
  assert.strictEqual(auto!.lead, 'A polished visual novel event CG with refined cel shading, flat colors and crisp character work');
  let animaAuto = recipes.resolveStyleRecipe(recipes.KREA_STYLE_RECIPES, 'anima', null, null, raiden, { adultEnabled: true });
  assert.strictEqual(animaAuto, null, 'Anima automatic styling must leave the rendering to authored hints and selected artists');
  let animaBuilt = popularPrompt.buildPopularPromptPlan({
    character: raiden, outfit: raiden!.outfits[0], blueprint: null, engine: 'anima', profile: null, adultEnabled: true, style: animaAuto,
  });
  assert.ok(!/anime key visual|flat cel shading|clean lineart|saturated colors/.test(animaBuilt!.prompt), 'Anima must not invent a default rendering style');
  assert.ok(animaBuilt!.prompt.includes('Raiden Shogun from Genshin Impact'), 'Anima must receive the popular character identity prose');
  const explicitAnima = recipes.resolveStyleRecipe(recipes.KREA_STYLE_RECIPES, 'anima', null, 'anime_key_visual', raiden);
  const explicitBuilt = popularPrompt.buildPopularPromptPlan({ character: raiden, outfit: raiden.outfits[0], blueprint: null,
    engine: 'anima', style: explicitAnima });
  assert.ok(explicitBuilt!.prompt.includes('flat cel shading'), 'Explicit cel styling must remain available');

  // 无 hint 时采用引擎缺省；hint 是否出现与蓝图分级独立。
  let hinted = recipes.resolveStyleRecipe(recipes.KREA_STYLE_RECIPES, 'krea2', flower, null, raiden, { adultEnabled: true });
  assert.strictEqual(hinted!.lead, auto!.lead, 'character scene without kreaStyleHint must fall back to the engine default');
  let hintedAnima = recipes.resolveStyleRecipe(recipes.KREA_STYLE_RECIPES, 'anima', flower, null, raiden, { adultEnabled: true });
  assert.strictEqual(hintedAnima, null, 'Anima scenes without an authored style hint must not add a rendering style');

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

// Krea prose and build-layer adult-style rejection are covered with neutral fixtures
// in src/utils/popularPromptBuilder.spec.ts; recipe eligibility above stays independent.

test('blueprint style hints are optional independently of the rating gate', function () {
  const source = blueprints.find(blueprint => !blueprint.adult)!;
  for (const adult of [false, true]) {
    const [parsed] = popular.parseSceneBlueprints([{ ...source, adult, kreaStyleHint: undefined, animaStyleHint: undefined }]);
    assert.ok(parsed);
    assert.strictEqual(parsed.adult, adult);
    assert.strictEqual(parsed.kreaStyleHint, undefined);
    assert.strictEqual(parsed.animaStyleHint, undefined);
  }
});

test('prompt compiler: Anima negative merges profile negative_prefix per negative_mode, Krea stays empty', function () {
  let raiden = popular.findCharacter(characters, 'raiden_shogun')!;
  let outfit = raiden!.outfits[0];
  let blueprint = blueprints.find(function (item) { return item.id === 'raiden_shogun_thunder_night'; })!;
  blueprint = { ...blueprint, negativeTokens: [...blueprint!.negativeTokens, 'neon'] };
  // anima_aesthetic_v11：negative_mode=replace, replace_scope=boilerplate。
  let profile: any = { engine: 'anima', negative_prefix: 'worst quality, low quality, artist name, blurry, jpeg artifacts, chromatic aberration', negative_mode: 'replace', negative_replace_scope: 'boilerplate', exact_tokens: ['best_quality'] };

  let anima = popularPrompt.buildPopularPromptPlan({
    character: raiden, outfit: outfit, blueprint: blueprint, engine: 'anima', profile: profile, adultEnabled: true,
  });
  assert.ok(anima, 'anima plan must build');
  assert.ok(anima.negative.includes('artist name'), 'profile negative_prefix must be merged in');
  assert.ok(anima.negative.includes('chromatic aberration'), 'profile negative_prefix tail must be merged in');
  assert.ok(anima.negative.includes('neon'), 'fixture non-boilerplate negative must be kept');
  assert.ok(!anima.negative.includes('<lora:'), 'no lora syntax in negative');

  let krea = popularPrompt.buildPopularPromptPlan({
    character: raiden, outfit: outfit, blueprint: blueprint, engine: 'krea2', profile: profile, adultEnabled: true,
  });
  assert.ok(krea);
  assert.strictEqual(krea.negative, '', 'Krea negative must always be empty regardless of profile prefix');
});

test('curated artist styles use native Anima tags and Krea prose', function () {
  let raiden = popular.findCharacter(characters, 'raiden_shogun')!;
  let outfit = raiden!.outfits[0];
  let blueprint = blueprints.find(function (item) { return item.id === 'raiden_shogun_narukami_shrine'; })!;
  let anima = popularPrompt.buildPopularPromptPlan({
    character: raiden, outfit: outfit, blueprint: blueprint, engine: 'anima', profile: { engine:'anima' },
    artistTags: ['@kantoku', '@mika pikazo'], artistProse: 'with visual styling inspired by Kantoku and Mika Pikazo',
  });
  assert.ok(anima!.prompt.includes('@kantoku') && anima!.prompt.includes('@mika pikazo'));
  let krea = popularPrompt.buildPopularPromptPlan({
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
  let rejected = popularPrompt.buildPopularPromptPlan({
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
