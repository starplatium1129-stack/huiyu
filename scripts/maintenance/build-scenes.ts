import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
/** Build the browser-facing data/scenes.json from canonical scene shards. */
const fs: typeof import('fs') = require('fs');
const {
  aggregatePath, browserShardPath, corePath, indexPath,
  aggregateIsCurrent, loadSceneShards, writeAggregate,
}: typeof import('../lib/scene-store') = require('../lib/scene-store');
const { syncDataVersion }: typeof import('../lib/data-version') = require('../lib/data-version');
const path: typeof import('path') = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const check = process.argv.includes('--check');
const { scenes, sources } = loadSceneShards();
const counts = sources.map(({ file, scenes: items }: any) => file + '=' + items.length).join(', ');

if (check) {
  if (!aggregateIsCurrent(scenes)) {
    // 任一产物缺失（fresh clone / 部分丢失；产物自 2026-08-28 起不入库）→ 自愈重建
    const anyMissing = [aggregatePath, browserShardPath.nene, browserShardPath.natsume,
      browserShardPath.shared, corePath, indexPath].some((file: any) => !fs.existsSync(file));
    if (anyMissing) {
      writeAggregate(scenes);
      console.log('Scene products missing: rebuilt ' + scenes.length + ' scenes (' + counts + ')');
    } else {
      // 产物齐全但与源不一致 = 改了源忘重建，保留报错守卫
      console.error('Scene build is stale: run npm run scenes:build');
      process.exit(1);
    }
  } else {
    console.log('Scene build current: ' + scenes.length + ' scenes (' + counts + ')');
  }
} else {
  writeAggregate(scenes);
  console.log('Built ' + aggregatePath + ': ' + scenes.length + ' scenes (' + counts + ')');
  // 同步 DATA_VERSION（与 validate-content-contracts.js 共用哈希口径，避免手 bump 遗漏导致 immutable 缓存漂移）
  try {
    const result = syncDataVersion(ROOT);
    console.log(`[DATA_VERSION] virtual:data-version 将解析为 ${result.version}`);
  } catch (e) {
    console.warn('[DATA_VERSION] 同步跳过:', runtimeErrorMessage(e));
  }
}
