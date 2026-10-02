// Persistence boundaries are exercised directly; implementation/file-layout
// markers are covered by type checking, domain boundaries and actual workspace tests.
import assert = require('node:assert/strict');
import { test } from 'node:test';
import persistence = require('../../src/utils/promptBuilderPersistence.ts');

test('prompt persistence normalizes drafts, catalogs and restored scene stories', () => {
// Guard real catalog defaults: implicit hires adds a costly second pass that
// users cannot see in the default generation form.
const presets: typeof import('../../data/presets.json') = require('../../data/presets.json');
assert(presets.model_profiles.length > 0, 'generation profiles must be configured');
assert(!presets.model_profiles.some(profile => profile.hires_fix === true),
  'model profiles must not silently enable a second generation pass by default');
const parsedDraft = persistence.parsePromptBuilderDraft({
  updatedAt:'123',
  story:'雨夜',
  char:'invalid',
  selections:{ emotion:['shy', 7], shot:'close' },
  sdParams:{ cfg:'5.5', steps:'bad', hiresFix:true, injected:'no' },
});
assert(parsedDraft, 'valid draft must survive persistence parsing');
assert.strictEqual(parsedDraft.char, undefined, 'unknown character ids must not enter director state');
assert.deepStrictEqual(parsedDraft.selections!.emotion, ['shy'], 'draft selections must keep only string ids');
assert.deepStrictEqual(parsedDraft.sdParams, { cfg:5.5, hiresFix:true }, 'draft SD params must whitelist known typed fields');
assert.strictEqual(
  persistence.parsePromptBuilderDraft({ updatedAt:1, story:'', sceneId:null }),
  null,
  'empty drafts must not replace current director state',
);
assert.strictEqual(
  persistence.parsePromptBuilderDraft({ updatedAt:1, story:'', sceneId:null, visualDescription:'A red umbrella.' })!.visualDescription,
  'A red umbrella.',
  'visual-description-only drafts are valid creative input and must survive reload',
);
assert.deepStrictEqual(
  persistence.parseProjectOptions([{ id:7, title:'旧项目' }, null, { id:'' }]),
  [{ id:'7', name:'旧项目' }],
  'legacy project ids and titles must normalize at the persistence boundary',
);
const parsedCatalog = persistence.parsePresetCatalog({
  presets:[{ id:'balanced', name:'平衡' }, { name:'missing id' }],
  model_profiles:[{ id:'wai', match:['wai', 3], steps:'28', cfg:5.5 }, null],
});
assert.strictEqual(parsedCatalog.presets.length, 1, 'malformed presets must be ignored');
assert.deepStrictEqual(parsedCatalog.modelProfiles[0].match, ['wai'], 'profile match keys must be strings');
assert.strictEqual(parsedCatalog.modelProfiles[0].steps, 28, 'numeric profile fields must normalize');
const parsedAnima = persistence.parsePresetCatalog({
  model_profiles:[{
    id:'anima_base', engine:'anima', model_id:'anima-base-v1.0', tag_style:'space',
    lora_in_prompt:false, lora_strength:'0.85', exact_tokens:['ayachi_nene', 'nene_school_uniform'], match:['anima-base-v1.0', 7],
  }],
}).modelProfiles[0];
assert.strictEqual(parsedAnima.engine, 'anima', 'Anima profile engine must survive persistence parsing');
assert.strictEqual(parsedAnima.tag_style, 'space', 'Anima tag style must survive persistence parsing');
assert.strictEqual(parsedAnima.lora_in_prompt, false, 'Anima must not inject A1111 LoRA syntax');
assert.strictEqual(parsedAnima.lora_strength, 0.85, 'Anima LoRA strength must normalize as a number');
assert.deepStrictEqual(parsedAnima.exact_tokens, ['ayachi_nene', 'nene_school_uniform'], 'v19 exact token list must survive persistence parsing');
const parsedWai = persistence.parsePresetCatalog({
  model_profiles:[{ id:'wai', engine:'sd', hires_fix:true, hires_scale:1.5, hires_steps:20, hires_denoising_strength:0.4 }],
}).modelProfiles[0];
assert.strictEqual(parsedWai.hires_fix, true, 'WAI automatic hires flag must survive persistence parsing');
assert.strictEqual(parsedWai.hires_denoising_strength, 0.4, 'WAI hires denoise must survive persistence parsing');
const restoredContext = persistence.restoreHistorySceneStory(
  { scene:'scene-cafe', story:'用户自定义：宁宁在雨后收起伞。' },
  [{ id:'scene-cafe', title:'咖啡馆' }],
);
assert.strictEqual(restoredContext.scene!.id, 'scene-cafe', 'history round-trip must resolve the saved scene');
assert.strictEqual(restoredContext.story, '用户自定义：宁宁在雨后收起伞。', 'history round-trip must preserve custom story text');
assert.deepStrictEqual(parsedAnima.match, ['anima-base-v1.0'], 'profile match list must remain string-only');
});
