'use strict';

import { SpawnSyncOptionsWithStringEncoding } from 'node:child_process';

const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const cp: typeof import('node:child_process') = require('node:child_process');
const { test }: typeof import('node:test') = require('node:test');
const { fixture }: typeof import('./content-check-fixture') = require('./content-check-fixture');
const { git, snapshot }: typeof import('./content-history-fixture') = require('./content-history-fixture');
const { parse, checkContentImpact, main }: typeof import('../maintenance/check-content-impact') = require('../maintenance/check-content-impact');
const script = path.resolve(__dirname, '../maintenance/check-content-impact.js');
const run = (f: any, ...args: (string|undefined)[]) => checkContentImpact(parse(['--root', f.root, '--base', f.base, ...args]));

test('default preview never runs predicates; known text delta executes only proved stable IDs', (t) => {
  const f = fixture(t);
  f.changeBlueprint({ prompt: 'a neutral updated object' });
  const before = snapshot(f.root);
  const preview = run(f);
  assert.equal(preview.execution.executed, false);
  assert.equal(preview.exitCode, 0);
  const result = run(f, '--execute');
  assert.equal(result.selection.mode, 'incremental');
  assert.equal(result.selection.targets.length, 1);
  assert.ok(result.selection.targets[0].includes('bp-a'));
  assert.equal(result.execution.status, 'passed-scoped');
  assert.ok(result.execution.checks.every((check: any) => check.executed && check.status === 'passed'));
  assert.equal(result.exitCode, 3, 'global gate is not waived by scoped success');
  assert.equal(result.execution.wholeLibrary, 'not-validated');
  assert.deepEqual(snapshot(f.root), before);
});

test('selected record structural or projection failures return failure rather than empty success', (t) => {
  const f = fixture(t);
  f.changeBlueprint({ prompt: 'changed' });
  f.write('data/scene-blueprints.json', { version: 2, blueprints: f.blueprints });
  const result = run(f, '--execute');
  assert.equal(result.exitCode, 1);
  assert.equal(result.execution.checks.find((check: any) => check.id === 'record-equality').status, 'failed');
  f.changeBlueprint({ prompt: 'changed again', title: '' });
  const invalid = run(f, '--execute');
  assert.equal(invalid.selection.mode, 'full');
  assert.equal(invalid.execution.checks.find((check: any) => check.id === 'runtime-field-contracts').status, 'failed');
});

test('unknown paths and public contracts automatically execute full supported structure and field checks', (t) => {
  const f = fixture(t);
  f.write('scripts/lib/shared-contract.js', 'throw new Error("never execute imported change")');
  f.write('data/untracked-domain.json', { unknown: true });
  const result = run(f, '--execute');
  assert.equal(result.selection.mode, 'full');
  assert.ok(result.selection.reasons.some((reason: any) => reason.includes('untracked-domain')));
  assert.equal(result.execution.checks.filter((check: any) => check.id.startsWith('structure-and-projection:')).length, 7);
  assert.equal(result.execution.status, 'passed-scoped');
  assert.equal(result.exitCode, 3);
  assert.ok(result.execution.checks.some((check: any) => check.id === 'existing-reference-view-schema' && check.status === 'passed'));
});

test('unrecognized explicit paths beneath a known domain cannot hide behind a proved text delta', (t) => {
  const f = fixture(t);
  f.changeBlueprint({ prompt: 'changed neutral object' });
  const result = run(f, '--execute', '--path', 'data/blueprints/never-registered.json');
  assert.equal(result.selection.mode, 'full');
  assert.ok(result.selection.reasons.some((reason: any) => reason.includes('never-registered')));
  assert.equal(result.exitCode, 3);
});

test('deletion and rename use old relations, then execute full checks that find dangling references', (t) => {
  const f = fixture(t);
  git(f.root, 'mv', 'data/popular/one.json', 'data/popular/renamed.json');
  f.write('data/popular/manifest.json', { files: [{ file: 'renamed.json', count: 2 }] });
  f.write('data/popular/renamed.json', { characters: f.characters.slice(1) });
  f.write('data/popular-characters.json', { version: 1, characters: f.characters.slice(1) });
  const result = run(f, '--execute');
  assert.equal(result.selection.mode, 'full');
  assert.ok(result.history.affected.some((item: any) => item.id === 'bp-a'));
  assert.ok(result.history.history.entities.some((item: { id: string; change: string; }) => item.id === 'a' && item.change === 'removed'));
  assert.equal(result.execution.checks.find((check: any) => check.id === 'source-relationships').status, 'failed');
  assert.equal(result.exitCode, 1);
});

test('aggregate ordering cannot take the incremental route; unsupported source boundaries stay incomplete', (t) => {
  const f = fixture(t);
  f.write('data/scene-blueprints.json', { version: 2, blueprints: [...f.blueprints].reverse() });
  assert.equal(run(f, '--execute').selection.mode, 'full');
  assert.equal(run(f, '--execute').exitCode, 1);
  f.write('data/scene-blueprints.json', { version: 2, blueprints: f.blueprints });
  fs.unlinkSync(path.join(f.root, 'data/blueprints/one.json'));
  const unknown = run(f, '--execute');
  assert.equal(unknown.selection.mode, 'full');
  assert.equal(unknown.execution.checks.find((check: any) => check.id === 'structure-and-projection:blueprints').status, 'unknown');
  assert.notEqual(unknown.exitCode, 0);
});

test('explicit full runs without Git, reuses exact schema and cannot silently drop invalid records', (t) => {
  const f = fixture(t, false);
  const call = () => checkContentImpact(parse(['--root', f.root, '--full', '--execute']));
  assert.equal(call().execution.status, 'passed-scoped');
  const standards = f.read('data/character-reference-standards.json');
  standards.characters[0].unexpectedField = true;
  f.write('data/character-reference-standards.json', standards);
  const result = call();
  assert.equal(result.exitCode, 1);
  assert.equal(result.execution.checks.find((check: any) => check.id === 'existing-reference-standards-schema').status, 'failed');
});

test('full structural fallback also has zero write/process effects; ownership describes field checks without claiming execution', (t) => {
  const f = fixture(t, false);
  const before = snapshot(f.root);
  const mocks = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'copyFileSync']
    .map((name) => t.mock.method(fs, name, () => { throw new Error(`Unexpected write: ${name}`); }));
  const proc = t.mock.method(cp, 'spawnSync', () => { throw new Error('No process in full checks'); });
  const result = checkContentImpact(parse(['--root', f.root, '--full', '--execute']));
  assert.equal(result.execution.status, 'passed-scoped');
  const ownership = (require('../maintenance/report-content-ownership') as typeof import('../maintenance/report-content-ownership')).reportOwnership({ root: f.root, domain: 'blueprints' }).domains[0];
  assert.equal(ownership.fieldValidation.status, 'not-run');
  assert.ok(ownership.fieldValidation.rules.some((rule: string|string[]) => rule.includes('parseSceneBlueprint')));
  assert.equal(ownership.readWriteCoverage.completeness, 'unknown');
  for (const mock of [...mocks, proc]) mock.mock.restore();
  assert.deepEqual(snapshot(f.root), before);
});

test('help and plan read nothing, parameters fail closed, CLI returns distinct preview/failure/full-required codes', (t) => {
  for (const args of [[], ['--base', '--write'], ['--execute', '--execute', '--base', 'HEAD'], ['--full', '--scene', 'sc001'], ['--base', 'HEAD;bad']]) assert.throws(() => parse(args));
  const f = fixture(t);
  f.changeBlueprint({ prompt: 'updated object' });
  const before = snapshot(f.root);
  for (const [extra, code] of [[[], 0], [['--execute'], 3]]) {
    const output = cp.spawnSync(process.execPath, [script, '--root', f.root, '--base', f.base, '--json', ...extra], { encoding: 'utf8' });
    assert.equal(output.status, code, output.stderr || output.stdout);
    assert.equal(JSON.parse(output.stdout).execution.executed, code === 3);
  }
  assert.deepEqual(snapshot(f.root), before);
  t.mock.method(console, 'log', () => {});
  t.mock.method(fs, 'readFileSync', () => { throw new Error('Unexpected read'); });
  t.mock.method(cp, 'spawnSync', () => { throw new Error('Unexpected process'); });
  for (const flag of ['--help', '--plan']) assert.equal(main(['--base', 'HEAD', '--execute', flag]), 0);
});

test('execution never invokes a builder or write API and checks only temporary data', (t) => {
  const f = fixture(t);
  f.changeBlueprint({ prompt: 'updated object' });
  const before = snapshot(f.root);
  const mocks = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'renameSync', 'unlinkSync', 'rmSync', 'copyFileSync']
    .map((name) => t.mock.method(fs, name, () => { throw new Error(`Unexpected write: ${name}`); }));
  const spawn = cp.spawnSync;
  const proc = t.mock.method(cp, 'spawnSync', (command: any, args: readonly string[], options: SpawnSyncOptionsWithStringEncoding) => {
    assert.equal(command, 'git');
    return spawn(command, args, options);
  });
  assert.equal(run(f, '--execute').execution.status, 'passed-scoped');
  for (const mock of mocks) mock.mock.restore();
  proc.mock.restore();
  assert.deepEqual(snapshot(f.root), before);
});
