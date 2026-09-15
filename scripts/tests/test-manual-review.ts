'use strict';
const { test }: typeof import('node:test') = require('node:test');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { buildReview }: typeof import('../maintenance/build-scene-manual-review') = require('../maintenance/build-scene-manual-review');
const records = [
  { key: 'scene:a', recordId: 'a1', attempt: 1, status: 'succeeded' },
  { key: 'scene:a', recordId: 'a2', attempt: 2, status: 'succeeded' },
  { key: 'scene:b', recordId: 'b1', attempt: 1, status: 'succeeded' },
  { key: 'scene:c', recordId: 'c1', attempt: 1, status: 'failed' },
];

test('unreviewed successful images remain pending instead of implicitly passing', () => {
  const review = buildReview(records, {});
  assert.deepEqual(Object.keys(review.records), []);
  assert.deepEqual(review.pending, ['scene:a', 'scene:b']);
});

test('an explicit review stays attached to the viewed image, never to its newer retry', () => {
  const decision = { 'scene:a': { verdict: 'pass', recordId: 'a1', notes: 'reviewed first attempt' } };
  const review = buildReview(records, decision);
  assert.equal(review.records['scene:a'].recordId, 'a1');
  assert.deepEqual(review.pending, ['scene:b']);
  assert.throws(() => buildReview(records, decision, { latestOnly: true }), /latest successful attempt/);
  assert.equal(buildReview(records, { 'scene:a': { verdict: 'fail', recordId: 'a2' } }, { latestOnly: true }).records['scene:a'].verdict, 'fail');
});

test('review decisions cannot approve an unknown, failed or different-key record', () => {
  for (const recordId of [undefined, 'missing', 'c1', 'b1']) {
    assert.throws(() => buildReview(records, { 'scene:a': { verdict: 'pass', recordId } }), /succeeded recordId/);
  }
  assert.throws(() => buildReview([...records, records[0]], {}), /duplicate/);
  assert.throws(() => buildReview(records, { 'scene:a': { verdict: 'pending', recordId: 'a1' } }), /invalid decision/);
});
