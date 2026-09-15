const assert: typeof import('assert') = require('assert');
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { test }: typeof import('node:test') = require('node:test');

test("Scene UX tests passed: tiers, sentence search, relevance, preferences, recent scenes, and local usage", () => {
const { readJson }: typeof import('../lib/scene-store') = require('../lib/scene-store');
// scene-ux 已迁到 src/utils/sceneUX.ts。
// Node 22+ 支持直接 require TS（自动剥离类型），无需为测试维护 CJS 副本。
const sceneUx: typeof import('../../src/utils/sceneUX.ts') = require('../../src/utils/sceneUX.ts');

const root = path.resolve(__dirname, '..', '..');
assert(!/\bany\b/.test(fs.readFileSync(path.join(root, 'src/utils/sceneUX.ts'), 'utf8')),
  'sceneUX must not regress to explicit any types');
const scenes = readJson(path.join(root, 'data', 'scenes.json'));
const curation = readJson(path.join(root, 'data', 'curation.json'));

assert(scenes.length > 0, 'scene data must not be empty');
assert(curation.signatureSceneIds.length > 0, 'signature scenes must be configured');

const sorted = [...scenes].sort((left, right) => sceneUx.priority(right, curation) - sceneUx.priority(left, curation));
assert.strictEqual(sceneUx.tier(sorted[0], curation), 'signature', 'signature scenes must sort first');
assert.deepStrictEqual(sorted.slice(0, curation.signatureSceneIds.length).map((scene) => scene.id), curation.signatureSceneIds,
  'signature scenes must preserve the curator-defined order');

for (const intent of Object.keys(curation.searchAliases || {})) {
  const matches = scenes.filter((scene: Record<string,unknown>) => sceneUx.matchesSearch(scene, intent, curation));
  assert(matches.length > 0, 'semantic intent must return scenes: ' + intent);
}

const neneMatches = scenes.filter((scene: Record<string,unknown>) => sceneUx.matchesSearch(scene, '宁宁经典感', curation));
assert(neneMatches.every((scene: { char: string; }) => scene.char === 'nene' || scene.char === 'triad'), 'Nene intent must not return Natsume-only scenes');
const natsumeMatches = scenes.filter((scene: Record<string,unknown>) => sceneUx.matchesSearch(scene, '夏目经典感', curation));
assert(natsumeMatches.every((scene: { char: string; }) => scene.char === 'natsume' || scene.char === 'triad'), 'Natsume intent must not return Nene-only scenes');

const sentence = '我想画一个安静的夏目雨夜';
const sentenceAnalysis = sceneUx.analyzeQuery(sentence, curation);
assert.deepStrictEqual(sentenceAnalysis.residualTerms, [], 'natural-language filler must not become a required search term');
assert(sentenceAnalysis.intents.includes('安静') && sentenceAnalysis.intents.includes('夏目经典感') && sentenceAnalysis.intents.includes('雨天'),
  'natural-language search must recognize mood, character, and weather intents');
const sentenceMatches = scenes.filter((scene: Record<string,unknown>) => sceneUx.matchesSearch(scene, sentence, curation));
assert(sentenceMatches.length > 0, 'natural-language sentence must return scenes');
assert(sentenceMatches.every((scene: { char: string; }) => scene.char === 'natsume' || scene.char === 'triad'), 'natural-language character intent must be respected');
assert(!sceneUx.analyzeQuery('夏目', curation).intents.includes('夏日'), 'single-character aliases must not match inside longer names');

const rankConfig = { searchAliases:{ '雨夜':['雨夜','rainy_night'] } };
const titleMatch = { id:'title', title:'雨夜告白', story:'两个人终于说出心意', char:'natsume', tags:[] };
const storyMatch = { id:'story', title:'迟来的约定', story:'故事发生在雨夜', char:'natsume', tags:[] };
assert(sceneUx.searchScore(titleMatch, '雨夜', rankConfig) > sceneUx.searchScore(storyMatch, '雨夜', rankConfig),
  'title matches must rank above story-only matches');

const preferenceNow = Date.UTC(2026, 6, 22);
const profile = sceneUx.buildPreferenceProfile([
  { scene:'sc002', character:'nene', timestamp:preferenceNow - 1000, favorite:true },
  { scene:'sc002', character:'nene', timestamp:preferenceNow - 2000, favorite:false },
  { scene:'sc046', character:'natsume', timestamp:preferenceNow - 3000, favorite:false }
], preferenceNow);
const damagedProfile = sceneUx.buildPreferenceProfile([
  null,
  {},
  { scene:42, character:{}, rating:'bad', favorite:true },
], preferenceNow);
assert.strictEqual(damagedProfile.entries, 2, 'preference history must count only object records');
assert.deepStrictEqual(damagedProfile.scenes, {}, 'invalid scene ids must not create synthetic preference keys');
assert.deepStrictEqual(damagedProfile.characters, {}, 'invalid character ids must not create synthetic preference keys');
const preferredScene = scenes.find((scene: { id: string; }) => scene.id === 'sc002');
const weakScene = scenes.find((scene: { id: string; }) => scene.id === 'sc046');
assert(sceneUx.personalScore(preferredScene, profile) > sceneUx.personalScore(weakScene, profile), 'favorite scenes must receive a stronger personal score');
assert(sceneUx.isPersonalFavorite(preferredScene, profile), 'history favorites must be available to scene filters');
assert(sceneUx.personalReason(preferredScene, profile).includes('收藏'), 'personal recommendation must explain why a scene is promoted');

const sceneStory = { id:'story-bound', story:'宁宁在雨后的站台回头微笑' };
assert(sceneUx.isSceneBoundStory(sceneStory, '宁宁在雨后的站台回头微笑', ''),
  'an unchanged scene story must be recognized as scene-bound');
assert(sceneUx.isSceneBoundStory(sceneStory, '  宁宁在雨后的站台回头微笑  ', sceneStory.story),
  'scene-bound comparison must ignore surrounding whitespace');
assert(!sceneUx.isSceneBoundStory(sceneStory, '我想画夏目在海边看日落', sceneStory.story),
  'a free-form story must not be removed when an incompatible scene is cleared');

const historyTagScene = { id:'history-tags', tags:['school_uniform', 'classroom', 'window_light'] };
assert.deepStrictEqual(sceneUx.restoreHistoryManualTags({}, historyTagScene, true), historyTagScene.tags,
  'legacy history must restore compatible scene tags so the scene template remains complete');
assert.deepStrictEqual(sceneUx.restoreHistoryManualTags({ manual_tags:[] }, historyTagScene, true), [],
  'an explicit empty manual tag snapshot must not fall back to scene defaults');
assert.deepStrictEqual(
  sceneUx.restoreHistoryManualTags({ manual_tags:['school_uniform', 'custom_hand_pose', 'CLASSROOM'] }, historyTagScene, false),
  ['custom_hand_pose'],
  'incompatible history must remove built-in scene tags while preserving genuine manual additions'
);
assert.strictEqual(sceneUx.restoreHistoryStory({ story:sceneStory.story }, sceneStory, false), '',
  'an incompatible history scene must not restore story text still bound to that scene');
assert.strictEqual(sceneUx.restoreHistoryStory({ story:'我想画夏目在海边看日落' }, sceneStory, false), '我想画夏目在海边看日落',
  'an incompatible history scene must preserve a free-form story');
assert.strictEqual(sceneUx.restoreHistoryStory({ story:sceneStory.story }, sceneStory, true), sceneStory.story,
  'a compatible history scene must retain its original story');

const memory = new Map();
const storage: any = { getItem:(key: unknown) => memory.has(key) ? memory.get(key) : null, setItem:(key: unknown, value: unknown) => memory.set(key, value) };
sceneUx.rememberRecent(scenes[0], storage);
sceneUx.rememberRecent(scenes[1], storage);
sceneUx.rememberRecent(scenes[0], storage);
const recent = sceneUx.readRecent(storage);
assert.strictEqual(recent.length, 2, 'recent scenes must be deduplicated');
assert.strictEqual(recent[0].id, scenes[0].id, 'most recent scene must be first');
memory.set('aics_recent_scenes', JSON.stringify([
  { id:'valid', title:5, char:'nene', usedAt:'12' },
  null,
  { title:'missing id' },
]));
assert.deepStrictEqual(
  sceneUx.readRecent(storage),
  [{ id:'valid', title:'', char:'nene', usedAt:12 }],
  'damaged recent-scene storage must be normalized before use',
);

sceneUx.recordSceneUsage(scenes[0], storage, preferenceNow - 86400000);
sceneUx.recordSceneUsage(scenes[0], storage, preferenceNow);
sceneUx.recordSceneUsage(scenes[1], storage, preferenceNow - 100 * 86400000);
const usage = sceneUx.readSceneUsage(storage);
assert.strictEqual(usage[scenes[0].id].uses, 2, 'scene selections must increment local usage');
assert.strictEqual(usage[scenes[0].id].lastUsed, preferenceNow, 'scene usage must retain the latest selection time');
assert(sceneUx.sceneUsageScore(usage[scenes[0].id], preferenceNow) > sceneUx.sceneUsageScore(usage[scenes[1].id], preferenceNow),
  'frequent and recent scenes must rank above stale one-off selections');

const legacyUsageMemory = new Map([[sceneUx.SCENE_USAGE_KEY, JSON.stringify({
  sc001:{ uses:'3.9', lastUsed:'1234', token:'must-not-survive' },
  broken:{ uses:0, lastUsed:99 },
  '':{ uses:10, lastUsed:99 },
})]]);
const legacyUsageStorage = {
  getItem:(key: string) => legacyUsageMemory.has(key) ? legacyUsageMemory.get(key) : null,
  setItem:(key: string, value: string) => legacyUsageMemory.set(key, value),
};
assert.deepStrictEqual(sceneUx.readSceneUsage(legacyUsageStorage), {
  sc001:{ uses:3, lastUsed:1234 },
}, 'legacy scene usage maps must be normalized during migration');
assert.deepStrictEqual(JSON.parse(legacyUsageMemory.get(sceneUx.SCENE_USAGE_KEY)), {
  version:sceneUx.SCENE_USAGE_VERSION,
  records:{ sc001:{ uses:3, lastUsed:1234 } },
}, 'scene usage migration must persist a versioned allowlisted envelope');

legacyUsageMemory.set(sceneUx.SCENE_USAGE_KEY, '{damaged');
assert.deepStrictEqual(sceneUx.readSceneUsage(legacyUsageStorage), {},
  'damaged scene usage JSON must recover to an empty map');
assert.deepStrictEqual(JSON.parse(legacyUsageMemory.get(sceneUx.SCENE_USAGE_KEY)), {
  version:sceneUx.SCENE_USAGE_VERSION,
  records:{},
}, 'damaged scene usage must be replaced by a valid current envelope');

});
