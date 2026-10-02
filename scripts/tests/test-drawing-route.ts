'use strict';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { test }: typeof import('node:test') = require('node:test');
const {
  recommendDrawingRoute,
}: typeof import('../../src/utils/drawingRoute.ts') = require('../../src/utils/drawingRoute.ts');

test('studio single-character routes prefer validated Anima LoRAs', () => {
  // Current defaults must keep studio identity bindings while changing the base model.
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
      modelId: 'anima-miaomiao-v1.6',
      loraId: 'L_NENE_V21_ANIMA',
      generationCharacter: 'nene',
      promptFormat: 'anima-tags',
    },
  );

  const natsume = recommendDrawingRoute({ subjectKind: 'studio', character: 'natsume' });
  assert.strictEqual(natsume.loraId, 'L_NAT_V21_ANIMA');
  assert.strictEqual(natsume.generationCharacter, 'natsume');
  assert.strictEqual(natsume.modelId, 'anima-miaomiao-v1.6');
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
  assert.strictEqual(anima.modelId, 'anima-miaomiao-v1.6');
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
  assert.strictEqual(krea.id, 'popular-krea-detail');
  assert.strictEqual(krea.modelId, 'krea2-turbo-fp8');
});
