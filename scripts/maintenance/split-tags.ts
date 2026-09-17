import { aggregatePath, writeTagShards } from '../lib/tag-store';

/**
 * 将 data/tags.json 拆分为各分类分片文件（data/tags/*.json + manifest.json）。
 * 需要显式传入 --write 才会覆盖执行。
 */
if (!process.argv.includes('--write')) {
  console.error('Refusing to split tags into shards without --write');
  process.exit(1);
}

const count = writeTagShards();
console.log(`Split ${count} tags from ${aggregatePath} into data/tags/*.json`);
