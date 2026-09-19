#!/usr/bin/env node
import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';

/**
 * scripts/maintenance/build-blueprints.js — 从按系列分片的 data/blueprints/*.json 构建 data/scene-blueprints.json
 *
 * 用法：node scripts/maintenance/build-blueprints.js [--check]
 */
const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const {
  aggregatePath,
  aggregateIsCurrent,
  loadBlueprintShards,
  writeBlueprintAggregate,
}: typeof import('../lib/blueprint-store') = require('../lib/blueprint-store');
const { syncDataVersion }: typeof import('../lib/data-version') = require('../lib/data-version');
const { refreshPrecompressed } = require('../lib/ensure-data-build');

const ROOT = path.resolve(__dirname, '..', '..');
const check = process.argv.includes('--check');
const { blueprints, sources } = loadBlueprintShards();
const counts = sources.map(({ entry, blueprints: items }: any) => entry.file + '=' + items.length).join(', ');

if (check) {
  if (!aggregateIsCurrent()) {
    if (!fs.existsSync(aggregatePath)) {
      // 产物从未构建（fresh clone / 产物退出版本库）：自愈构建而非报错
      writeBlueprintAggregate();
      refreshPrecompressed([aggregatePath]);
      console.log('Blueprint products missing: rebuilt ' + blueprints.length + ' blueprints (' + counts + ')');
    } else {
      // 已构建但与源不一致 = 改了源忘重建，保留报错守卫
      console.error('Blueprint build is stale: run npm run blueprints:build');
      process.exit(1);
    }
  } else {
    console.log('Blueprint build current: ' + blueprints.length + ' blueprints (' + counts + ')');
  }
} else {
  writeBlueprintAggregate();
  refreshPrecompressed([aggregatePath]);
  console.log('Built ' + aggregatePath + ': ' + blueprints.length + ' blueprints (' + counts + ')');
  // 同步 DATA_VERSION
  try {
    const result = syncDataVersion(ROOT);
    console.log(`[DATA_VERSION] virtual:data-version 将解析为 ${result.version}`);
  } catch (e) {
    console.warn('[DATA_VERSION] 同步跳过:', runtimeErrorMessage(e));
  }
}
