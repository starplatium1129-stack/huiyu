import assert from 'node:assert/strict';
import { test } from 'node:test';
const { verifyDesktopGateway }: typeof import('../maintenance/verify-desktop-gateway') = require('../maintenance/verify-desktop-gateway');

// Explicit Windows candidate acceptance, outside the cross-platform unit lane.
// Storage behavior is exercised by runtime-rs/tests against isolated databases;
// this probe proves the selected distribution runs without developer Node files.
test('staged Rust runtime serves an isolated installed bundle', { timeout: 60_000 }, async () => {
  assert.equal(process.platform, 'win32');
  const result = await verifyDesktopGateway();
  assert.match(result.runtimeSha256, /^[a-f0-9]{64}$/);
  assert.equal(typeof result.releaseReady, 'boolean');
  assert.ok(Array.isArray(result.pending));
});
