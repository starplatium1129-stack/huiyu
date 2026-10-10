'use strict';
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const test: typeof import('node:test') = require('node:test');
const popular: typeof import('../../src/utils/popularContent.ts') = require('../../src/utils/popularContent.ts');
const popularPrompt: typeof import('../../src/utils/popularPromptBuilder.ts') = require('../../src/utils/popularPromptBuilder.ts');
const repairs: typeof import('./fixtures/scene-coverage-repairs.json') = require('./fixtures/scene-coverage-repairs.json');
const ROOT = path.resolve(__dirname, '..', '..');
function readData(file: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'data', file), 'utf8'));
}
const characters = popular.parsePopularCharacters(readData('popular-characters.json'));
const blueprints = popular.parseSceneBlueprints(readData('scene-blueprints.json'));
const profiles: any[] = (require('../../data/presets.json') as typeof import('../../data/presets.json')).model_profiles;
// The catalog may retain unused or adult-only outfits. Creation needs selectable
// SFW scenes; it does not require inventing a scene for the wardrobe default.
test('all characters have an owned SFW choice with adult access disabled', () => {
  const missing = characters.filter(c => popular.eligibleBlueprints(blueprints, c, { adultEnabled:false }).length === 0);
  assert.deepEqual(missing.map(c => c.id), []);
});
test('all authored blueprint bindings are checked against their owner wardrobe', () => {
  const missing = blueprints.flatMap(b => {
    const c = characters.find(c => c.id === b.characterId);
    if (!c) return [b.id + ': unknown character ' + b.characterId];
    const outfitId = b.outfitId ?? popular.defaultOutfit(c).id;
    if (!popular.findOutfit(c, outfitId)) return [b.id + ': unknown outfit ' + c.id + '/' + outfitId];
    return [];
  });
  assert.deepEqual(missing, []);
});
test('eleven authored coverage additions preserve exact binding and compile in both engines', () => {
  assert.equal(repairs.additions.length, 11);
  assert.equal(new Set(repairs.additions.map(x => x.id)).size, 11);
  // This historical repair batch must survive later additions to the library.
  for (const entry of repairs.additions) {
    const c = characters.find(x => x.id === entry.characterId)!;
    const matches = blueprints.filter(x => x.id === entry.id);
    assert.equal(matches.length, 1, entry.id + ' must exist exactly once');
    const b = matches[0];
    assert.equal(b.characterId, c!.id);
    assert.equal(b.outfitId, entry.outfitId);
    assert.equal(b.adult, false);
    assert.equal(b.sampleRating, 'All');
    assert.ok(b.promptProse.trim(), entry.id + ' must have nonempty authored prose');
    const outfit = popular.findOutfit(c, entry.outfitId);
    assert.ok(outfit);
    for (const engine of ['anima', 'krea2']) {
      const model = engine === 'anima' ? 'anima-miaomiao-v1.2' : 'krea2-turbo-fp8';
      const profile = profiles.find(p => p.model_id === model);
      assert.ok(profile, model);
      const plan = popularPrompt.buildPopularPromptPlan({ character: c, blueprint: b, outfit, engine: engine as any, profile, adultEnabled: false });
      assert.ok(plan, entry.id + ':' + engine);
      assert.equal(plan.adult, false);
      assert.ok(plan.prompt.includes(b.promptProse.split('.')[0]), entry.id);
      assert.ok(!/\bnsfw\b|\bnude\b|\blingerie\b/i.test(plan.prompt), entry.id);
      if (engine === 'krea2') assert.equal(plan.negative, '');
    }
  }
});
test('season and festival stay with their scenes and do not pollute reusable outfits', () => {
  for (const { cid, oid, bid, token, sceneMeaning } of [
    { cid: 'krista_lenz', oid: 'coronation_winter_wall', bid: 'krista_lenz_snowy_wall', token: 'winter', sceneMeaning: /\bsnow(?:y|field|fall|covered)?\b/i },
    { cid: 'murasame', oid: 'festival_red_yukata_no_fan', bid: 'murasame_festival_goldfish_scooping_joy', token: 'festival', sceneMeaning: /\bfestival\b/i },
  ]) {
    const c = characters.find(x => x.id === cid);
    assert.ok(c);
    assert.ok(!popular.findOutfit!(c, oid)!.tokens.includes(token));
    // Prose is model input; sceneTags alone would only prove retrieval metadata.
    const b = blueprints.find(b => b.id === bid);
    assert.ok(b);
    assert.match(b.promptProse, sceneMeaning, bid);
    assert.deepEqual(popularPrompt.scanCharacterPollution(c), []);
  }
});

test('authored fan reaches the fireworks model payload, not reusable clothes or the fishing variant', () => {
  const c = characters.find(x => x.id === 'murasame');
  assert.ok(c);
  const outfit = popular.findOutfit(c, 'summer_yukata');
  assert.ok(outfit);
  assert.doesNotMatch(outfit.tokens.join(' ') + ' ' + outfit.prose, /\b(?:uchiwa|(?:paper|round|folding)[ _]fan|holding[ _]fan)\b/i);
  const fishing = blueprints.find(b => b.id === 'murasame_festival_goldfish_scooping_joy');
  assert.ok(fishing);
  assert.equal(fishing.outfitId, 'festival_red_yukata_no_fan');
  const b = blueprints.find(item => item.id === 'murasame_hoori_fireworks_fan_pause')!;
  assert.ok(b);
  assert.equal(b.outfitId, outfit.id);
  const missing: string[] = [];
  for (const engine of ['anima', 'krea2'] as const) {
    const model = engine === 'anima' ? 'anima-miaomiao-v1.6' : 'krea2-turbo-fp8';
    const profile = profiles.find(item => item.model_id === model);
    const plan = popularPrompt.buildPopularPromptPlan({ character:c, blueprint:b, outfit, engine, profile, adultEnabled:false });
    assert.ok(plan);
    assert.doesNotMatch(plan.prompt, /\bfolding[ _]fan\b/i);
    // Current authored input asks for a paper fan. Keep the prop in the model
    // payload without imposing the previous revision's round-shape wording.
    if (!/\b(?:uchiwa|fan)\b/i.test(plan.prompt)) missing.push(engine);
  }
  assert.deepEqual(missing, [], b.id + ' must send its authored fan to the model; sceneTags do not count');
});

// Explicit depth-of-field prose preservation now uses a neutral input in
// src/utils/promptCompiler.spec.ts; Ellen's current scene does not request it.
