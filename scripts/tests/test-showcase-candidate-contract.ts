'use strict';

/**
 * Contract sentinels for the showcase-candidate generation pipeline
 * (scripts/maintenance/generate-showcase-candidates.js).
 *
 * Pins, without touching the network:
 *   - complete batch plan (13 artist / 18 popular / 8 latest-lora = 39
 *     attempt-1 + 14 review-override attempt-2 + 6 attempt-3 + 2 attempt-4 = 61)
 *   - artist-tag syntax for both WAI and Anima
 *   - 18-character popular coverage with default outfits and no adult content
 *     for non-adult characters
 *   - production latest-LoRA ids / files / strength / checkpoint
 *   - attempt-2/3/4 record chains (supersedes / reviewReason / seeds)
 *   - attempt-4 = the 2026-08-12 corrected 四季夏目 mole side: character's own
 *     right eye (viewer-left cheek), 960x1536 coverage, fresh seeds; the
 *     attempt-2/3 "left-eye mole" rules are pinned as HISTORICAL MISJUDGEMENTS
 *     whose prompts stay verbatim to match the already-generated history
 *   - --attempt CLI filter semantics
 *   - resume + atomic-manifest behaviour
 *   - hard refusal to write into the public SceneShowcase directory
 */

const assert: typeof import('assert') = require('assert');
const fs: typeof import('fs') = require('fs');
const os: typeof import('os') = require('os');
const path: typeof import('path') = require('path');
const { test }: typeof import('node:test') = require('node:test');

test('standalone MiaoMiao selection reaches profile, checkpoint and submission without losing character LoRA', () => {
  const generator: typeof import('../maintenance/generate-scene-showcase-anima11.js') = require('../maintenance/generate-scene-showcase-anima11.js');
  const scene = (require('../../data/scenes.json') as typeof import('../../data/scenes.json')).find(scene => scene.id === 'sc002');
  const candidate = generator.buildAnimaCandidate(scene, 1, 1, { modelId: 'anima-miaomiao-v1.2' });
  const model = (require('../../routes/anima.js') as typeof import('../../routes/anima.js')).constants.MODELS[candidate.modelId];
  assert.strictEqual(candidate.profileId, 'anima_miaomiao_v12');
  assert.strictEqual(candidate.checkpoint, model.file);
  assert.ok(model.sizes.includes(`${candidate.width}x${candidate.height}`));
  assert.strictEqual(candidate.loraId, 'L_NENE_V21_ANIMA');
  assert.strictEqual(generator.buildSubmissionBody(candidate).modelId, 'anima-miaomiao-v1.2');
  assert.throws(() => generator.buildAnimaCandidate(scene, 1, 1, { modelId: 'missing-model' }), /unsupported Anima model/);
});

const gen: typeof import('../../scripts/maintenance/generate-showcase-candidates.js') = require('../../scripts/maintenance/generate-showcase-candidates.js');
const sceneGen: typeof import('../../scripts/maintenance/generate-scene-showcase-candidates.js') = require('../../scripts/maintenance/generate-scene-showcase-candidates.js');
const popularData: typeof import('../../data/popular-characters.json') = require('../../data/popular-characters.json');
// 2026-08-16 审计：热门角色由 18 扩容到 33 后，本文件多处硬编码 18 漂移；
// 统一改为数据派生计数，契约意图（全覆盖）不变。
const popularCount = (Array.isArray(popularData) ? popularData : (popularData && popularData.characters) || []).length;
const sceneBlueprints = (require('../../data/scene-blueprints.json') as typeof import('../../data/scene-blueprints.json')).blueprints;
const artistCatalog: typeof import('../../src/config/artistStyleCatalog.ts') = require('../../src/config/artistStyleCatalog.ts');
const artistStyles: typeof import('../../src/config/artistStyles.ts') = require('../../src/config/artistStyles.ts');
const genConst = (require('../../routes/generation.js') as typeof import('../../routes/generation.js')).constants;
const animaConst = (require('../../routes/anima.js') as typeof import('../../routes/anima.js')).constants;
const loraData: typeof import('../../data/loras.json') = require('../../data/loras.json');

const studioStoreSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'stores', 'promptBuilderStore.ts'),
  'utf8',
);

test('batch plan expands consistently with the curated artist catalog', () => {
  const plan = gen.planAllBatches(20260812);
  const artistCount = artistCatalog.ARTIST_STYLE_OPTIONS.length;
  const artistVariants = artistCount + 1;
  // 2026-08-15 扩容后角色场景数不再均匀（12 角色 10 场景 + 6 角色 9 场景，另有
  // 3 条通用成人蓝图），grid 按每角色实际拥有数 + 通用数逐角色派生，避免硬编码漂移。
  const perCharScenes = sceneBlueprints.reduce((acc: any, bp) => {
    if (bp.characterId) acc[bp.characterId] = (acc[bp.characterId] || 0) + 1;
    return acc;
  }, {});
  const genericSceneCount = sceneBlueprints.filter(bp => !bp.characterId).length;
  const popularGrid = Object.values(perCharScenes)
    .reduce((sum, owned: any) => sum + (owned + genericSceneCount), 0) * 2;
  const expectedAttempt1 = artistVariants + popularCount + 8 + popularGrid + artistVariants * 2;
  // 明细：artistVariants 张画师（29 画师 + no-artist，含 3 个重点画师追加轮）
  //       + popularCount popular（角色专属场景）+ 8 latest-lora（nene/natsume × sd/anima × closeup/fullbody）
  //       + popularGrid popular-grid（18 角色 × 各自场景 + 3 通用 × 2 引擎，全部 adult 开放）
  //       + artistVariants×2 artist-grid
  const expectedTotal = expectedAttempt1 + 14 + 6 + 2;
  assert.strictEqual(plan.length, expectedTotal, `expected ${expectedTotal} planned jobs, got ${plan.length}`);
  const attempt1 = plan.filter(item => item.attempt === 1);
  const attempt2 = plan.filter(item => item.attempt === 2);
  const attempt3 = plan.filter(item => item.attempt === 3);
  const attempt4 = plan.filter(item => item.attempt === 4);
  assert.strictEqual(attempt1.length, expectedAttempt1, 'attempt-1 covers all catalog-derived legacy and grid keys');
  assert.strictEqual(attempt2.length, 14);
  assert.strictEqual(attempt3.length, 6);
  assert.strictEqual(attempt4.length, 2);
  const legacy1 = attempt1.filter(item => item.batch !== 'popular-grid' && item.batch !== 'artist-grid');
  const counts = legacy1.reduce((acc, item) => { acc[item.batch] = (acc[item.batch] || 0) + 1; return acc; }, {});
  assert.deepStrictEqual(counts, { artist: artistVariants, popular: popularCount, 'latest-lora': 8 });
  const gridCounts = plan.reduce((acc, item) => { acc[item.batch] = (acc[item.batch] || 0) + 1; return acc; }, {});
  assert.strictEqual(gridCounts['popular-grid'], popularGrid,
    `popular-grid must plan ${popularGrid} (per-character scenes + ${genericSceneCount} generic x 2 engines, data-derived)`);
  assert.strictEqual(gridCounts['artist-grid'], artistVariants * 2, 'artist-grid must plan every artist + baseline across two engines');
  const recordIds = new Set(plan.map(item => item.recordId));
  assert.strictEqual(recordIds.size, plan.length, 'recordIds must be unique');
  const keys = new Set(plan.map(item => item.key));
  assert.strictEqual(keys.size, expectedAttempt1, 'attempt-1 key count must match the catalog-derived plan');
  assert.ok(plan.every(item => item.promptHealth && typeof item.promptHealth.ok === 'boolean'),
    'every candidate must carry an auditable prompt health report');
});

test('review overrides: exact 14 keys, deterministic seed offsets, supersedes/reviewReason', () => {
  const plan = gen.planAllBatches(20260812);
  const expectedKeys = Object.keys(gen.REVIEW_OVERRIDES).sort();
  assert.deepStrictEqual(expectedKeys, [
    'artist:bunbun', 'artist:nardack',
    'popular:emilia_rezero', 'popular:hatsune_miku', 'popular:misaka_mikoto',
    'popular:sakurajima_mai', 'popular:tokisaki_kurumi', 'popular:yukinoshita_yukino',
    'popular:yuzuriha_inori',
    'latest-lora:nene:sd:closeup', 'latest-lora:nene:sd:fullbody',
    'latest-lora:natsume:sd:fullbody', 'latest-lora:natsume:anima:closeup',
    'latest-lora:natsume:anima:fullbody',
  ].sort(), 'REVIEW_OVERRIDES must cover exactly the reviewed keys');
  for (const key of expectedKeys) {
    const base = plan.find(item => item.key === key && item.attempt === 1);
    const second = plan.find(item => item.key === key && item.attempt === 2);
    assert.ok(base, `missing attempt-1 for ${key}`);
    assert.ok(second, `missing attempt-2 for ${key}`);
    const override = gen.REVIEW_OVERRIDES[key];
    assert.strictEqual(second.recordId, `${key}@attempt-2`);
    assert.strictEqual(second.supersedes, `${key}@attempt-1`);
    assert.ok(second.reviewReason, `${key} must carry a reviewReason`);
    const expectedSeed = (base.seed + (Number(override.seedOffset) || 0)) % 2147483647;
    assert.strictEqual(second.seed, expectedSeed, `${key} seed offset`);
    assert.strictEqual(second.checkpoint, base.checkpoint, `${key} engine/checkpoint unchanged`);
    assert.strictEqual(second.loraId, base.loraId, `${key} LoRA selection unchanged`);
    assert.strictEqual(second.width, base.width, `${key} size unchanged`);
    assert.strictEqual(second.height, base.height, `${key} size unchanged`);
    assert.strictEqual(gen.imageRelFor(second), `images/${second.batch}/${second.key.replace(/[:\/\\]/g, '_')}_attempt-2.png`, `${key} attempt-2 file name`);
    assert.strictEqual(gen.imageRelFor(base), `images/${base.batch}/${base.key.replace(/[:\/\\]/g, '_')}.png`, `${key} attempt-1 file name must not change`);
  }
});

test('WAI weighted artist tags survive the formatter verbatim (no artist: prefix)', () => {
  const bunbun = gen.buildArtistPrompt('bunbun', { artistTag: '(bunbun:1.2)', negativeAppend: ['malformed buttons', 'clothing fasteners'] });
  assert.ok(bunbun.prompt.endsWith(', (bunbun:1.2)'), `weighted WAI tag must end the prompt raw: ${bunbun.prompt}`);
  assert.ok(bunbun.prompt.includes('(bunbun:1.2)'));
  assert.ok(!bunbun.prompt.includes('artist:'), 'no SD artist: prefix syntax may be used');
  assert.ok(bunbun.negative.includes('malformed buttons') && bunbun.negative.includes('clothing fasteners'));
  const nardack = gen.buildArtistPrompt('nardack', { artistTag: '(nardack:1.1)', negativeAppend: ['abnormal light spot on neck', 'broken bag strap'] });
  assert.ok(nardack.prompt.endsWith(', (nardack:1.1)'), `weighted nardack tag must survive: ${nardack.prompt}`);
  assert.ok(nardack.negative.includes('abnormal light spot on neck'));
  // Attempt-1 keeps the raw unweighted tag (contract unchanged).
  const base = gen.buildArtistPrompt('bunbun');
  assert.ok(base.prompt.endsWith(', bunbun'), `attempt-1 keeps raw tag: ${base.prompt}`);
});

test('attempt-2 popular prompts apply Anima space-contract reinforcement + negative', () => {
  const plan = gen.planAllBatches(20260812);
  const emilia = plan.find(item => item.recordId === 'popular:emilia_rezero@attempt-2');
  assert.ok(emilia.prompt.includes('white dress, lilac dress, purple flower ornament, brooch, long sleeves'), emilia.prompt);
  assert.ok(emilia.negative.includes('casual dress, blue dress'), emilia.negative);
  assert.ok(!/(ayachi_nene|shiki_natsume|nene_|natsume_)/i.test(emilia.prompt), 'no studio LoRA anchor leak');
  const miku = plan.find(item => item.recordId === 'popular:hatsune_miku@attempt-2');
  assert.ok(miku.prompt.includes('black pleated skirt') && miku.prompt.includes('detached black sleeves'));
  assert.ok(miku.negative.includes('short sleeves') && miku.negative.includes('red bow'));
  const kurumi = plan.find(item => item.recordId === 'popular:tokisaki_kurumi@attempt-2');
  assert.ok(kurumi.prompt.includes('left eye golden clock-face pupil') && kurumi.prompt.includes('heterochromia'));
  assert.ok(kurumi.negative.includes('both red eyes') && kurumi.negative.includes('plain black dress'));
  const inori = plan.find(item => item.recordId === 'popular:yuzuriha_inori@attempt-2');
  assert.ok(inori.prompt.includes('red dress') && inori.prompt.includes('layered skirt'), `inori red-dress reinforcement: ${inori.prompt}`);
  assert.ok(inori.negative.includes('white sleeveless shirt') && inori.negative.includes('casual shorts'));
  assert.strictEqual(inori.outfitId, 'funeral_parade', 'inori keeps the JSON default outfit');
});

test('attempt-2 latest-lora: camera framing override and mole-side reinforcement', () => {
  // HISTORICAL MISJUDGEMENT (2026-08-12): the anima closeup mole-side assertions
  // below pin the incorrect "mole under left eye" attempt-2 prompt VERBATIM -
  // the record must keep matching the already-generated history. The corrected
  // right-eye (viewer-left) contract is asserted by the attempt-4 test.
  const plan = gen.planAllBatches(20260812);
  const neneCloseup = plan.find(item => item.recordId === 'latest-lora:nene:sd:closeup@attempt-2');
  assert.ok(neneCloseup.prompt.includes('bust') && !neneCloseup.prompt.includes('close_up'), `closeup must switch to bust framing: ${neneCloseup.prompt}`);
  assert.ok(neneCloseup.negative.includes('extreme close-up') && neneCloseup.negative.includes('cropped head'));
  const neneFull = plan.find(item => item.recordId === 'latest-lora:nene:sd:fullbody@attempt-2');
  assert.ok(neneFull.prompt.includes('standing') && neneFull.prompt.includes('full_body'));
  assert.ok(neneFull.negative.includes('cowboy shot') && neneFull.negative.includes('kneeling'));
  const natFull = plan.find(item => item.recordId === 'latest-lora:natsume:sd:fullbody@attempt-2');
  assert.ok(natFull.prompt.includes('two red hairclips') && natFull.prompt.includes('shoes'));
  assert.ok(natFull.negative.includes('cropped feet') && natFull.negative.includes('missing hairclips'));
  const natCloseup = plan.find(item => item.recordId === 'latest-lora:natsume:anima:closeup@attempt-2');
  assert.ok(natCloseup.prompt.includes('mole under left eye') && !natCloseup.prompt.includes('mole_under_left_eye'), `left-eye mole must be space-form: ${natCloseup.prompt}`);
  assert.ok(natCloseup.negative.includes('mole under right eye'));
  const natFullAnima = plan.find(item => item.recordId === 'latest-lora:natsume:anima:fullbody@attempt-2');
  assert.ok(natFullAnima.negative.includes('hair ribbon') && natFullAnima.negative.includes('hairband'));
  const baseSeed = plan.find(item => item.key === 'latest-lora:natsume:anima:fullbody' && item.attempt === 1).seed;
  assert.strictEqual(natFullAnima.seed, baseSeed, 'natsume anima fullbody keeps attempt-1 seed (negative-only fix)');
});

test('attempt-3 overrides: exactly 6 keys, record chain, fresh seeds, image names', () => {
  const plan = gen.planAllBatches(20260812);
  const expectedKeys = Object.keys(gen.ATTEMPT_3_OVERRIDES).sort();
  assert.deepStrictEqual(expectedKeys, [
    'artist:so-bin',
    'popular:makima',
    'latest-lora:nene:sd:fullbody',
    'latest-lora:natsume:sd:closeup',
    'latest-lora:natsume:sd:fullbody',
    'latest-lora:natsume:anima:closeup',
  ].sort(), 'ATTEMPT_3_OVERRIDES must cover exactly the six re-reviewed keys');
  for (const key of expectedKeys) {
    const base = plan.find(item => item.key === key && item.attempt === 1);
    const third = plan.find(item => item.key === key && item.attempt === 3);
    assert.ok(base, `missing attempt-1 for ${key}`);
    assert.ok(third, `missing attempt-3 for ${key}`);
    const hasAttemptTwo = Boolean(plan.find(item => item.key === key && item.attempt === 2));
    const override = gen.ATTEMPT_3_OVERRIDES[key];
    assert.strictEqual(third.recordId, `${key}@attempt-3`);
    assert.strictEqual(third.supersedes, `${key}@attempt-${hasAttemptTwo ? 2 : 1}`,
      `${key} supersedes must point at attempt-2 when present, otherwise attempt-1`);
    assert.ok(third.reviewReason, `${key} must carry a reviewReason`);
    const expectedSeed = (base.seed + (Number(override.seedOffset) || 0)) % 2147483647;
    assert.strictEqual(third.seed, expectedSeed, `${key} seed offset`);
    assert.notStrictEqual(third.seed, base.seed, `${key} must change seed from attempt-1`);
    const attemptTwo = plan.find(item => item.key === key && item.attempt === 2);
    if (attemptTwo) assert.notStrictEqual(third.seed, attemptTwo.seed, `${key} must change seed from attempt-2`);
    assert.strictEqual(third.checkpoint, base.checkpoint, `${key} engine/checkpoint unchanged`);
    assert.strictEqual(third.loraId, base.loraId, `${key} LoRA selection unchanged`);
    assert.strictEqual(third.width, base.width, `${key} size unchanged`);
    assert.strictEqual(third.height, base.height, `${key} size unchanged`);
    if (key === 'latest-lora:nene:sd:fullbody') {
      assert.strictEqual(third.width, 832, `${key} must keep 832x1216`);
      assert.strictEqual(third.height, 1216, `${key} must keep 832x1216`);
    }
    assert.strictEqual(gen.imageRelFor(third), `images/${third.batch}/${third.key.replace(/[:\/\\]/g, '_')}_attempt-3.png`, `${key} attempt-3 file name`);
    assert.strictEqual(gen.imageRelFor(base), `images/${base.batch}/${base.key.replace(/[:\/\\]/g, '_')}.png`, `${key} attempt-1 file name must not change`);
  }
  assert.deepStrictEqual([...plan].filter(item => item.attempt === 3).map(item => item.recordId).sort(),
    expectedKeys.map(key => `${key}@attempt-3`).sort(), 'exactly the six attempt-3 records are planned');
});

test('attempt-3 so-bin: WAI raw weighted tag, style reinforcement, day city kept', () => {
  const plan = gen.planAllBatches(20260812);
  const sobin = plan.find(item => item.recordId === 'artist:so-bin@attempt-3');
  assert.ok(sobin.prompt.includes('(so-bin:1.3)'), `weighted WAI tag must appear raw: ${sobin.prompt}`);
  assert.ok(!sobin.prompt.includes('artist:'), 'no SD artist: prefix syntax may be used');
  assert.ok(!/<lora:/i.test(sobin.prompt), 'no non-existent LoRA may be introduced');
  for (const token of ['dramatic dark shadows', 'heavy painterly brushwork', 'dark fantasy oil-paint texture']) {
    assert.ok(sobin.prompt.includes(token), `so-bin missing style token ${token}`);
  }
  // White shirt + open jacket + daytime city street must survive.
  assert.ok(sobin.prompt.includes('white_shirt') && sobin.prompt.includes('open_jacket'));
  assert.ok(sobin.prompt.includes('city_street') && sobin.prompt.includes('day'));
  assert.ok(!/night|dark scene|moon/i.test(sobin.prompt), 'scene must not be turned into night');
  assert.ok(sobin.negative.includes('night'), 'night stays guarded in negative');
  assert.strictEqual(sobin.engine, 'sd');
  assert.strictEqual(sobin.modelId, gen.constants.WAI_MODEL_ID, 'so-bin stays on the WAI model, no LoRA');
});

test('attempt-3 makima: ringed eyes + back braid + suit trousers, suppressors', () => {
  const plan = gen.planAllBatches(20260812);
  const makima = plan.find(item => item.recordId === 'popular:makima@attempt-3');
  for (const token of ['golden eyes', 'ringed eyes', 'concentric circles in eyes', 'single long back braid', 'black suit trousers']) {
    assert.ok(makima.prompt.includes(token), `makima prompt missing ${token}`);
  }
  for (const token of ['solid red eyes', 'loose untied hair', 'pleated skirt', 'ahoge']) {
    assert.ok(makima.negative.includes(token), `makima negative missing ${token}`);
  }
  assert.strictEqual(makima.engine, 'anima');
  assert.ok(makima.sampler === 'res_multistep' && makima.scheduler === 'simple', 'Anima sampler/scheduler contract');
});

test('attempt-3 latest-lora: fullbody framing + mole/hairclip sentinels per engine', () => {
  // HISTORICAL MISJUDGEMENT (2026-08-12): the three natsume mole-side blocks
  // below ("mole under left eye / mole on left cheek") pin the incorrect
  // attempt-3 prompts VERBATIM so they keep matching the generated history.
  // The corrected right-eye (viewer-left) contract is asserted by the
  // attempt-4 test.
  const plan = gen.planAllBatches(20260812);
  const neneFull = plan.find(item => item.recordId === 'latest-lora:nene:sd:fullbody@attempt-3');
  for (const token of ['full body', 'standing', 'feet', 'shoes', 'full length portrait']) {
    assert.ok(neneFull.prompt.includes(token), `nene fullbody prompt missing ${token}`);
  }
  for (const token of ['cropped legs', 'cowboy shot', 'thigh cut-off', 'missing feet', 'cropped feet']) {
    assert.ok(neneFull.negative.includes(token), `nene fullbody negative missing ${token}`);
  }
  assert.strictEqual(neneFull.engine, 'sd');
  assert.strictEqual(neneFull.width, 832);
  assert.strictEqual(neneFull.height, 1216);

  const natSdCloseup = plan.find(item => item.recordId === 'latest-lora:natsume:sd:closeup@attempt-3');
  for (const token of ['mole under left eye', 'mole on left cheek', 'two red hairclips']) {
    assert.ok(natSdCloseup.prompt.includes(token), `natsume sd closeup prompt missing ${token}`);
  }
  assert.ok(natSdCloseup.negative.includes('mole under right eye') && natSdCloseup.negative.includes('mole on right cheek'));

  const natSdFull = plan.find(item => item.recordId === 'latest-lora:natsume:sd:fullbody@attempt-3');
  for (const token of ['mole under left eye', 'mole on left cheek', 'two red hairclips', 'full body', 'standing', 'shoes']) {
    assert.ok(natSdFull.prompt.includes(token), `natsume sd fullbody prompt missing ${token}`);
  }
  for (const token of ['mole under right eye', 'mole on right cheek', 'missing mole', 'missing hairclips', 'kneeling', 'sitting', 'cropped feet']) {
    assert.ok(natSdFull.negative.includes(token), `natsume sd fullbody negative missing ${token}`);
  }

  const natAnimaCloseup = plan.find(item => item.recordId === 'latest-lora:natsume:anima:closeup@attempt-3');
  for (const token of ['mole under left eye', 'mole on left cheek', 'two red hairclips']) {
    assert.ok(natAnimaCloseup.prompt.includes(token), `natsume anima closeup prompt missing ${token}`);
  }
  assert.ok(!natAnimaCloseup.prompt.includes('mole_under_left_eye'), 'Anima closeup mole must stay space-form');
  assert.ok(natAnimaCloseup.negative.includes('mole under right eye') && natAnimaCloseup.negative.includes('mole on right cheek'));
  assert.strictEqual(natAnimaCloseup.engine, 'anima');
  assert.ok(natAnimaCloseup.sampler === 'res_multistep' && natAnimaCloseup.scheduler === 'simple', 'Anima sampler/scheduler contract');
});

test('attempt-4: exactly two natsume fullbody keys, corrected right-eye mole contract, size, chain, fresh seeds', () => {
  const plan = gen.planAllBatches(20260812);
  const expectedKeys = Object.keys(gen.ATTEMPT_4_OVERRIDES).sort();
  assert.deepStrictEqual(expectedKeys, [
    'latest-lora:natsume:anima:fullbody',
    'latest-lora:natsume:sd:fullbody',
  ].sort(), 'ATTEMPT_4_OVERRIDES must cover exactly the two still-failing natsume fullbody keys');

  const expectedChain = new Map([
    ['latest-lora:natsume:sd:fullbody', 'latest-lora:natsume:sd:fullbody@attempt-3'],
    ['latest-lora:natsume:anima:fullbody', 'latest-lora:natsume:anima:fullbody@attempt-2'],
  ]);
  for (const key of expectedKeys) {
    const fourth = plan.find(item => item.key === key && item.attempt === 4);
    assert.ok(fourth, `missing attempt-4 for ${key}`);
    const override = gen.ATTEMPT_4_OVERRIDES[key];
    assert.strictEqual(fourth.recordId, `${key}@attempt-4`);
    assert.strictEqual(fourth.supersedes, expectedChain.get(key),
      `${key} supersedes must point at the key's latest prior attempt`);
    assert.ok(fourth.reviewReason && fourth.reviewReason.includes('历史误判'),
      `${key} reviewReason must document the 2026-08-12 correction`);
    // Corrected positive contract: character's OWN right-eye mole + viewer-left
    // cheek disambiguation, two red hairclips, full qipao standing with shoes,
    // and no white/extra hair ribbon (no_hair_ribbon already sits on the line).
    assert.ok(fourth.prompt.includes('mole under right eye'), `${key} must pin the character's own right-eye mole`);
    assert.ok(fourth.prompt.includes('viewer-left cheek beauty mark'), `${key} must disambiguate the mirror with viewer-left cheek`);
    assert.ok(fourth.prompt.includes('two red hairclips'), `${key} must keep two red hairclips`);
    assert.ok(!fourth.prompt.includes('mole under left eye'), `${key} must drop the historical left-eye mole from the positive`);
    assert.ok(fourth.prompt.includes('full body') && fourth.prompt.includes('standing') && fourth.prompt.includes('shoes'),
      `${key} must keep full-body standing with shoes`);
    // Wrong-side / missing-feature negatives.
    for (const token of [
      'mole under left eye', 'mole on left cheek', 'beauty mark on right cheek',
      'mole on both cheeks', 'moles under both eyes', 'missing mole',
      'missing hairclips', 'single hairclip', 'hair ribbon', 'white ribbon', 'hairband',
      'kneeling', 'sitting', 'cropped feet',
    ]) {
      assert.ok(fourth.negative.includes(token), `${key} negative missing suppressor "${token}"`);
    }
    // attempt-4 size override: 960x1536, 64-aligned, area 1,474,560 under the
    // Anima 1.5M cap; Base accepts it (anima-base-v1.0 whitelists 960x1536),
    // Aesthetic does not (its sizes stay unchanged).
    assert.strictEqual(fourth.width, 960, `${key} width must be 960`);
    assert.strictEqual(fourth.height, 1536, `${key} height must be 1536`);
    assert.strictEqual(fourth.width % 64, 0, `${key} width must stay 64-aligned`);
    assert.strictEqual(fourth.height % 64, 0, `${key} height must stay 64-aligned`);
    assert.ok(fourth.width * fourth.height < 1500000, `${key} area must stay under the Anima 1.5M cap`);
    // Engine / checkpoint / LoRA / framing unchanged from the attempt-1 base.
    const base = plan.find(item => item.key === key && item.attempt === 1);
    assert.ok(base, `missing attempt-1 for ${key}`);
    assert.strictEqual(fourth.checkpoint, base.checkpoint, `${key} engine/checkpoint unchanged`);
    assert.strictEqual(fourth.loraId, base.loraId, `${key} LoRA selection unchanged`);
    assert.strictEqual(fourth.prompt.includes(fourth.engine === 'sd' ? 'full_body' : 'full body'), true, `${key} full-body framing token`);
    // Fresh seed vs every prior attempt for this key.
    const priorSeeds = plan.filter(item => item.key === key && item.attempt < 4).map(item => item.seed);
    assert.ok(priorSeeds.length >= 2, `${key} must have prior attempts to supersede`);
    assert.ok(!priorSeeds.includes(fourth.seed), `${key} seed must be fresh vs prior attempts (${priorSeeds.join(',')})`);
    assert.strictEqual(fourth.seed, (base.seed + (Number(override.seedOffset) || 0)) % 2147483647, `${key} seed offset`);
    // File names: attempt-4 written beside prior attempts, attempt-1 untouched.
    const engineKey = key.endsWith(':sd:fullbody') ? 'sd' : 'anima';
    assert.strictEqual(gen.imageRelFor(fourth), `images/latest-lora/latest-lora_natsume_${engineKey}_fullbody_attempt-4.png`, `${key} attempt-4 file name`);
    assert.strictEqual(gen.imageRelFor(base), `images/latest-lora/latest-lora_natsume_${engineKey}_fullbody.png`, `${key} attempt-1 file name must not change`);
  }

  const sd = plan.find(item => item.recordId === 'latest-lora:natsume:sd:fullbody@attempt-4');
  assert.strictEqual(sd.engine, 'sd');
  assert.ok(sd.prompt.includes('<lora:'), `${sd.key} WAI raw-tag / LoRA contract must be preserved`);
  assert.ok(sd.prompt.includes('shiki_natsume_v18_wd14'), `${sd.key} LoRA name must stay the production v18 id`);

  const anima = plan.find(item => item.recordId === 'latest-lora:natsume:anima:fullbody@attempt-4');
  assert.strictEqual(anima.engine, 'anima');
  assert.ok(anima.sampler === 'res_multistep' && anima.scheduler === 'simple', 'Anima sampler/scheduler contract');
  assert.ok(anima.prompt.includes('score_7'), 'Anima must keep the score_7 quality contract');
  assert.ok(!anima.prompt.includes('mole_under_right_eye'), 'Anima mole reinforcement must stay space-form');
  assert.ok(anima.negative.includes('mole under left eye'), 'Anima wrong-side negative must stay space-form');

  // Exactly the two attempt-4 records are planned.
  assert.deepStrictEqual(plan.filter(item => item.attempt === 4).map(item => item.recordId).sort(),
    expectedKeys.map(key => `${key}@attempt-4`).sort(), 'exactly the two attempt-4 records are planned');
});

test('CLI attempt filter: --attempt 3 selects only the six attempt-3 candidates', () => {
  const plan = gen.planAllBatches(20260812);
  const all3 = gen.filterPlanned(plan, { attempts: [3] });
  assert.strictEqual(all3.length, 6);
  assert.ok(all3.every((item: any) => item.attempt === 3));
  const keys = Object.keys(gen.ATTEMPT_3_OVERRIDES);
  const keysPlus3 = gen.filterPlanned(plan, { keys, attempts: [3] });
  assert.strictEqual(keysPlus3.length, 6);
  assert.deepStrictEqual(keysPlus3.map((item: any) => item.recordId).sort(), keys.map(key => `${key}@attempt-3`).sort());
  // --keys without --attempt still includes every attempt for those keys.
  const keysAll = gen.filterPlanned(plan, { keys: ['artist:so-bin', 'popular:makima'] });
  assert.strictEqual(keysAll.length, 4, 'so-bin/makima have attempt-1 + attempt-3 each');
  assert.ok(keysAll.some((item: any) => item.attempt === 1) && keysAll.some((item: any) => item.attempt === 3));
  const keysChain = gen.filterPlanned(plan, { keys: ['latest-lora:nene:sd:fullbody'] });
  assert.strictEqual(keysChain.length, 3, 'nene sd fullbody has attempt-1/2/3');
  // No attempt-1/2 is selected when --attempt 3 is applied.
  assert.ok(all3.every((item: any) => item.attempt === 3 && !item.supersedes.includes('attempt-3')));
  const empty = gen.filterPlanned(plan, {});
  assert.strictEqual(empty.length, plan.length, 'no filter returns the whole plan');
});

test('CLI attempt filter: --attempt 4 selects exactly the two attempt-4 candidates', () => {
  const plan = gen.planAllBatches(20260812);
  const all4 = gen.filterPlanned(plan, { attempts: [4] });
  assert.strictEqual(all4.length, 2);
  assert.ok(all4.every((item: any) => item.attempt === 4));
  const keys = Object.keys(gen.ATTEMPT_4_OVERRIDES);
  const keysPlus4 = gen.filterPlanned(plan, { keys, attempts: [4] });
  assert.strictEqual(keysPlus4.length, 2);
  assert.deepStrictEqual(keysPlus4.map((item: any) => item.recordId).sort(), keys.map(key => `${key}@attempt-4`).sort());
  // --keys without --attempt still includes every attempt for those keys.
  const animaChain = gen.filterPlanned(plan, { keys: ['latest-lora:natsume:anima:fullbody'] });
  assert.strictEqual(animaChain.length, 3, 'natsume anima fullbody has attempt-1/2/4');
  assert.deepStrictEqual(animaChain.map((item: any) => item.attempt).sort(), [1, 2, 4], 'anima fullbody chain = attempt-1/2/4');
  const sdChain = gen.filterPlanned(plan, { keys: ['latest-lora:natsume:sd:fullbody'] });
  assert.strictEqual(sdChain.length, 4, 'natsume sd fullbody has attempt-1/2/3/4');
  // A combined filter selects only attempt-4 records for the attempt-4 keys.
  const mixed = gen.filterPlanned(plan, { keys, attempts: [1, 4] });
  assert.strictEqual(mixed.length, 4, 'attempt-1 + attempt-4 for the two keys');
  assert.ok(mixed.every((item: any) => item.attempt === 1 || item.attempt === 4));
});

test('artist batch: curated artists + 1 no-artist baseline, one artist tag each', () => {
  const artistCount = artistCatalog.ARTIST_STYLE_OPTIONS.length;
  // 2026-09-05 审计 P2-01：目录是持续收录的活配置（官方画师拆分后 44 → 52），
  // 总数不再钉死当契约；改为验证目录完整性——id/WAI/Anima 三类标识各自唯一、
  // 字段齐全（逐项 tag 语法与嵌入由下方循环兜底），把"目录增长"与"目录损坏"区分开。
  assert.ok(artistCount > 0, `artist catalog must not be empty, got ${artistCount}`);
  assert.strictEqual(new Set(artistCatalog.ARTIST_STYLE_OPTIONS.map(o => o.id)).size, artistCount, 'artist ids must be unique');
  assert.strictEqual(new Set(artistCatalog.ARTIST_STYLE_OPTIONS.map(o => o.waiTag)).size, artistCount, 'artist WAI tags must be unique');
  assert.strictEqual(new Set(artistCatalog.ARTIST_STYLE_OPTIONS.map(o => o.animaTag)).size, artistCount, 'artist Anima tags must be unique');
  assert.ok(artistCatalog.ARTIST_STYLE_OPTIONS.every(o => o.id && o.waiTag && o.animaTag), 'every artist option must carry id/waiTag/animaTag');
  const artist = gen.artistBatch(20260812);
  assert.strictEqual(artist.length, artistCount + 1);
  const withTags = artist.filter(item => item.artistId);
  assert.strictEqual(withTags.length, artistCount);
  const baseline = artist.find(item => !item.artistId);
  assert.ok(baseline, 'must include a no-artist baseline');
  // 同 seed / 同 WAI 参数，仅画师 tag 不同。
  assert.ok(new Set(artist.map(item => item.seed)).size === 1, 'all artist variants share one seed');
  assert.ok(new Set(artist.map(item => `${item.steps}|${item.cfg}|${item.sampler}|${item.width}x${item.height}`)).size === 1, 'all artist variants share WAI params');
  const basePrompt = baseline.prompt;
  for (const item of withTags) {
    const option = artistCatalog.ARTIST_STYLE_OPTIONS.find(o => o.id === item.artistId);
    assert.ok(option, `unknown artist ${item.artistId}`);
    assert.ok(/^[a-z0-9_() -]+$/.test(option.waiTag), `WAI tag must be a safe canonical Danbooru tag: ${option.waiTag}`);
    assert.ok(/^@.+/.test(option.animaTag), `Anima tag must start with @: ${option.animaTag}`);
    assert.ok(item.prompt.includes(option.waiTag), `prompt must embed WAI tag ${option.waiTag}`);
    assert.strictEqual(item.prompt, `${basePrompt}, ${option.waiTag}`,
      'only the artist tag may differ between variants');
    // Anima tag syntax derived from the same catalog (space-form @artist).
    assert.deepStrictEqual(artistStyles.artistTagsForEngine([option.id], 'anima'), [option.animaTag]);
  }
  // Neutral subject must never leak studio LoRA anchors.
  for (const item of artist) {
    assert.ok(!/(ayachi_nene|shiki_natsume|nene_|natsume_)/i.test(item.prompt), `artist prompt leaked studio anchor: ${item.prompt}`);
  }
});

test(`popular batch covers all ${popularCount} characters with default outfit and safe blueprint`, () => {
  const characters = popularData.characters || popularData;
  assert.strictEqual(characters.length, popularCount);
  const popular = gen.popularBatch(20260812);
  assert.strictEqual(popular.length, popularCount);
  const ids = new Set(popular.map(item => item.subject));
  assert.strictEqual(ids.size, popularCount, `all ${popularCount} characters must be present`);
  for (const character of characters) {
    const item = popular.find(entry => entry.subject === character.id);
    assert.ok(item, `missing ${character.id}`);
    assert.strictEqual(item.engine, 'anima');
    assert.strictEqual(item.modelId, gen.constants.ANIMA_AESTHETIC_ID, 'popular goes through no-LoRA Anima Aesthetic');
    assert.strictEqual(item.loraId, '', 'popular must not load a character LoRA');
    // Anima carries a model-native negative (unlike Krea); the production
    // assembleNegative pipeline must supply the Aesthetic profile prefix.
    assert.ok(item.negative && item.negative.includes('artist name') && item.negative.includes('worst quality'),
      `${character.id} must carry the Anima Aesthetic negative contract`);
    assert.ok(item.negative.includes('chromatic aberration'), `${character.id} negative must include profile boilerplate`);
    assert.strictEqual(item.prompt, item.prompt.replace(/(ayachi_nene|shiki_natsume|nene_|natsume_)/gi, ''),
      `${character.id} prompt leaked studio LoRA anchor`);
    const defaultOutfit = character.outfits.find(outfit => outfit.default) || character.outfits[0];
    assert.strictEqual(item.outfitId, defaultOutfit.id, `${character.id} must use its default outfit`);
    if (character.adultEligibility !== 'adult') {
      assert.ok(!/(nsfw|nude|explicit)/i.test(item.prompt), `${character.id} non-adult character must stay safe`);
    }
    const scene = sceneBlueprints.find(blueprint => blueprint.id === item.sceneId);
    assert.ok(scene && !scene.adult && scene.sampleRating !== 'R18', `${character.id} default batch must skip adult records`);
    assert.strictEqual(scene.outfitId, defaultOutfit.id, `${character.id} scene must match the default outfit being rendered`);
    assert.ok(scene && scene.characterId === character.id,
      `${character.id} must use its own prototype scene, got ${item.sceneId}`);
  }
});

test('latest-lora batch: production ids/files/strength/checkpoint for SD v18 + Anima v21', () => {
  const lora = gen.latestLoraBatch(20260812);
  assert.strictEqual(lora.length, 8);
  const expected = new Map([
    ['latest-lora:nene:sd:closeup', ['L_NENE_V18_WD14', genConst.LORAS.L_NENE_V18_WD14.file, genConst.CHECKPOINT]],
    ['latest-lora:nene:sd:fullbody', ['L_NENE_V18_WD14', genConst.LORAS.L_NENE_V18_WD14.file, genConst.CHECKPOINT]],
    ['latest-lora:natsume:sd:closeup', ['L_NAT_V18_WD14', genConst.LORAS.L_NAT_V18_WD14.file, genConst.CHECKPOINT]],
    ['latest-lora:natsume:sd:fullbody', ['L_NAT_V18_WD14', genConst.LORAS.L_NAT_V18_WD14.file, genConst.CHECKPOINT]],
    ['latest-lora:nene:anima:closeup', ['L_NENE_V21_ANIMA', animaConst.LORAS.L_NENE_V21_ANIMA.file, animaConst.MODELS['anima-aesthetic-v1.1'].file]],
    ['latest-lora:nene:anima:fullbody', ['L_NENE_V21_ANIMA', animaConst.LORAS.L_NENE_V21_ANIMA.file, animaConst.MODELS['anima-aesthetic-v1.1'].file]],
    ['latest-lora:natsume:anima:closeup', ['L_NAT_V21_ANIMA', animaConst.LORAS.L_NAT_V21_ANIMA.file, animaConst.MODELS['anima-aesthetic-v1.1'].file]],
    ['latest-lora:natsume:anima:fullbody', ['L_NAT_V21_ANIMA', animaConst.LORAS.L_NAT_V21_ANIMA.file, animaConst.MODELS['anima-aesthetic-v1.1'].file]],
  ]);
  for (const item of lora) {
    const [loraId, file, checkpoint] = expected.get(item.key);
    assert.ok(expected.has(item.key), `unexpected key ${item.key}`);
    assert.strictEqual(item.loraId, loraId);
    assert.strictEqual(item.loraFile, file);
    assert.strictEqual(item.loraStrength, 0.85);
    assert.strictEqual(item.checkpoint, checkpoint);
    const meta = (loraData || []).find(entry => entry.id === loraId);
    assert.ok(meta, `loras.json must describe ${loraId}`);
    assert.strictEqual(meta.strength.default, 0.85, `${loraId} default strength must stay 0.85`);
    assert.ok(item.prompt.includes(item.engine === 'sd' ? `<lora:${meta.name}:0.85>` : 'ayachi_nene') || item.prompt.includes('shiki_natsume'),
      `${item.key} must embed its identity anchor`);
    if (item.engine === 'sd') {
      assert.ok(item.prompt.includes('<lora:'), `${item.key} SD prompt must carry the LoRA tag`);
    }
  }
});

test('studio char prompt constants mirror promptBuilderStore.ts (drift guard)', () => {
  const { STUDIO_CHAR_PROMPT } = gen.constants;
  const lines = studioStoreSource.split('\n').map(line => line.trim());
  for (const value of Object.values(STUDIO_CHAR_PROMPT)) {
    assert.ok(lines.some(line => line.includes(`'${value}'`)),
      `generation script char prompt drifted from the store: ${value}`);
  }
});

test('scene candidate audit can reuse an earlier attempt seed without overwriting its record', () => {
  const scene = (require('../../data/scenes.json') as typeof import('../../data/scenes.json')).find(item => item.id === 'sc001');
  const candidate = sceneGen.buildAnimaCandidate(scene, 5, 1);
  assert.strictEqual(candidate.recordId, 'scene:sc001@attempt-5');
  assert.strictEqual(candidate.seedAttempt, 1);
  assert.strictEqual(candidate.seed, sceneGen.stableSeed('sc001', 1));
});

test('single-character scene candidates use the audited short prompt and correct Anima binding', () => {
  const scenes: typeof import('../../data/scenes.json') = require('../../data/scenes.json');
  const singles = scenes.filter(item => item.char === 'nene' || item.char === 'natsume');
  const candidates: any = sceneGen.planScenes(singles, 1);
  // 既有生成健康检查逐条隔离「safe 提示词含显式词」的错标场景。
  // 2026-09-09 已按用户要求将明确成人源改正为 R18；下方仍构造错标副本
  // 验证拦截，不能为了让测试通过而要求生产数据继续保留错误评级。
  // 2026-08-28 修订：skip 判定权威在编译后 short prompt 的健康检查
  // （quality-prompt-contract 的 leak 检测），原始 tags 只是必要条件——部分显式 tag
  //（如 sc178 completely_naked）不进入 short prompt，故这里只断言
  // 「每次跳过都必须有显式词数据背书」，不再断言原始 tag 数与实际 skip 数相等。
  const EXPLICIT = (require('../maintenance/quality-prompt-contract.js') as typeof import('../maintenance/quality-prompt-contract.js')).EXPLICIT_ADULT_TOKENS;
  const explicitSusppects = new Set(singles.filter(item =>
    Array.isArray(item.tags) && item.tags.some(tag => EXPLICIT.has(tag))
    && String(item.rating || '').toUpperCase() !== 'R18' && item.mature !== true).map(item => item.id));
  // Explicit sources now carry R18 per the user's 2026-09-09 classification.
  // Exercise the leak guard with a deliberately incorrect rating instead of
  // requiring the production corpus to retain a known unsafe classification.
  for (const id of ['sc122', 'sc126', 'sc180', 'sc200']) {
    const source = singles.find(scene => scene.id === id);
    assert.strictEqual(source!.rating, 'R18', `${id} must retain its adult classification`);
    assert.strictEqual(source!.mature, true, `${id} must remain behind the mature boundary`);
  }
  const wronglyRated = { ...singles.find(scene => scene.id === 'sc122'), rating: 'All', mature: false };
  const rejected: any = sceneGen.planScenes([wronglyRated], 1);
  assert.strictEqual(rejected.length, 0, 'an explicit source mislabeled All must never be planned');
  assert.strictEqual(rejected.skipped.length, 1, 'the leak guard must report the rejected source');
  for (const item of candidates.skipped) {
    assert.ok(explicitSusppects.has(item.sceneId),
      `${item.sceneId} skipped without explicit-tag backing: ${item.reason}`);
    assert.ok(/含显式成人词/.test(item.reason),
      `${item.sceneId} skip reason must cite the explicit-token leak`);
  }
  assert.strictEqual(candidates.length, singles.length - candidates.skipped.length,
    `planned + skipped must cover all ${singles.length} singles`);
  assert.ok(candidates.skipped.every((item: any) => item.sceneId && item.reason),
    'skipped entries must carry scene id and reason');
  for (const candidate of candidates) {
    const tagLine = candidate.prompt.split('\n')[0];
    assert.strictEqual(candidate.engine, 'anima', `${candidate.sceneId} engine`);
    assert.strictEqual(candidate.promptHealth.ok, true,
      `${candidate.sceneId}: ${candidate.promptHealth.errors.join('; ')}`);
    assert.ok(candidate.promptHealth.tokenCount >= 22 && candidate.promptHealth.tokenCount <= 26,
      `${candidate.sceneId} token budget`);
    assert.ok(candidate.promptHealth.entityCount >= 2 && candidate.promptHealth.entityCount <= 4,
      `${candidate.sceneId} entity quota`);
    assert.ok(candidate.promptHealth.actionEmotionCount <= 2,
      `${candidate.sceneId} action/emotion quota`);
    assert.ok(tagLine.includes('masterpiece, best_quality, score_7'),
      `${candidate.sceneId} quality suffix`);
    assert.ok(tagLine.includes('@muririn, @kobuichi'),
      `${candidate.sceneId} house artist format`);
    const expectedRating = String(candidate.rating).toUpperCase() === 'R18' ? 'nsfw' : 'safe';
    assert.ok(tagLine.split(', ').includes(expectedRating), `${candidate.sceneId} rating token`);
    assert.ok(!(tagLine.includes(', safe') && tagLine.includes(', nsfw')),
      `${candidate.sceneId} safe/nsfw conflict`);
  }

  const nene = candidates.find(item => item.characterId === 'nene');
  assert.strictEqual(nene.loraId, 'L_NENE_V21_ANIMA');
  assert.strictEqual(nene.generationCharacter, 'nene');
  assert.strictEqual(sceneGen.buildSubmissionBody(nene).character, 'nene');

  const sc122Skipped = rejected.skipped.find((item: any) => item.sceneId === 'sc122');
  assert.ok(sc122Skipped, 'the deliberately misrated sc122 copy must be isolated');
  assert.ok(sc122Skipped.reason.includes('显式成人词'), `skip reason must explain: ${sc122Skipped.reason}`);

  const natsume = candidates.find(item => item.characterId === 'natsume');
  assert.strictEqual(natsume.loraId, 'L_NAT_V21_ANIMA');
  assert.strictEqual(natsume.generationCharacter, 'natsume');
  assert.strictEqual(sceneGen.buildSubmissionBody(natsume).character, 'natsume');
});

test('dual-character scene candidates keep the existing WAI dual-LoRA path', () => {
  const scenes: typeof import('../../data/scenes.json') = require('../../data/scenes.json');
  const dualScenes = scenes.filter(item => item.char === 'triad');
  const candidates = sceneGen.planScenes(dualScenes, 1);
  assert.strictEqual(candidates.length, 6);
  assert.ok(candidates.every(item => item.engine === 'sd'));
  assert.ok(candidates.every(item => item.characterId === 'triad'));
  assert.ok(candidates.every(item => item.loras.length === 2));
  assert.ok(candidates.every(item => item.prompt.includes('<lora:')));
});

test('scene candidate baseline mode changes only positive prompt direction', () => {
  const scene = (require('../../data/scenes.json') as typeof import('../../data/scenes.json')).find(item => item.id === 'sc001');
  const current = sceneGen.buildAnimaCandidate(scene, 5, 5);
  const baseline = {
    status: 'succeeded', recordId: 'scene:sc001@attempt-1', attempt: 1,
    engine: 'anima', profileId: 'old-profile', modelId: 'old-model', checkpoint: 'old-checkpoint',
    loraId: 'old-lora', loraFile: 'old-lora-file', loraStrength: 0.82,
    width: 832, height: 1216, steps: 24, cfg: 3.0, sampler: 'res_multistep', scheduler: 'simple',
    seed: 123, prompt: 'old exact tag stream', negative: 'old exact negative',
  };
  const compared = sceneGen.applyBaselineContract(current, baseline);
  const direction = current.prompt.split('\n').slice(1).join('\n').trim();
  assert.ok(compared.prompt.startsWith('old exact tag stream\n'));
  assert.ok(direction.length > 0, 'current scene must supply one short director caption');
  assert.strictEqual(compared.prompt, `old exact tag stream\n${direction}`);
  assert.ok(compared.prompt.includes(scene!.animaCaption));
  assert.strictEqual(compared.negative, baseline.negative);
  assert.strictEqual(compared.loraStrength, 0.82);
  assert.strictEqual(compared.seed, 123);
  assert.strictEqual(compared.baselineRecordId, baseline.recordId);
  assert.strictEqual(compared.comparison, 'prompt-direction-only');
});

test('scene baseline mode restores the baseline LoRA character binding', () => {
  const scene = (require('../../data/scenes.json') as typeof import('../../data/scenes.json')).find(item => item.id === 'sc001');
  const current = sceneGen.buildAnimaCandidate(scene, 5, 5);
  const baseline = {
    status: 'succeeded', recordId: 'scene:sc001@attempt-1', attempt: 1,
    engine: 'anima', profileId: 'anima_base_v10', modelId: 'anima-base-v1.0',
    checkpoint: animaConst.MODELS['anima-base-v1.0'].file,
    loraId: 'L_NENE_V21_ANIMA', loraFile: animaConst.LORAS.L_NENE_V21_ANIMA.file,
    loraStrength: 0.85, width: 832, height: 1216,
    steps: 24, cfg: 3, sampler: 'res_multistep', scheduler: 'simple',
    seed: 123, prompt: 'old exact tag stream', negative: 'old exact negative',
  };
  const compared = sceneGen.applyBaselineContract(current, baseline);
  assert.strictEqual(compared.characterId, 'nene');
  assert.strictEqual(compared.generationCharacter, 'nene');
  assert.strictEqual(sceneGen.buildSubmissionBody(compared).character, 'nene');
});

test('resume + atomic manifest behaviour', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-candidate-test-'));
  try {
    const image = path.join(root, 'ok.png');
    fs.writeFileSync(image, Buffer.alloc(2048, 7));
    const record = { status: 'succeeded', image: 'ok.png', key: 'artist:kantoku' };
    assert.strictEqual(gen.shouldReuse(record, image, false), true, 'valid succeeded image must be reusable');
    assert.strictEqual(gen.shouldReuse(record, image, true), false, '--force must regenerate');
    assert.strictEqual(gen.shouldReuse({ ...record, status: 'failed' }, image, false), false, 'failed records must not reuse');
    assert.strictEqual(gen.shouldReuse({ ...record, image: '' }, image, false), false, 'records without image must not reuse');
    fs.writeFileSync(image, Buffer.alloc(10));
    assert.strictEqual(gen.shouldReuse(record, image, false), false, 'tiny/empty files must not be reused');

    const manifestPath = path.join(root, 'generation-manifest.json');
    gen.writeJsonAtomic(manifestPath, [record]);
    assert.ok(fs.existsSync(manifestPath), 'manifest must exist after atomic write');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), [record]);
    const leftovers = fs.readdirSync(root).filter(name => name.endsWith('.tmp'));
    assert.deepStrictEqual(leftovers, [], 'no .tmp file may be left behind');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('refuses to write into the public SceneShowcase directory', () => {
  const showcase = path.resolve(path.join(__dirname, '..', '..', '..', 'AI', 'SceneShowcase'));
  const liveDir = path.join(showcase, '2026-07-22_v14');
  assert.throws(() => gen.assertNotShowcase(liveDir), /SceneShowcase/);
  assert.throws(() => gen.assertNotShowcase(showcase), /SceneShowcase/);
  assert.throws(() => gen.assertNotShowcase(path.join(liveDir, '..', '2026-07-22_v14', 'nested')), /SceneShowcase/);
  const safe = gen.assertNotShowcase(gen.constants.DEFAULT_OUTPUT);
  assert.strictEqual(safe, path.resolve(gen.constants.DEFAULT_OUTPUT), 'review output dir must be allowed');
});

test('mechanical image inspection: PNG/JPEG magic + dimensions', () => {
  const png = Buffer.from([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
    0, 0, 4, 0, 0, 0, 5, 32, 0, 0, 0, 0, 0, 0, 0,
  ]);
  const info = gen.imageInfo(png);
  assert.deepStrictEqual({ mime: info!.mime, width: info!.width, height: info!.height }, { mime: 'image/png', width: 1024, height: 1312 });
  assert.strictEqual(gen.imageInfo(Buffer.from([0, 1, 2, 3, 4])), null, 'garbage must not look like an image');
  assert.strictEqual(gen.imageInfo(Buffer.alloc(0)), null);
});
