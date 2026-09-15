'use strict';

import { PathLike } from 'node:fs';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const path: typeof import('node:path') = require('node:path');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const { createHash }: typeof import('node:crypto') = require('node:crypto');

function git(root: string, ...args: string[]) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  const result = spawnSync('git', ['-c', 'core.hooksPath=' + os.devNull, '-c', 'core.autocrlf=false',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args],
  { cwd: root, env, encoding: 'utf8', timeout: 20000, windowsHide: true, shell: false });
  assert.equal(result.status, 0, `${args[0]}: ${result.stderr}`);
  return result.stdout.trim();
}

function fixture(t: any, withGit = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'content-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file: string, value: string|Uint8Array<ArrayBufferLike>|Uint8ClampedArray<ArrayBufferLike>|Uint16Array<ArrayBufferLike>|Uint32Array<ArrayBufferLike>|Int8Array<ArrayBufferLike>|Int16Array<ArrayBufferLike>|Int32Array<ArrayBufferLike>|BigUint64Array<ArrayBufferLike>|BigInt64Array<ArrayBufferLike>|Float16Array<ArrayBufferLike>|Float32Array<ArrayBufferLike>|Float64Array<ArrayBufferLike>|DataView<ArrayBufferLike>|({ id: string; char: string; prompt: string; rating: string; mature: boolean; }|undefined)[]|{ id: string; name: string; }[]) => {
    const destination = path.join(root, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  };
  const read = (file: string) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const characters = [
    { id: 'a', identityProse: 'identity a', outfits: [{ id: 'dress', prose: 'dress a', default: true, isDefault: true }, { id: 'coat', prose: 'coat a', default: false, isDefault: false }] },
    { id: 'b', identityProse: 'identity b', outfits: [{ id: 'coat', prose: 'coat b', default: true, isDefault: true }] },
    { id: 'unrelated', identityProse: 'identity c', outfits: [{ id: 'other', default: true, isDefault: true }] },
  ];
  const blueprints = [
    { id: 'bp-a', characterId: 'a', outfitId: 'dress', prompt: 'initial prompt' },
    { id: 'bp-default', characterId: 'a', prompt: 'default outfit prompt' },
    { id: 'bp-unrelated', characterId: 'unrelated', outfitId: 'other', prompt: 'unrelated prompt' },
  ];
  const scenes = [
    { id: 'sc001', char: 'a', prompt: 'one', rating: 'All', mature: false },
    { id: 'sc002', char: 'natsume', prompt: 'two', rating: 'All', mature: false },
    { id: 'sc1000', char: 'triad', prompt: 'four digits', rating: 'All', mature: false },
  ];
  for (const [domain, key, values, output, version] of [
    ['popular', 'characters', characters, 'popular-characters', 1],
    ['blueprints', 'blueprints', blueprints, 'scene-blueprints', 2],
  ]) {
    write(`data/${domain}/manifest.json`, { files: [{ file: 'one.json', count: values.length }] });
    write(`data/${domain}/one.json`, { [key]: values });
    write(`data/${output}.json`, { version, [key]: values });
  }
  write('data/scenes/manifest.json', { files: [{ file: 'one.json', count: 3 }] });
  write('data/scenes/one.1.json', scenes.slice(0, 2));
  write('data/scenes/one.2.json', scenes.slice(2));
  write('data/curation.json', { curatedSceneIds: ['sc001'], signatureSceneIds: [], personaCoreSceneIds: ['sc001'] });
  write('data/retired-scenes.json', { records: [{ id: 'sc099', reason: 'retired' }] });
  const sceneProducts = (rows = scenes, core = ['sc001']) => {
    const ordered = [...rows].sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
    write('data/scenes.json', ordered);
    const groups = { nene: ordered.filter((r) => r.char !== 'natsume' && r.char !== 'triad'),
      natsume: ordered.filter((r) => r.char === 'natsume'), shared: ordered.filter((r) => r.char === 'triad') };
    for (const [group, rows] of Object.entries(groups)) write(`data/scenes-${group}.json`, rows);
    const coreIds = core.filter((id) => ordered.some((row) => row.id === id));
    write('data/scenes-core.json', coreIds.map((id) => ordered.find((row) => row.id === id)));
    write('data/scenes-index.json', { version: 1, total: rows.length,
      shards: Object.fromEntries(Object.entries(groups).map(([key, rows]) => [key, { file: `scenes-${key}.json`, count: rows.length }])),
      tiers: { core: coreIds }, orderedIds: ordered.map((row) => row.id) });
  };
  sceneProducts();
  const perspectives = [{ id: 'face', name: 'Face', shotType: 'closeup', lens: '85mm', targetUsage: ['identity'] }];
  const standards = { perspectives, characters: [{ id: 'a', displayName: 'A', source: 'fixture', identityProse: 'identity a',
    outfits: [{ id: 'dress', name: 'Dress', prose: 'dress a', isDefault: true }] }] };
  write('data/character-reference-standards.json', standards);
  write('data/character-reference-view.json', { a: { characterId: 'a', displayName: 'A', source: 'fixture', identityProse: 'identity a',
    outfits: [{ outfitId: 'dress', outfitName: 'Dress', prose: 'dress a', isDefault: true, isNsfw: false,
      references: perspectives.map((p) => ({ ...p, pending: true, url: '' })) }] } });
  write('data/characters.json', [{ id: 'a', name: 'A' }]);
  write('src/assets/css/director/tokens.css', '.pb { --character-accent: red; }');
  let base = null;
  if (withGit) {
    git(root, 'init');
    git(root, 'add', '--', 'data', 'src');
    git(root, 'commit', '-m', 'isolated baseline');
    base = git(root, 'rev-parse', 'HEAD');
  }
  return { root, base, write, read, characters, blueprints, scenes, sceneProducts };
}

function snapshot(root: string) {
  const entries: string[][] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file);
      if (entry.isSymbolicLink()) entries.push([relative, 'link', fs.readlinkSync(file)]);
      else if (entry.isDirectory()) { entries.push([relative, 'directory']); visit(file); }
      else entries.push([relative, 'file', createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);
    }
  };
  visit(root);
  return entries;
}

export = { fixture, git, snapshot };
