import fs from 'node:fs';
import path from 'node:path';
import {
  aggregatePath,
  dictionaryPath,
  manifestPath,
  aggregateIsCurrent,
  loadTagShards,
  writeTagAggregate,
} from '../lib/tag-store';
import { errorMessage } from '../lib/runtime-errors';

const { syncDataVersion } = require('../lib/data-version');
const { refreshPrecompressed } = require('../lib/ensure-data-build');

const ROOT = path.resolve(__dirname, '..', '..');
const check = process.argv.includes('--check');

const { tags, sources } = loadTagShards();
const counts = sources.map(({ entry, tags: items }) => `${entry.file}=${items.length}`).join(', ');

if (check) {
  if (!aggregateIsCurrent()) {
    if (!fs.existsSync(aggregatePath)) {
      writeTagAggregate();
      refreshPrecompressed([aggregatePath, dictionaryPath, manifestPath]);
      console.log(`Tags products missing: rebuilt ${tags.length} tags (${counts})`);
    } else {
      console.error('Tags build is stale: run npm run tags:build');
      process.exit(1);
    }
  } else {
    console.log(`Tags build current: ${tags.length} tags (${counts})`);
  }
} else {
  writeTagAggregate();
  refreshPrecompressed([aggregatePath, dictionaryPath, manifestPath]);
  console.log(`Built ${aggregatePath}: ${tags.length} tags (${counts})`);
  try {
    const result = syncDataVersion(ROOT);
    console.log(`[DATA_VERSION] virtual:data-version 将解析为 ${result.version}`);
  } catch (e) {
    console.warn('[DATA_VERSION] 同步跳过:', errorMessage(e));
  }
}
