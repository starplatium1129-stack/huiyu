'use strict';

const assert: typeof import('assert') = require('assert');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { test }: typeof import('node:test') = require('node:test');

test("LoRA catalog tests passed: production fields, weights, triggers, and typed cards", () => {
const { parseLoraCatalog, formatLoraWeight }: typeof import('../../src/utils/loraCatalog.ts') = require('../../src/utils/loraCatalog.ts');

const root = path.resolve(__dirname, '..', '..');
const catalog = parseLoraCatalog(JSON.parse(
  fs.readFileSync(path.join(root, 'data', 'loras.json'), 'utf8')
));
assert.strictEqual(catalog.length, 4, 'LoRA catalog must expose SD v18 pair plus the promoted Natsume/Nene Anima v21 unified pair');
assert(catalog.some(entry => entry.id === 'L_NENE_V18_WD14'), 'Nene SD v18 LoRA must be registered');
assert(catalog.some(entry => entry.id === 'L_NAT_V18_WD14'), 'Natsume SD v18 LoRA must be registered');
assert(catalog.some(entry => entry.id === 'L_NENE_V21_ANIMA' && !entry.experimental), 'Nene unified v21 Anima LoRA must be registered and not experimental');
assert(catalog.some(entry => entry.id === 'L_NAT_V21_ANIMA' && !entry.experimental), 'Natsume unified v21 Anima LoRA must be registered and not experimental');
assert(!catalog.some(entry => /_V20|V19|V18_ANIMA/.test(entry.id)), 'superseded v19/v20 Anima LoRAs must not remain in the catalog');
assert(catalog.every(entry => entry.baseModel), 'current base_model fields must reach the model shelf');
assert(catalog.every(entry => entry.character), 'current character fields must reach the model shelf');
assert(catalog.every(entry => entry.triggerWords.length), 'legacy trigger fields must normalize to trigger words');
assert.strictEqual(
  formatLoraWeight({ portrait:0.8, fullbody:0.75 }),
  'portrait: 80% / fullbody: 75%',
  'recommended weight maps must render stable percentages',
);
assert.deepStrictEqual(
  parseLoraCatalog([
    { id:'one', name:'valid', trigger_words:['tag', 3] },
    { id:'one', name:'duplicate' },
    { id:'', name:'invalid' },
    null,
  ]),
  [{
    id:'one',
    name:'valid',
    version:'',
    description:'',
    recommendedWeight:undefined,
    baseModel:'',
    character:'',
    triggerWords:['tag'],
  }],
  'malformed and duplicate LoRA records must be discarded',
);

for (const relative of ['src/views/LoraView.vue', 'src/components/SceneCard.vue']) {
  const source = fs.readFileSync(path.join(root, relative), 'utf8');
  assert(!/\bany\b/.test(source), relative + ' must stay explicitly typed');
}

});
