#!/usr/bin/env node
'use strict';

/**
 * scripts/maintenance/split-blueprints.js — 将 data/scene-blueprints.json 拆分回按系列分片的 data/blueprints/*.json
 *
 * 用法：node scripts/maintenance/split-blueprints.js --write
 */
const { aggregatePath, writeBlueprintShards }: typeof import('../lib/blueprint-store') = require('../lib/blueprint-store');

if (!process.argv.includes('--write')) {
  console.error('Refusing to replace blueprint shards without --write');
  process.exit(1);
}

const count = writeBlueprintShards();
console.log('Imported ' + count + ' blueprints from ' + aggregatePath + ' into data/blueprints/*.json');
