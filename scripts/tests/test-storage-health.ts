'use strict';

import assert = require('node:assert/strict');
var health: typeof import('../../src/utils/storageHealth.ts') = require('../../src/utils/storageHealth.ts');

const { test }: typeof import('node:test') = require('node:test');

test("Storage health tests passed against the production TypeScript module", () => {
const good: any[] = [
  { id:1, timestamp:100, image_id:'img_a', prompt:'ok' },
  { id:2, timestamp:200, image_id:'img_b', prompt:'ok2' },
  { id:3, timestamp:300, prompt:'no image is fine' }
];
const mixed: any[] = good.concat([
  null,
  'bad',
  { prompt:'no id' },
  { id:9, prompt:'no timestamp' },
  { id:10, timestamp:400, image_id:123 }
]);

var validated = health.validateHistoryEntry(good[0]);
assert.strictEqual(validated.ok, true);

var badId = health.validateHistoryEntry({ timestamp:1 });
assert.strictEqual(badId.ok, false);
assert.ok(badId.reasons.indexOf('missing_id') !== -1);

var partition = health.quarantinePartition(mixed);
assert.strictEqual(partition.good.length, 3);
assert.strictEqual(partition.bad.length, 5);

var report = health.inspectStorageHealth(mixed, ['img_a', 'img_orphan'], {
  quota:{ usage:50, quota:100 }
});
assert.strictEqual(report.historyCount, 3);
assert.strictEqual(report.imageCount, 2);
assert.strictEqual(report.quarantineCount, 5);
assert.deepStrictEqual(report.missingImageIds.sort(), ['img_b']);
assert.deepStrictEqual(report.orphanImageIds, ['img_orphan']);
assert.strictEqual(report.quota?.ratio, 0.5);
assert.strictEqual(report.ok, false);

var clean = health.inspectStorageHealth(good, ['img_a', 'img_b']);
assert.strictEqual(clean.ok, true);
assert.strictEqual(clean.missingImageIds.length, 0);
assert.strictEqual(clean.orphanImageIds.length, 0);

assert.strictEqual(health.estimateStorageQuota(null), null);
assert.deepStrictEqual(health.estimateStorageQuota({ usage:10, quota:40 }), {
  usage:10, quota:40, ratio:0.25
});

var summary = health.summarizeStorageHealth(report);
assert.ok(summary.indexOf('3 条历史') !== -1);
assert.ok(summary.indexOf('隔离') !== -1);
assert.strictEqual(health.HISTORY_QUARANTINE_KEY, 'aics_pb_history_quarantine');

});
