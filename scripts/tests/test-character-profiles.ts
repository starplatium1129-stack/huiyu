'use strict';

const assert: typeof import('assert') = require('assert');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { test }: typeof import('node:test') = require('node:test');

test("Character profile tests passed: boundary parsing, scene records, and typed views", () => {
const {
  parseCharacterProfiles,
  parseCharacterScenes,
}: typeof import('../../src/utils/characterProfiles.ts') = require('../../src/utils/characterProfiles.ts');

const root = path.resolve(__dirname, '..', '..');
const characterView = fs.readFileSync(path.join(root, 'src/views/CharacterView.vue'), 'utf8');
const scenarioView = fs.readFileSync(path.join(root, 'src/views/ScenarioView.vue'), 'utf8');
const scenarioConfig = fs.readFileSync(path.join(root, 'src/config/scenarios.ts'), 'utf8');

const profiles = parseCharacterProfiles([
  {
    id: 'nene',
    name: 'Nene',
    icon: 'x',
    tags: ['gentle', 42],
    identity: { role: 'heroine', age: null },
    portrait: { image: '/nene.webp' },
    lora: { recommended_scene: ['sc001', false], trigger_words: ['nene'] },
  },
  { id: 'nene', name: 'Duplicate' },
  { id: '', name: 'Invalid' },
  null,
]);
assert.strictEqual(profiles.length, 1, 'profiles must reject invalid and duplicate records');
const legacy = parseCharacterProfiles([{ id: 'legacy', name: 'Legacy', identity: '  Existing identity  ', speech: 'Existing speech example' }])[0];
assert.deepStrictEqual(legacy.identity, { role: 'Existing identity' }, 'legacy identity strings must remain visible');
assert.strictEqual(legacy.voice, 'Existing speech example', 'speech examples must be displayed when legacy voice is absent');
const modern = parseCharacterProfiles([{ id: 'modern', name: 'Modern', identity: { faction: 'Existing faction' }, voice: 'Voice example', speech: 'Fallback' }])[0];
assert.strictEqual(modern.voice, 'Voice example', 'explicit voice examples retain precedence');
assert.strictEqual(modern.identity!.faction, 'Existing faction', 'factions must survive profile parsing');
assert.strictEqual(parseCharacterProfiles([{ id: 'named', name: 'Named', lora: { name: 'registered-model' } }])[0].lora!.name, 'registered-model', 'registered LoRA names must not become empty profile panels');
assert.deepStrictEqual(profiles[0].tags, ['gentle'], 'profile string arrays must be normalized');
assert.deepStrictEqual(
  profiles[0].lora!.recommended_scene,
  ['sc001'],
  'recommended scene ids must discard non-string values',
);
assert.deepStrictEqual(
  parseCharacterScenes([
    { id: 'sc001', title: 'Scene', story: 'Story', char: 'nene' },
    { id: 'sc002', title: 2, char: 'nene' },
  ]),
  [{ id: 'sc001', title: 'Scene', story: 'Story', char: 'nene' }],
  'recommendation scenes must expose only valid display records',
);
assert(!/\bany\b/.test(characterView), 'CharacterView must not regress to explicit any types');
assert(!/\bany\b/.test(scenarioView), 'ScenarioView must not regress to explicit any types');
assert(!/\bany\b/.test(scenarioConfig), 'scenario contract module must not regress to explicit any types');
assert(
  characterView.includes('parseCharacterProfiles') && characterView.includes('parseCharacterScenes'),
  'CharacterView must normalize store data through production parsers',
);
assert(
  scenarioConfig.includes('interface ScenarioAct') && scenarioConfig.includes('ScenarioCharacter'),
  'scenario contract must stay explicit in the shared module both views consume',
);
assert(
  scenarioView.includes('@/config/scenarios') && scenarioView.includes('substituteScenarioPrompt'),
  'ScenarioView must consume the shared scenario contract instead of duplicating data',
);

});
