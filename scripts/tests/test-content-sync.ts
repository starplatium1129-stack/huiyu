/** Isolated, no-production-write regression checks for the maintenance entry point. */
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const os: typeof import('node:os') = require('node:os');
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const sourceRoot = path.resolve(__dirname, '../..');
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'aics-content-sync-'));
const data = path.join(fixture, 'data');
const write = (name: string, value: any) => {
  const file = path.join(data, name); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(data, name), 'utf8'));
function snapshot(dir = fixture): string {
  return fs.readdirSync(dir).sort().map(name => {
    const file = path.join(dir, name);
    return fs.statSync(file).isDirectory() ? `${name}/{${snapshot(file)}}` : `${name}:${fs.readFileSync(file, 'base64')}`;
  }).join('\n');
}
function run(...args: string[]) {
  return spawnSync(process.execPath, [path.join(sourceRoot, 'scripts/maintenance/sync-content.js'), `--root=${fixture}`, ...args], { encoding: 'utf8' });
}
function rejected(expected: RegExp, ...args: string[]) {
  const before = snapshot(); const result = run('--apply', ...args);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, expected);
  assert.equal(snapshot(), before, 'validation failure must not write');
}
try {
  write('characters.json', [{ id: 'alice', name: 'Alice' }]);
  write('popular/manifest.json', { version: 1, files: [{ file: 'demo.json', franchise: 'Demo', count: 0 }] });
  const alice = { id: 'alice', displayName: 'Alice', originalName: 'Alice', franchise: 'Demo', identityProse: 'An adult woman with brown hair.', identityTokens: ['brown_hair'], outfits: [{ id: 'default', name: 'Default', default: true, tokens: ['dress'], prose: 'A blue dress.' }] };
  write('popular/demo.json', { version: 1, franchise: 'Demo', characters: [alice] });
  write('blueprints/manifest.json', { version: 1, files: [{ file: 'demo.json', franchise: 'Demo', count: 0 }] });
  const blueprint = { id: 'alice_garden', characterId: 'alice', outfitId: 'default' };
  write('blueprints/demo.json', { version: 2, franchise: 'Demo', blueprints: [blueprint] });
  write('scenes/manifest.json', { version: 1, files: [{ file: 'nene-core.json' }] });
  write('scenes/nene-core.json', []);
  // A minimal independent library; the new character has no references yet.
  const { loadReferenceShards, writeReferenceLibrary }: typeof import('../lib/reference-store') = require('../lib/reference-store');
  writeReferenceLibrary(fixture, { version: 1, perspectives: [{ id: 'front', name: 'Front', shotType: 'full_body', lens: '50mm', targetUsage: 'identity' }], characters: [] }, {});
  const before = snapshot();
  const preview = run();
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(snapshot(), before, 'default preview must be byte-for-byte read only');
  rejected(/Unknown selected character/, '--ids=missing');
  write('blueprints/demo.json', { version: 2, franchise: 'Demo', blueprints: [{ ...blueprint, outfitId: 'missing' }] });
  rejected(/unknown outfitId/);
  write('blueprints/demo.json', { version: 2, franchise: 'Demo', blueprints: [blueprint, blueprint] });
  rejected(/duplicate ID/);
  write('blueprints/demo.json', { version: 2, franchise: 'Other', blueprints: [blueprint] });
  rejected(/franchise differs/);
  write('blueprints/demo.json', { version: 2, franchise: 'Demo', blueprints: [blueprint] });
  write('characters.json', []); rejected(/missing characters.json profile/);
  write('characters.json', [{ id: 'alice', name: 'Alice' }]);
  write('popular/manifest.json', { files: [{ file: '../characters.json', franchise: 'Demo' }] });
  rejected(/unsafe manifest path/);
  write('popular/manifest.json', { version: 1, files: [{ file: 'demo.json', franchise: 'Demo', count: 0 }] });
  const apply = run('--apply'); assert.equal(apply.status, 0, apply.stderr);
  assert.equal(read('popular/manifest.json').files[0].count, 1);
  assert.equal(read('blueprints/manifest.json').files[0].count, 1);
  assert.deepEqual(read('popular-characters.json').characters, [alice]);
  assert.deepEqual(read('scene-blueprints.json').blueprints, [blueprint]);
  assert.deepEqual(read('scenes.json'), []);
  const references = loadReferenceShards(fixture);
  assert.equal(references.standards.characters[0].id, 'alice');
  assert.ok(references.view.alice.outfits[0].references.every((ref: any) => ref.pending && !ref.url));
  const after = snapshot(); const repeat = run('--apply'); assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(snapshot(), after, 'repeated synchronization must preserve content');
  console.log('PASS content:sync preview, registration, count repair, aggregates, idempotence and write-before-validation protection');
} finally { fs.rmSync(fixture, { recursive: true, force: true }); }
export {};
