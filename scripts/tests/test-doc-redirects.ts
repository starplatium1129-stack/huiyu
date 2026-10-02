'use strict';
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { test }: typeof import('node:test') = require('node:test');
const { execFileSync }: typeof import('node:child_process') = require('node:child_process');
const path: typeof import('node:path') = require('node:path');

test('documentation links and destinations remain valid', () => {
  const output = execFileSync(process.execPath, [path.resolve(__dirname, '../maintenance/check-doc-links.js')], { encoding: 'utf8' });
  assert.match(output, /0 broken links/);
});
