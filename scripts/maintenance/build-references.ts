import path = require('node:path');
import fs = require('node:fs');
import { aggregateIsCurrent, loadReferenceShards, writeReferenceAggregate } from '../lib/reference-store';

const root = path.resolve(process.env.AICS_DATA_ROOT || process.env.AICS_APP_ROOT || path.join(__dirname, '../..'));
try {
  const check = process.argv.includes('--check');
  const count = loadReferenceShards(root).standards.characters.length;
  const missing = ['standards', 'view'].some(name => !fs.existsSync(path.join(root, `data/character-reference-${name}.json`)));
  if (check && !missing && !aggregateIsCurrent(root)) throw new Error('Reference products stale: run reference:build');
  if (!check || missing) writeReferenceAggregate(root);
  console.log(`Reference library: ${count} characters; ${check && !missing ? 'current' : 'built'}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
