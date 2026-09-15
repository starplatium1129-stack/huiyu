const assert: typeof import('assert') = require('assert');
const quick: typeof import('../../src/utils/quickCreate.ts') = require('../../src/utils/quickCreate.ts');

const { test }: typeof import('node:test') = require('node:test');

test("Quick create tests passed against the production TypeScript module", () => {
const memory = new Map();
const storage = { getItem:(key: any) => memory.has(key) ? memory.get(key) : null, setItem:(key: any, value: any) => memory.set(key, value) };
const saved = quick.writeQuickCreate({
  savedAt:Date.UTC(2026, 6, 22),
  checkpoint:'models/anime-v1.safetensors',
  sampler:'DPM++ 2M',
  scheduler:'Karras',
  cfg:'5.5',
  steps:'28',
  size:'832x1216',
  hiresFix:true,
  hiresUpscaler:'Latent',
  hiresScale:'1.5'
}, storage);

assert(saved, 'successful settings must be writable');
assert.strictEqual(saved.size, '832×1216', 'size must use the UI separator');
assert.strictEqual(saved.checkpoint, 'models/anime-v1.safetensors');
assert.strictEqual(saved.seed, undefined, 'quick settings must not persist a generation seed');
assert.deepStrictEqual(quick.readQuickCreate(storage), saved, 'stored settings must round-trip');
assert(quick.quickCreateSummary(saved).includes('anime-v1') && quick.quickCreateSummary(saved).includes('28 steps'), 'summary must expose the important reused parameters');
assert.strictEqual(quick.quickCreateUrl('sc 002'), '/prompt-builder?scene=sc%20002&quick=1', 'quick URL must encode scene ids');
assert.strictEqual(quick.normalizeQuickCreate({}), null, 'empty settings must not be considered successful');

});
