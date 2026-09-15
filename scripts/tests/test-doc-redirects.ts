'use strict';
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { test }: typeof import('node:test') = require('node:test');
const { redirectLegacyDocs }: typeof import('../../server/docs') = require('../../server/docs');
const { execFileSync }: typeof import('node:child_process') = require('node:child_process');
const path: typeof import('node:path') = require('node:path');

test('documentation links and destinations remain valid', () => {
  const output = execFileSync(process.execPath, [path.resolve(__dirname, '../maintenance/check-doc-links.js')], { encoding: 'utf8' });
  assert.match(output, /0 broken links/);
});

test('old document URLs keep their query and only redirect known reads', () => {
  const calls: any = [];
  const res = { redirect: (...args) => calls.push(args) };
  redirectLegacyDocs({ method: 'GET', path: '/art-direction.html', url: '/art-direction.html?v=2' }, res, () => assert.fail('known path'));
  assert.deepEqual(calls, [[308, '/docs/guides/art/art-direction.html?v=2']]);
  let passed = 0;
  for (const request of [{ method: 'GET', path: '/unknown.md' }, { method: 'POST', path: '/art-direction.html' }]) {
    redirectLegacyDocs(request, res, () => passed++);
  }
  assert.equal(passed, 2);
  assert.equal(calls.length, 1);
});
