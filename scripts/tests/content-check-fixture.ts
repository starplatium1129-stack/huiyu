'use strict';
const { fixture: baseFixture, git }: typeof import('./content-history-fixture') = require('./content-history-fixture');

function fixture(t: { after: (arg0: () => void) => void; }, withGit = true) {
  const f = baseFixture(t, false);
  for (const character of f.characters) {
    Object.assign(character, { displayName: 'Neutral example', originalName: 'Example', franchise: 'Fixture',
      identityTokens: ['neutral'], recommendedEngine: 'anima', adultEligibility: 'unknown' });
    for (const outfit of character.outfits) Object.assign(outfit, { name: 'Plain coat', prose: 'neutral clothing', tokens: ['coat'] });
  }
  for (const blueprint of f.blueprints) Object.assign(blueprint, { title: 'Still life', category: 'Fixture', description: 'Neutral example',
    location: 'room', action: 'standing', timeOfDay: 'morning', lighting: 'daylight', camera: 'medium', mood: 'calm',
    promptProse: 'a neutral test object', promptTokens: ['object'], recommendedSize: '512x512' });
  for (const [domain, key, values, product, version] of [
    ['popular', 'characters', f.characters, 'popular-characters', 1], ['blueprints', 'blueprints', f.blueprints, 'scene-blueprints', 2],
  ]) {
    f.write(`data/${domain}/one.json`, { [key]: values });
    f.write(`data/${product}.json`, { version, [key]: values });
  }
  for (const scene of f.scenes) scene.negative = 'blur';
  f.write('data/scenes/one.1.json', f.scenes.slice(0, 2));
  f.write('data/scenes/one.2.json', f.scenes.slice(2));
  f.sceneProducts();
  f.write('data/characters.json', ['a', 'natsume'].map((id) => ({ id, name: 'Example', source: 'Fixture', speech: 'Neutral', type: 'popular',
    portrait: { image: '/not-checked.png' }, visual_dna: { signature: 'neutral' }, traits: ['a', 'b', 'c'] })));
  f.write('data/loras.json', [{ id: 'fixture', name: 'fixture', strength: { min: 0, default: 1, max: 2 }, compatible_models: ['fixture'] }]);
  const ids = ['ref_01_face_closeup', 'ref_02_half_medium', 'ref_03_full_dynamic', 'ref_04_back_rear'];
  const perspectives = ids.map((id) => ({ id, name: 'Neutral perspective', shotType: 'medium', lens: '50mm', targetUsage: ['fixture'] }));
  const standards = { version: 2, schema: 'character-reference-standards-v2', description: 'Neutral fixture', perspectives,
    characters: [{ id: 'a', displayName: 'Example', originalName: 'Example', source: 'Fixture', identityProse: 'neutral object', identityTokens: ['object'],
      outfits: [{ id: 'dress', name: 'Coat', prose: 'neutral clothing', tokens: ['coat'], isDefault: true, isNsfw: false }] }] };
  f.write('data/character-reference-standards.json', standards);
  f.write('data/character-reference-view.json', { a: { characterId: 'a', displayName: 'Example', source: 'Fixture', identityProse: 'neutral object',
    outfits: [{ outfitId: 'dress', outfitName: 'Coat', prose: 'neutral clothing', isDefault: true, isNsfw: false,
      references: perspectives.map((p) => ({ ...p, fileName: `${p.id}.png`, url: '', pending: true })) }] } });
  if (withGit) {
    git(f.root, 'init'); git(f.root, 'add', '--', 'data', 'src'); git(f.root, 'commit', '-m', 'neutral check fixture');
    f.base = git(f.root, 'rev-parse', 'HEAD');
  }
  f.changeBlueprint = (patch: unknown) => {
    const rows = f.read('data/blueprints/one.json');
    Object.assign(rows.blueprints[0], patch);
    f.write('data/blueprints/one.json', rows);
    f.write('data/scene-blueprints.json', { version: 2, ...rows });
  };
  return f;
}
export = { fixture };
