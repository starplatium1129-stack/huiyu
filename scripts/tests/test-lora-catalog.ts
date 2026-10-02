'use strict';

const assert: typeof import('assert') = require('assert');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { test }: typeof import('node:test') = require('node:test');

test("LoRA catalog preserves display fields and normalizes malformed records", () => {
const { parseLoraCatalog, formatLoraWeight }: typeof import('../../src/utils/loraCatalog.ts') = require('../../src/utils/loraCatalog.ts');

const root = path.resolve(__dirname, '..', '..');
const catalog = parseLoraCatalog(JSON.parse(
  fs.readFileSync(path.join(root, 'data', 'loras.json'), 'utf8')
));
assert(catalog.length > 0, 'the production catalog must contain displayable records');
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

});
