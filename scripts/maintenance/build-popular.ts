import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
/** Build the browser-facing data/popular-characters.json from per-franchise shards. */
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { aggregatePath, aggregateIsCurrent, loadPopularShards, writePopularAggregate }: typeof import('../lib/popular-store') = require('../lib/popular-store');
const { syncDataVersion }: typeof import('../lib/data-version') = require('../lib/data-version');

const ROOT = path.resolve(__dirname, '..', '..');
const check = process.argv.includes('--check');
const { characters, sources } = loadPopularShards();
const counts = sources.map(({ entry, characters: items }: any) => entry.file + '=' + items.length).join(', ');

if (check) {
  if (!aggregateIsCurrent()) {
    if (!fs.existsSync(aggregatePath)) {
      // 产物从未构建（fresh clone；产物自 2026-08-28 起不入库）：自愈构建而非报错
      writePopularAggregate();
      console.log('Popular products missing: rebuilt ' + characters.length + ' characters (' + counts + ')');
    } else {
      // 已构建但与源不一致 = 改了源忘重建，保留报错守卫
      console.error('Popular build is stale: run npm run popular:build');
      process.exit(1);
    }
  } else {
    console.log('Popular build current: ' + characters.length + ' characters (' + counts + ')');
  }
} else {
  writePopularAggregate();
  console.log('Built ' + aggregatePath + ': ' + characters.length + ' characters (' + counts + ')');
  // 同步 DATA_VERSION（与 build-scenes 共用哈希口径）
  try {
    const result = syncDataVersion(ROOT);
    console.log(`[DATA_VERSION] virtual:data-version 将解析为 ${result.version}`);
  } catch (e) {
    console.warn('[DATA_VERSION] 同步跳过:', runtimeErrorMessage(e));
  }
}
