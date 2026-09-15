'use strict';
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const test: typeof import('node:test') = require('node:test');
const popular: typeof import('../../src/utils/popularContent.ts') = require('../../src/utils/popularContent.ts');
const repairs: typeof import('./fixtures/scene-coverage-repairs.json') = require('./fixtures/scene-coverage-repairs.json');
const characters = popular.parsePopularCharacters((require('../../data/popular-characters.json') as typeof import('../../data/popular-characters.json')));
const blueprints = popular.parseSceneBlueprints((require('../../data/scene-blueprints.json') as typeof import('../../data/scene-blueprints.json')));
const profiles = (require('../../data/presets.json') as typeof import('../../data/presets.json')).model_profiles;
test('all characters have an owned SFW blueprint for their exact default outfit', () => {
  const missing = characters.filter(c => !blueprints.some(b => b.characterId === c.id && !b.adult && b.outfitId === popular.defaultOutfit(c).id));
  assert.deepEqual(missing.map(c => c.id), []);
});
test('all wardrobe coverage gaps are reported together, not masked by the first character', () => {
  const missing = characters.flatMap(c => c.outfits.filter(o => !blueprints.some(b => b.characterId === c.id && b.outfitId === o.id)).map(o => c.id + '/' + o.id));
  assert.deepEqual(missing, []);
});
test('eleven authored coverage additions preserve exact binding and compile in both engines', () => {
  assert.equal(repairs.additions.length, 11);
  assert.equal(new Set(repairs.additions.map(x => x.id)).size, 11);
  assert.equal(blueprints.length, repairs.baselineTotal + repairs.additions.length);
  for (const entry of repairs.additions) {
    const c = characters.find(x => x.id === entry.characterId)!;
    const b = blueprints.find(x => x.id === entry.id);
    assert.ok(b, entry.id);
    assert.equal(b.characterId, c!.id);
    assert.equal(b.outfitId, entry.outfitId);
    assert.equal(b.adult, false);
    assert.equal(b.sampleRating, 'All');
    assert.ok(b.promptProse.length >= 300, entry.id);
    const outfit = popular.findOutfit(c, entry.outfitId);
    assert.ok(outfit);
    for (const engine of ['anima', 'krea2']) {
      const model = engine === 'anima' ? 'anima-miaomiao-v1.2' : 'krea2-turbo-fp8';
      const profile = profiles.find(p => p.model_id === model);
      assert.ok(profile, model);
      const plan = popular.buildPopularPromptPlan({ character: c, blueprint: b, outfit, engine, profile, adultEnabled: false });
      assert.ok(plan, entry.id + ':' + engine);
      assert.equal(plan.adult, false);
      assert.ok(plan.prompt.includes(b.promptProse.split('.')[0]), entry.id);
      assert.ok(!/\bnsfw\b|\bnude\b|\blingerie\b/i.test(plan.prompt), entry.id);
      if (engine === 'krea2') assert.equal(plan.negative, '');
    }
  }
});
test('season and festival stay with their scenes and do not pollute reusable outfits', () => {
  for (const [cid, oid, bid, token] of [
    ['krista_lenz', 'coronation_winter_wall', 'krista_lenz_snowy_wall', 'winter'],
    ['murasame', 'festival_red_yukata_no_fan', 'murasame_festival_goldfish_scooping_joy', 'festival'],
  ]) {
    const c = characters.find(x => x.id === cid);
    assert.ok(!popular.findOutfit!(c, oid).tokens.includes(token));
    assert.ok(blueprints.find!(b => b.id === bid).promptTokens.includes(token));
    assert.deepEqual(popular.scanCharacterPollution(c), []);
  }
});
test('the preserved round-fan outfit does not become a folding fan or replace the fishing variant', () => {
  const c = characters.find(x => x.id === 'murasame');
  const outfit = popular.findOutfit(c, 'summer_yukata');
  assert.ok(outfit!.tokens.includes('uchiwa'));
  assert.ok(!outfit!.tokens.includes('folding_fan'));
  assert.equal(blueprints.find!(b => b.id === 'murasame_festival_goldfish_scooping_joy').outfitId, 'festival_red_yukata_no_fan');
});


test('Ellen tea-service depth of field is retained in both payloads without duplicate tags', () => {
  const b = blueprints.find(item => item.id === 'ellen_maid_cafe_tea_service_deadpan')!;
  const c = characters.find(item => item.id === b!.characterId)!;
  assert.ok(!b!.promptTokens.includes('depth_of_field'));
  assert.ok(b!.promptProse.includes('depth of field'));
  for (const engine of ['anima', 'krea2']) {
    const model = engine === 'anima' ? 'anima-miaomiao-v1.2' : 'krea2-turbo-fp8';
    const profile = profiles.find(item => item.model_id === model);
    const plan = popular.buildPopularPromptPlan({ character:c, blueprint:b, outfit:popular.findOutfit(c,b!.outfitId)!, engine, profile, adultEnabled:false });
    assert.ok(plan);
    assert.ok(plan.prompt.includes('depth of field'));
  }
});
