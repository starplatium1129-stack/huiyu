'use strict';
const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { renderedScene }: typeof import('../lib/scene-render-contract') = require('../lib/scene-render-contract');
const { framingConflicts, scenePositiveKeys }: typeof import('../lib/prompt-policy') = require('../lib/prompt-policy');

test('scene gates inspect production negative assembly and exclude search-only tags', () => {
  const scene = { char: 'nene', rating: 'All', camera: '半身中景', prompt: '1girl, ayachi_nene, white dress', negative: 'winter coat', tags: ['winter_coat', 'full_body'] };
  const effective = renderedScene(scene);
  assert.equal(scenePositiveKeys(effective).has('winter_coat'), false);
  for (const word of ['text', 'watermark', 'signature', 'nsfw']) assert.ok(effective.negative.includes(word));
  assert.equal(scene.negative, 'winter coat', 'validation never edits persisted content');
});

test('POV close framing removes full body while unspecified framing remains an error', () => {
  const scene = { char: 'nene', rating: 'All', prompt: '1girl, ayachi_nene, close-up, full_body, holding a teacup', negative: '', camera: '主观水平视线特写' };
  const effective = renderedScene(scene);
  assert.deepEqual(framingConflicts(effective), []);
  assert.match(effective.prompt, /close/);
  assert.doesNotMatch(effective.prompt, /full_body|full body/);
  assert.ok(framingConflicts(renderedScene({ ...scene, camera: '未指定', tags: [] })).length > 0);
});
