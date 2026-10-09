'use strict';
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { test }: typeof import('node:test') = require('node:test');
const { execFileSync }: typeof import('node:child_process') = require('node:child_process');
const path: typeof import('node:path') = require('node:path');

test('documentation links and destinations remain valid', () => {
  const output = execFileSync(process.execPath, [path.resolve(__dirname, '../maintenance/check-doc-links.js')], { encoding: 'utf8' });
  assert.match(output, /0 broken links/);
});

test('unbuilt documented tools and redirects require an existing authoritative source in a generated scope', t => {
  const { generatedSourceExists, check }: typeof import('../maintenance/check-doc-links') = require('../maintenance/check-doc-links');
  const fs: typeof import('node:fs') = require('node:fs');
  const root = path.resolve(__dirname, '../..');
  assert.equal(generatedSourceExists(path.join(root, 'tools/nav.js')), true);
  assert.equal(generatedSourceExists(path.join(root, 'scripts/maintenance/check-doc-links.js')), true);
  for (const file of ['tools/missing-source.js', 'src/api/client.js', 'scripts/archive/missing.js', '../outside.js']) {
    assert.equal(generatedSourceExists(path.join(root, file)), false, file);
  }
  const exists = fs.existsSync, previousCode = process.exitCode;
  t.mock.method(fs, 'existsSync', (file: import('node:fs').PathLike) => /\.m?js$/.test(String(file)) ? false : exists(file));
  try {
    process.exitCode = 0;
    check();
    assert.equal(process.exitCode, 0, 'unbuilt generated redirects must resolve through their source');
  } finally { process.exitCode = previousCode; }
});

test('locally present ignored evidence cannot make repository links pass', t => {
  const { check }: typeof import('../maintenance/check-doc-links') = require('../maintenance/check-doc-links');
  const fs: typeof import('node:fs') = require('node:fs');
  const root = path.resolve(__dirname, '../..');
  const document = path.join(root, 'docs/INDEX.md');
  const evidence = path.join(root, 'runtime/doc-link-regression/evidence.html');
  const read = fs.readFileSync, exists = fs.existsSync, previousCode = process.exitCode;
  const messages: string[] = [];
  t.mock.method(fs, 'readFileSync', ((...args: Parameters<typeof read>) => {
    const content = read(...args);
    return args[0] === document ? String(content) + '\n[Local evidence](../runtime/doc-link-regression/evidence.html)\n' : content;
  }) as typeof read);
  t.mock.method(fs, 'existsSync', (file: import('node:fs').PathLike) => file === evidence || exists(file));
  t.mock.method(console, 'error', (message: string) => messages.push(message));
  t.mock.method(console, 'log', () => {});
  try {
    process.exitCode = 0;
    check();
    assert.equal(process.exitCode, 1);
    assert.match(messages.join('\n'), /doc-link-regression\/evidence\.html \(ignored local file/);
  } finally { process.exitCode = previousCode; }
});
