/** Import data/scenes.json into the canonical scene shards. */
const { aggregatePath, readJson, writeSceneShards }: typeof import('../lib/scene-store') = require('../lib/scene-store');
const { parsePromptScenes }: typeof import('../../src/utils/promptCatalog.ts') = require('../../src/utils/promptCatalog.ts');

if (!process.argv.includes('--write')) {
  console.error('Refusing to replace scene shards without --write');
  process.exit(1);
}

const data = readJson(aggregatePath);
if (!Array.isArray(data)) throw new Error('data/scenes.json root must be an array');
const scenes = parsePromptScenes(data);
writeSceneShards(scenes);
console.log('Imported ' + scenes.length + ' scenes from ' + aggregatePath + ' into data/scenes/*.json');
