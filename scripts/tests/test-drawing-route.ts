'use strict';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { test }: typeof import('node:test') = require('node:test');
const {
  promptFormatLabel,
  recommendDrawingRoute,
}: typeof import('../../src/utils/drawingRoute.ts') = require('../../src/utils/drawingRoute.ts');

test('studio single-character routes prefer validated Anima LoRAs', () => {
  // 2026-09-05 审计 P2-01：默认底模已随 d6ded591 迁至 MiaoMiao Harem v1.2，
  // 期望值同步生产契约（此前仍钉在 anima-aesthetic-v1.1 旧值）。
  const nene = recommendDrawingRoute({ subjectKind: 'studio', character: 'nene' });
  assert.deepStrictEqual(
    {
      engine: nene.engine,
      modelId: nene.modelId,
      loraId: nene.loraId,
      generationCharacter: nene.generationCharacter,
      promptFormat: nene.promptFormat,
    },
    {
      engine: 'anima',
      modelId: 'anima-miaomiao-v1.2',
      loraId: 'L_NENE_V21_ANIMA',
      generationCharacter: 'nene',
      promptFormat: 'anima-tags',
    },
  );

  const natsume = recommendDrawingRoute({ subjectKind: 'studio', character: 'natsume' });
  assert.strictEqual(natsume.loraId, 'L_NAT_V21_ANIMA');
  assert.strictEqual(natsume.generationCharacter, 'natsume');
  assert.strictEqual(natsume.modelId, 'anima-miaomiao-v1.2');
});

test('studio dual-character route remains on the proven SD dual-LoRA path', () => {
  const route = recommendDrawingRoute({ subjectKind: 'studio', character: 'triad' });
  assert.strictEqual(route.engine, 'sd');
  assert.strictEqual(route.modelId, 'waiIllustriousSDXL_v170');
  assert.strictEqual(route.promptFormat, 'danbooru');
  assert.strictEqual(route.experimental, false);
});

test('popular routes follow model recommendations without studio LoRAs', () => {
  const anima = recommendDrawingRoute({
    subjectKind: 'popular',
    character: 'nene',
    recommendedModelId: 'anima-aesthetic-v1.1',
  });
  assert.strictEqual(anima.engine, 'anima');
  assert.strictEqual(anima.loraId, '');
  assert.strictEqual(anima.generationCharacter, null);

  const krea = recommendDrawingRoute({
    subjectKind: 'popular',
    character: 'nene',
    recommendedModelId: 'krea2-turbo-fp8',
  });
  assert.strictEqual(krea.engine, 'krea2');
  assert.strictEqual(krea.promptFormat, 'natural-language');
  assert.strictEqual(krea.experimental, true);
});

test('popular krea recommendations lock in the community-enhanced pipeline', () => {
  // 2026-08-23 链路替换：原 euler 标准 Krea 路线退役，推荐即社区增强链路（T-Enhancer
  // 细节补丁 + RCAS 锐化），不再有 preferDetailBoost 二选一开关。
  const krea = recommendDrawingRoute({
    subjectKind: 'popular',
    character: 'nene',
    recommendedModelId: 'krea2-turbo-fp8',
  });
  assert.strictEqual(krea.id, 'popular-krea-detail');
  assert.strictEqual(krea.engine, 'krea2');
  assert.strictEqual(krea.modelId, 'krea2-turbo-fp8');
  assert.strictEqual(krea.promptFormat, 'natural-language');
  assert.strictEqual(krea.experimental, true);
  assert.ok(krea.reasons.some(reason => reason.includes('Krea2T-Enhancer')));
  assert.ok(krea.reasons.some(reason => reason.includes('RCAS')));
});

test('prompt format labels explain model contracts instead of exposing syntax switches', () => {
  assert.strictEqual(promptFormatLabel('danbooru'), 'Danbooru 标签');
  assert.strictEqual(promptFormatLabel('anima-tags'), 'Anima 模型原生标签');
  assert.strictEqual(promptFormatLabel('natural-language'), '自然语言画面描述');
});
