'use strict';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { test }: typeof import('node:test') = require('node:test');

const generationContract: typeof import('../../server/anima-generation-contract.js') = require('../../server/anima-generation-contract.js');
const promptContract: typeof import('../maintenance/quality-prompt-contract.js') = require('../maintenance/quality-prompt-contract.js');
const shortBuilder: typeof import('../maintenance/short-prompt-builder.js') = require('../maintenance/short-prompt-builder.js');
const sceneFix: typeof import('../maintenance/scene-fix.js') = require('../maintenance/scene-fix.js');
const anima: typeof import('../../routes/anima.js') = require('../../routes/anima.js');
const scenes: typeof import('../../data/scenes.json') = require('../../data/scenes.json');

const VALID_NENE_PROMPT = [
  'ayachi_nene', '1girl', 'solo', 'white_hair', 'very_long_hair',
  'low_twintails', 'purple_eyes', 'ahoge', 'pink_hair_ribbons',
  'nene_school_uniform', 'blazer', 'yellow_bowtie', 'plaid_skirt',
  'classroom', 'classroom_window', 'holding_papers', 'shy',
  'nene_r18', 'safe', '@muririn', '@kobuichi',
  'window_light', 'rim_light', 'masterpiece', 'best_quality', 'score_7',
].join(', ');

test('shared Anima defaults and parameter whitelist stay aligned with the route', () => {
  const routeContract = anima.constants.generationContract;
  assert.strictEqual(routeContract, generationContract);
  assert.deepStrictEqual(generationContract.ANIMA_DEFAULTS, {
    steps: 30, cfg: 4.5, sampler: 'res_multistep', scheduler: 'simple',
  });
  assert.deepStrictEqual(generationContract.MANUAL_REPAIR_PRESET, {
    steps: 30, cfg: 4.5, sampler: 'res_multistep', scheduler: 'simple',
  });
  assert.ok(generationContract.ALLOWED_INPUT_KEYS.includes('steps'));
  assert.ok(!generationContract.ALLOWED_INPUT_KEYS.includes('sampler'));
  assert.strictEqual(anima.constants.MODELS['anima-base-v1.0'].steps, 30);
  assert.strictEqual(anima.constants.MODELS['anima-base-v1.0'].cfg, 4.5);
});

test('V21 always resolves to nene and scene repair defaults to the v21 binding', () => {
  assert.strictEqual(
    generationContract.requiredCharacterForLora('L_NENE_V21_ANIMA'),
    'nene',
  );
  const config = sceneFix.resolveRepairConfig('nene');
  assert.deepStrictEqual(config, {
    modelId: 'anima-aesthetic-v1.1',
    loraId: 'L_NENE_V21_ANIMA',
    loraStrength: 0.85,
    character: 'nene',
  });
  assert.throws(
    () => sceneFix.resolveRepairConfig('nene', {
      loraId: 'L_NAT_V21_ANIMA',
      character: 'natsume',
    }),
    /nene/,
  );
});

test('scene repair uses exactly three deterministic seeds and explicit 30/4.5', () => {
  assert.strictEqual(sceneFix.SEED_COUNT, 3);
  assert.deepStrictEqual(sceneFix.buildSeeds(0), [20260809, 20261806, 20262803]);
  assert.deepStrictEqual(sceneFix.buildSeeds(2), [20262803, 20263800, 20264797]);
  assert.strictEqual(sceneFix.manualParameterValue('30', 'steps'), 30);
  assert.strictEqual(sceneFix.manualParameterValue('4.5', 'cfg'), 4.5);
  assert.throws(() => sceneFix.manualParameterValue('', 'steps'), /显式传/);
  assert.throws(() => sceneFix.manualParameterValue('24', 'steps'), /固定为 30/);
  assert.throws(() => sceneFix.manualParameterValue('3', 'cfg'), /固定为 4.5/);
});

test('short prompt health enforces anchors, quotas, artists, rating and quality tokens', () => {
  const valid = promptContract.inspectShortPrompt(VALID_NENE_PROMPT, {
    character: 'nene',
    rating: 'ALL',
  });
  assert.strictEqual(valid.ok, true, valid.errors.join('; '));
  assert.strictEqual(valid.entityCount, 2);
  assert.strictEqual(valid.actionEmotionCount, 2);
  assert.deepStrictEqual(valid.artists, ['@muririn', '@kobuichi']);

  const missingArtist = promptContract.inspectShortPrompt(
    VALID_NENE_PROMPT.replace(', @kobuichi', ''),
    { character: 'nene', rating: 'ALL' },
  );
  assert.strictEqual(missingArtist.ok, false);
  assert.ok(missingArtist.errors.some(message => message.includes('@kobuichi')));

  const adultLeak = promptContract.inspectShortPrompt(
    VALID_NENE_PROMPT + ', nude',
    { character: 'nene', rating: 'ALL' },
  );
  assert.strictEqual(adultLeak.ok, false);
  assert.ok(adultLeak.errors.some(message => message.includes('成人词')));
});

test('short prompt builder reproduces the sc300 contract without safe/nsfw contradiction', () => {
  const scene = scenes.find(item => item.id === 'sc300');
  const built = shortBuilder.buildShortPrompt(scene, 'nene');
  assert.strictEqual(built.health.ok, true, built.health.errors.join('; '));
  assert.ok(built.prompt.includes('nene_witch_canonical'));
  assert.ok(built.prompt.includes('wooden_bar_counter'));
  // 2026-08-16 审计：sc300（暖金咖啡馆的魔女休息日）已被评级归类为 R15——评级
  // token 是 safe 而不是 nsfw；`nene_r18` 是服装/主题 token，与评级无关，保留。
  assert.ok(built.prompt.includes('nene_r18'));
  assert.ok(built.prompt.includes('safe'));
  assert.ok(!built.prompt.includes('nsfw'), '非成人场景不得出现 nsfw');
  assert.ok(built.prompt.includes('@muririn, @kobuichi'));
});

test('review selection stays incomplete for blank scores and requires all three totals >= 90', () => {
  const seeds = sceneFix.buildSeeds();
  const blank = promptContract.buildSeedReview(seeds);
  assert.deepStrictEqual(promptContract.evaluateSeedReview(blank, seeds), {
    complete: false,
    qualified: false,
    threshold: 90,
    candidates: seeds.map(seed => ({ seed, complete: false, total: null, notes: '' })),
    selectedSeed: null,
  });

  const reviewed = promptContract.buildSeedReview(seeds);
  const scoreRows = [
    [18, 18, 18, 18, 18],
    [20, 19, 19, 19, 19],
    [18, 18, 18, 18, 17],
  ];
  reviewed.candidates.forEach((candidate, index) => {
    candidate.scores = {
      lighting: scoreRows[index][0],
      background: scoreRows[index][1],
      character: scoreRows[index][2],
      atmosphere: scoreRows[index][3],
      finish: scoreRows[index][4],
    };
  });
  const failed = promptContract.evaluateSeedReview(reviewed, seeds);
  assert.strictEqual(failed.complete, true);
  assert.strictEqual(failed.qualified, false);
  assert.strictEqual(failed.selectedSeed, null);

  reviewed.candidates[2].scores.finish += 1;
  const passed = promptContract.evaluateSeedReview(reviewed, seeds);
  assert.strictEqual(passed.qualified, true);
  assert.strictEqual(passed.selectedSeed, seeds[1]);
});

test('scene-fix writes selection only after the complete three-seed review passes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-scene-fix-review-'));
  const seeds = sceneFix.buildSeeds();
  try {
    const files = sceneFix.ensureReviewTemplate(root, seeds);
    assert.ok(fs.existsSync(files.review));
    let evaluation = sceneFix.evaluateReview(root, seeds);
    assert.strictEqual(evaluation.qualified, false);
    assert.strictEqual(fs.existsSync(files.selection), false);

    const review = JSON.parse(fs.readFileSync(files.review, 'utf8'));
    review.candidates.forEach(candidate => {
      candidate.scores = {
        lighting: 19,
        background: 18,
        character: 19,
        atmosphere: 18,
        finish: 18,
      };
    });
    fs.writeFileSync(files.review, `${JSON.stringify(review, null, 2)}\n`, 'utf8');
    evaluation = sceneFix.evaluateReview(root, seeds);
    assert.strictEqual(evaluation.qualified, true);
    assert.ok(fs.existsSync(files.selection));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
