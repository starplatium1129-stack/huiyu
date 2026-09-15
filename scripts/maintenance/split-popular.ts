/** Import data/popular-characters.json into the per-franchise popular shards. */
const { aggregatePath, writePopularShards }: typeof import('../lib/popular-store') = require('../lib/popular-store');

if (!process.argv.includes('--write')) {
  console.error('Refusing to replace popular shards without --write');
  process.exit(1);
}

const count = writePopularShards();
console.log('Imported ' + count + ' characters from ' + aggregatePath + ' into data/popular/*.json');
