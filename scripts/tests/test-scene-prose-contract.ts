'use strict';
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const test: typeof import('node:test') = require('node:test');
const { hasAtmosphericSceneProse }: typeof import('./scene-prose-contract') = require('./scene-prose-contract');
test('complete one-sentence scene retains authored dusk light without padding', () => {
  assert.equal(hasAtmosphericSceneProse('Sitting on the dormitory windowsill with her knees drawn up, Surtr looks across the wasteland at dusk, her expression distant and faintly annoyed as warm light catches her red hair.'), true);
});
test('rain and mist are concrete atmosphere, not mandatory artificial lights', () => {
  assert.equal(hasAtmosphericSceneProse('Under a covered veranda in a misty Jiangnan courtyard, Dusk leans against a vermilion carved pillar with one hand supporting her cheek, quietly watching rain strike broad banana leaves.'), true);
});
test('authored multi-sentence form remains accepted', () => {
  assert.equal(hasAtmosphericSceneProse('In the reading room she sits at a wooden table and studies a large botanical volume with a pencil in one hand. Rain glints on the window behind the quiet shelves.'), true);
});
test('two periods and repeated quality slogans do not establish authored prose', () => {
  assert.equal(hasAtmosphericSceneProse('Masterpiece best quality cinematic lighting detailed background depth of field. Very aesthetic highly detailed beautiful atmosphere clean face best quality.'), false);
});
test('generic lighting cannot replace the atmosphere of a single-sentence scene', () => {
  assert.equal(hasAtmosphericSceneProse('A character poses with a prop in a setting, with a clear subject and a suitable arrangement of objects, cinematic lighting, detailed background and depth of field.'), false);
});
test('truncated clauses and absent prose are rejected', () => {
  assert.equal(hasAtmosphericSceneProse('In a quiet room at dusk she stands beside a wooden table with an open sketchbook and a pencil, as warm light crosses the floor and'), false);
  for (const value of ['', null, undefined, 12, 'She smiles. Warm light.']) assert.equal(hasAtmosphericSceneProse(value), false);
});
