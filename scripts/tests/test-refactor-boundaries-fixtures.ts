import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { inspectRefactorBoundaries, checkRefactorAllowlist, type RefactorViolation, type RefactorAllowance } from '../lib/refactor-boundaries';
import { readRefactorAllowancesAtRef, refactorAllowanceRefs, REFACTOR_ALLOWLIST_PATH } from '../lib/refactor-allowlist';

type Report = ReturnType<typeof inspectRefactorBoundaries>;

function fixture(files: Record<string, string>, check: (report: Report, root: string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-refactor-boundaries-'));
  try {
    const compilerOptions = {
      module: 'ESNext', moduleResolution: 'Bundler', allowJs: true,
      paths: { '@/*': ['./src/*'], '#raw': ['./src/composables/useKVStore.ts'], '#ui': ['./src/components/Panel.vue'],
        '#native': ['./node_modules/@tauri-apps/api/core.d.ts'] },
    };
    const sources = {
      'tsconfig.app.json': JSON.stringify({ compilerOptions, include: ['src/**/*'] }),
      'tsconfig.node.json': JSON.stringify({ compilerOptions, include: ['server.ts', 'server/**/*', 'routes/**/*', 'services/**/*'] }),
      'src/composables/useKVStore.ts': 'export const kvGet = () => undefined; export interface KVRecord { value: string }',
      'src/composables/useImageStore.ts': 'export const imgGet = () => undefined; export interface ImageRecord { id: string }',
      'node_modules/vue/package.json': JSON.stringify({ name: 'vue', types: 'index.d.ts' }),
      'node_modules/vue/index.d.ts': 'export interface Ref<T> { value: T }; export declare const ref: <T>(value: T) => Ref<T>',
      'node_modules/pinia/package.json': JSON.stringify({ name: 'pinia', types: 'index.d.ts' }),
      'node_modules/pinia/index.d.ts': 'export interface Store { id: string }; export declare const defineStore: () => Store',
      'node_modules/@tauri-apps/api/package.json': JSON.stringify({ name: '@tauri-apps/api', types: 'index.d.ts' }),
      'node_modules/@tauri-apps/api/index.d.ts': 'export declare const invoke: () => Promise<void>',
      'node_modules/@tauri-apps/api/core.d.ts': 'export declare const invoke: () => Promise<void>; export interface InvokeOptions { id: string }',
      ...files,
    };
    for (const [file, source] of Object.entries(sources)) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
    }
    check(inspectRefactorBoundaries(root), root);
  } finally {
    // Delete only the exact temporary root created above; never a repository path.
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function clean(report: Report) {
  assert.deepEqual(report.unknown, [], 'fixture dependencies must be resolvable');
  assert.deepEqual(report.violations, []);
}

function rejects(report: Report, source: string, target: string) {
  assert.deepEqual(report.unknown, [], 'a known forbidden edge must not be disguised as unresolved');
  assert.ok(report.violations.some(edge => edge.source === source && edge.target === target),
    `expected forbidden edge ${source} -> ${target}; got ${JSON.stringify(report.violations)}`);
}

function legacy(check: (edge: RefactorViolation, allowance: RefactorAllowance) => void) {
  fixture({ 'src/views/Legacy.ts': "import { kvGet } from '@/composables/useKVStore'; export const read = kvGet" }, report => {
    assert.deepEqual(report.unknown, []);
    assert.equal(report.violations.length, 1);
    const edge = report.violations[0];
    check(edge, { ...edge, exitBatch: 'R1', reason: 'Move the existing artwork caller behind its repository in R1.' });
  });
}

test('keeps real Web persistence adapters and repository consumers legal', () => {
  fixture({
    'src/storage/artworkRepository.ts': "import { kvGet } from '@/composables/useKVStore'; export const list = kvGet",
    'src/storage/backupRestore.ts': "import { imgGet } from '@/composables/useImageStore'; export const backup = imgGet",
    'src/storage/chatArchiveRepository.ts': "import { kvGet } from '@/composables/useKVStore'; export const list = kvGet",
    'src/platform/web/artworkAdapter.ts': "import { imgGet } from '@/composables/useImageStore'; export const image = imgGet",
    'src/views/Gallery.ts': "import { list } from '@/storage/artworkRepository'; export const load = list",
    'src/platform/desktop/bootstrap.ts': "import { invoke } from '@tauri-apps/api/core'; export const bootstrap = invoke",
    'src/application/artwork/save.ts': "import type { Artwork } from '@/types/artwork'; export const save = (value: Artwork) => value.id",
    'src/types/artwork.ts': 'export interface Artwork { id: string }',
    'server/runtime.ts': "import fs from 'node:fs'; export const read = fs.readFileSync",
  }, clean);
});

test('ignores comments, ordinary strings and template text, and permits unsubscribe on unload', () => {
  fixture({
    'src/views/Good.vue': `<template><pre>require('@/composables/useKVStore')</pre></template>
<script setup lang="ts">
// import bad from '@/composables/useKVStore'
/* export * from '@tauri-apps/api/core' */
const example = "require('@/composables/useImageStore')"
const unsubscribe = () => {}
const onUnmounted = (callback: () => void) => callback
onUnmounted(unsubscribe)
void example
</script>`,
  }, clean);
});

test('permits type-only frontend, use case and Tauri references without reclassifying them as runtime', () => {
  fixture({
    'src/views/Types.ts': "import type { KVRecord } from '@/composables/useKVStore'; export type { ImageRecord } from '@/composables/useImageStore'; export type Value = KVRecord",
    'src/application/artwork/types.ts': "import { type Ref } from 'vue'; export { type Store } from 'pinia'; export type Options = import('@tauri-apps/api/core').InvokeOptions; export type Value = Ref<string>",
    'src/platform/web/types.ts': "export type { InvokeOptions } from '@tauri-apps/api/core'",
  }, report => {
    clean(report);
    assert.ok(report.edges.some(edge => edge.typeOnly && edge.source === 'src/views/Types.ts'));
  });
});

for (const [kind, source] of [
  ['import', "import { kvGet } from '@/composables/useKVStore'; void kvGet"],
  ['export', "export { kvGet } from '@/composables/useKVStore'"],
  ['dynamic', "void import('@/composables/useKVStore')"],
  ['require', "void require('@/composables/useKVStore')"],
  ['import-equals', "import raw = require('@/composables/useKVStore'); void raw"],
] as const) {
  test(`rejects a new frontend raw persistence ${kind} edge`, () => {
    fixture({ 'src/views/Bypass.ts': source }, report => {
      rejects(report, 'src/views/Bypass.ts', 'src/composables/useKVStore.ts');
      assert.ok(report.edges.some(edge => edge.source === 'src/views/Bypass.ts' && edge.kind === kind && !edge.typeOnly));
    });
  });
}

test('mixed named imports and side-effect imports remain runtime dependencies', () => {
  fixture({
    'src/views/Mixed.ts': "import { type KVRecord, kvGet } from '@/composables/useKVStore'; void kvGet; export type Record = KVRecord",
    'src/views/SideEffect.ts': "import '@/composables/useImageStore'",
  }, report => {
    rejects(report, 'src/views/Mixed.ts', 'src/composables/useKVStore.ts');
    rejects(report, 'src/views/SideEffect.ts', 'src/composables/useImageStore.ts');
  });
});

test('normalizes relative, alias, dot-segment and .js-to-TypeScript targets', () => {
  fixture({
    'src/views/Relative.ts': "import { kvGet } from '../composables/useKVStore.js'; void kvGet",
    'src/views/Alias.ts': "import { kvGet } from '#raw'; void kvGet",
    'src/views/DotSegment.ts': "void import('@/utils/../composables/useImageStore')",
    'src/utils/placeholder.ts': 'export {}',
  }, report => {
    rejects(report, 'src/views/Relative.ts', 'src/composables/useKVStore.ts');
    rejects(report, 'src/views/Alias.ts', 'src/composables/useKVStore.ts');
    rejects(report, 'src/views/DotSegment.ts', 'src/composables/useImageStore.ts');
  });
});

test('barrels and new storage files cannot grant themselves persistence exceptions', () => {
  fixture({
    'src/views/Gallery.ts': "import { kvGet } from '@/utils/barrel'; void kvGet",
    'src/utils/barrel.ts': "export { kvGet } from '@/composables/useKVStore'",
    'src/storage/newBypass.ts': "import { imgGet } from '@/composables/useImageStore'; export const get = imgGet",
  }, report => {
    rejects(report, 'src/utils/barrel.ts', 'src/composables/useKVStore.ts');
    rejects(report, 'src/storage/newBypass.ts', 'src/composables/useImageStore.ts');
  });
});

test('inspects both Vue script blocks and external script sources', () => {
  fixture({
    'src/views/Normal.vue': '<script lang="ts">import { kvGet } from "@/composables/useKVStore"; export const read = kvGet</script><template>normal</template>',
    'src/views/Setup.vue': '<script setup lang="ts">import { imgGet } from "@/composables/useImageStore"; void imgGet</script><template>setup</template>',
    'src/views/External.vue': '<script src="../composables/useKVStore.ts"></script><template>external</template>',
  }, report => {
    rejects(report, 'src/views/Normal.vue', 'src/composables/useKVStore.ts');
    rejects(report, 'src/views/Setup.vue', 'src/composables/useImageStore.ts');
    rejects(report, 'src/views/External.vue', 'src/composables/useKVStore.ts');
  });
});

for (const [target, contents] of [
  ['src/storage/concrete.ts', 'export const value = 1'],
  ['src/api/client.ts', 'export const value = 1'],
  ['src/stores/artwork.ts', 'export const value = 1'],
  ['src/composables/useArtwork.ts', 'export const value = 1'],
  ['src/components/Panel.vue', '<template>panel</template>'],
  ['src/views/Panel.vue', '<template>panel</template>'],
  ['src/platform/desktop/bootstrap.ts', 'export const value = 1'],
] as const) {
  test(`use cases cannot import ${target}`, () => {
    fixture({
      'src/application/artwork/save.ts': `import '${target.replace(/^src\//, '@/')}'`,
      [target]: contents,
    }, report => rejects(report, 'src/application/artwork/save.ts', target));
  });
}

for (const target of ['vue', 'pinia', 'node:fs']) {
  test(`use cases cannot import runtime dependency ${target}`, () => {
    fixture({ 'src/application/artwork/save.ts': `import '${target}'` }, report => {
      assert.deepEqual(report.unknown, []);
      assert.ok(report.violations.some(edge => edge.source === 'src/application/artwork/save.ts' && edge.target === target));
    });
  });
}

test('only desktop adapters can import Tauri and Web adapters cannot load desktop adapters', () => {
  fixture({
    'src/composables/useNative.ts': "import { invoke } from '@tauri-apps/api/core'; void invoke",
    'src/platform/web/native.ts': "export { bootstrap } from '../desktop/bootstrap'",
    'src/platform/desktop/bootstrap.ts': "import { invoke } from '@tauri-apps/api/core'; export const bootstrap = invoke",
  }, report => {
    rejects(report, 'src/composables/useNative.ts', '@tauri-apps/api/core');
    rejects(report, 'src/platform/web/native.ts', 'src/platform/desktop/bootstrap.ts');
    assert.ok(!report.violations.some(edge => edge.source === 'src/platform/desktop/bootstrap.ts'));
  });
});

test('Web adapters cannot reach desktop capabilities through a shared barrel', () => {
  fixture({
    'src/platform/web/artwork.ts': "export * from '@/utils/shared'",
    'src/utils/shared.ts': "export * from '@/platform/desktop/bootstrap'",
    'src/platform/desktop/bootstrap.ts': 'export const bootstrap = () => {}',
  }, report => rejects(report, 'src/utils/shared.ts', 'src/platform/desktop/bootstrap.ts'));
});

test('reachable vendor and shared runtime helpers cannot hide forbidden dependencies', () => {
  fixture({
    'src/platform/web/artwork.ts': "export * from '@/vendor/barrel'",
    'src/vendor/barrel.ts': "export * from '@/platform/desktop/bootstrap'",
    'src/platform/desktop/bootstrap.ts': 'export const bootstrap = () => {}',
    'server.ts': "export * from './scripts/lib/helper'",
    'scripts/lib/helper.ts': "export * from '../tests/prototypes/demo'; export type { Artwork } from '../../src/types/artwork'",
    'scripts/tests/prototypes/demo.ts': 'export const save = () => {}',
    'src/types/artwork.ts': 'export interface Artwork { id: string }',
  }, report => {
    rejects(report, 'src/vendor/barrel.ts', 'src/platform/desktop/bootstrap.ts');
    rejects(report, 'scripts/lib/helper.ts', 'scripts/tests/prototypes/demo.ts');
    rejects(report, 'scripts/lib/helper.ts', 'src/types/artwork.ts');
    assert.ok(report.files.includes('scripts/lib/helper.ts'));
    assert.ok(report.files.includes('src/vendor/barrel.ts'));
  });
});

test('local declaration barrels preserve runtime type boundaries', () => {
  fixture({
    'server/runtime.ts': "export type { Artwork } from '../shared/types'",
    'shared/types.d.ts': "export { Artwork } from '../src/types/artwork'",
    'src/types/artwork.ts': 'export interface Artwork { id: string }',
  }, report => {
    rejects(report, 'shared/types.d.ts', 'src/types/artwork.ts');
    assert.ok(report.edges.filter(edge => edge.source === 'shared/types.d.ts').every(edge => edge.typeOnly));
  });
});

test('a runtime import cannot execute a local declaration-only module', () => {
  fixture({
    'src/utils/runtime.ts': "import './types'",
    'src/utils/types.d.ts': 'export interface Value { id: string }',
  }, report => assert.ok(report.unknown.some(item => item.includes('runtime import of declaration-only source'))));
});

test('package aliases cannot disguise Tauri capabilities', () => {
  fixture({ 'src/composables/useNative.ts': "export { invoke } from '#native'" }, report => {
    rejects(report, 'src/composables/useNative.ts', '@tauri-apps/api/core.d.ts');
  });
});

test('invalid Vue scripts and imports of frontend tests cannot yield a clean scan', () => {
  fixture({
    'src/views/Broken.vue': '<script src="./other.ts"></script><script setup>const x = 1</script>',
    'src/views/other.ts': 'export {}',
    'src/utils/production.ts': "import './fixture.spec'",
    'src/utils/fixture.spec.ts': 'export {}',
  }, report => {
    assert.ok(report.unknown.some(item => item.includes('invalid SFC')));
    assert.ok(report.violations.some(edge => edge.target === 'src/utils/fixture.spec.ts'));
  });
});

for (const source of ['server.ts', 'server/runtime.ts', 'routes/workspace.ts', 'services/workspace.ts']) {
  test(`runtime source ${source} cannot depend on frontend, including types`, () => {
    fixture({
      [source]: "import type { Artwork } from '@/types/artwork'; export type Saved = Artwork; export { value } from '@/utils/value'",
      'src/types/artwork.ts': 'export interface Artwork { id: string }',
      'src/utils/value.ts': 'export const value = 1',
    }, report => {
      rejects(report, source, 'src/types/artwork.ts');
      rejects(report, source, 'src/utils/value.ts');
      assert.ok(report.violations.some(edge => edge.source === source && edge.typeOnly));
    });
  });
}

for (const source of ['src/utils/prototype.ts', 'server/runtime.ts', 'routes/workspace.ts', 'services/workspace.ts']) {
  test(`production source ${source} cannot reuse test prototype code or types`, () => {
    const target = 'scripts/tests/prototypes/artwork.ts';
    let relative = path.posix.relative(path.posix.dirname(source), target);
    if (!relative.startsWith('.')) relative = './' + relative;
    fixture({
      [source]: `export { save } from '${relative}'; export type { Record } from '${relative}'`,
      [target]: 'export const save = () => {}; export interface Record { id: string }',
    }, report => {
      rejects(report, source, target);
      assert.ok(report.violations.some(edge => edge.source === source && edge.typeOnly));
    });
  });
}

test('test files are not production entrypoints, but importing their source remains forbidden', () => {
  fixture({
    'src/views/Page.spec.ts': "import '@/composables/useKVStore'; import '@tauri-apps/api/core'",
    'scripts/tests/prototypes/artwork.ts': "import '@/composables/useKVStore'",
  }, report => {
    clean(report);
    assert.ok(!report.files.includes('src/views/Page.spec.ts'));
    assert.ok(!report.files.includes('scripts/tests/prototypes/artwork.ts'));
  });
});

test('computed imports and missing local modules cannot produce a clean report', () => {
  fixture({
    'src/application/artwork/save.ts': "const target = './missing'; void import(target); require(target); import './unresolved'",
  }, report => {
    assert.ok(report.unknown.length >= 3, JSON.stringify(report));
    assert.ok(report.unknown.some(item => item.includes('src/application/artwork/save.ts')));
  });
});

test('an exact legacy allowance is accepted and removing edge plus allowance is accepted', () => {
  legacy((edge, allowance) => {
    assert.deepEqual(checkRefactorAllowlist([edge], [allowance], [allowance]), []);
    assert.deepEqual(checkRefactorAllowlist([], [], [allowance]), []);
    assert.deepEqual(checkRefactorAllowlist([], [], []), []);
  });
});

test('new violations cannot authorize themselves through new allowlist entries', () => {
  legacy((edge, allowance) => {
    assert.ok(checkRefactorAllowlist([edge], [], []).length);
    assert.ok(checkRefactorAllowlist([edge], [allowance], []).length);
    const addedEdge = { ...edge, source: 'src/views/NewBypass.ts' };
    const addedAllowance = { ...allowance, ...addedEdge };
    assert.ok(checkRefactorAllowlist([edge, addedEdge], [allowance, addedAllowance], [allowance]).length);
  });
});

test('the ceiling rejects edits to source, target, dependency kind, type classification, rule or exit batch', () => {
  legacy((edge, allowance) => {
    const alternatives: Array<Partial<RefactorAllowance>> = [
      { source: 'src/views/Changed.ts' }, { target: 'src/composables/useImageStore.ts' },
      { kind: 'dynamic' }, { typeOnly: !edge.typeOnly },
      { rule: 'changed-rule' as RefactorAllowance['rule'] }, { exitBatch: 'R11' },
    ];
    for (const change of alternatives) {
      const changed = { ...allowance, ...change };
      const changedEdge: RefactorViolation = { source: changed.source, target: changed.target, kind: changed.kind, typeOnly: changed.typeOnly, rule: changed.rule };
      assert.ok(checkRefactorAllowlist([changedEdge], [changed], [allowance]).length, JSON.stringify(change));
    }
  });
});

test('stale, duplicate, wildcard and incomplete allowances fail closed', () => {
  legacy((edge, allowance) => {
    assert.ok(checkRefactorAllowlist([], [allowance], [allowance]).length, 'stale entry');
    assert.ok(checkRefactorAllowlist([edge], [allowance, allowance], [allowance]).length, 'duplicate entry');
    for (const change of [
      { source: 'src/**' }, { target: 'src/composables/*' },
      { exitBatch: '' }, { reason: '' },
    ]) {
      const malformed = { ...allowance, ...change };
      assert.ok(checkRefactorAllowlist([edge], [malformed], [malformed]).length, JSON.stringify(change));
    }
  });
});

test('a retired exemption cannot be restored against the tightened ceiling', () => {
  legacy((edge, allowance) => {
    const tightenedCeiling: RefactorAllowance[] = [];
    assert.deepEqual(checkRefactorAllowlist([], [], tightenedCeiling), []);
    assert.ok(checkRefactorAllowlist([edge], [allowance], tightenedCeiling).length);
  });
});

function gitFixture(check: (root: string, baseCommit: string,
  commitAllowances: (entries: RefactorAllowance[] | null, message: string) => string) => void) {
  const temporaryParent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temporaryParent, 'huiyu-refactor-git-'));
  const environment = { ...process.env };
  for (const name of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete environment[name];
  const git = (args: string[]) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', windowsHide: true, shell: false,
    env: environment, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const commit = (message: string) => {
    git(['-c', 'user.name=R0 Fixture', '-c', 'user.email=r0-fixture@example.invalid',
      '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(root, 'disabled-hooks')}`,
      'commit', '--quiet', '--allow-empty', '-m', message]);
    return git(['rev-parse', 'HEAD']);
  };
  try {
    git(['init', '--quiet', '--template=']);
    const baseCommit = commit('pre-R0 fixture baseline');
    check(root, baseCommit, (entries, message) => {
      const target = path.join(root, REFACTOR_ALLOWLIST_PATH);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (entries === null) fs.rmSync(target);
      else fs.writeFileSync(target, JSON.stringify(entries));
      git(['add', '--', REFACTOR_ALLOWLIST_PATH]);
      return commit(message);
    });
  } finally {
    assert.equal(path.dirname(fs.realpathSync(root)), temporaryParent);
    assert.ok(path.basename(root).startsWith('huiyu-refactor-git-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('Git ancestors without an allowlist use the seed and committed versions are read exactly', () => {
  legacy((_edge, allowance) => gitFixture((root, baseCommit, commitAllowances) => {
    const seed = { baseCommit, entries: [allowance] };
    assert.deepEqual(readRefactorAllowancesAtRef(root, baseCommit, seed), [allowance]);
    const introduced = commitAllowances([allowance], 'introduce R0 exact legacy edge');
    assert.deepEqual(readRefactorAllowancesAtRef(root, introduced, seed), [allowance]);
    // Reading a committed version must ignore both the current file and its absence.
    fs.rmSync(path.join(root, REFACTOR_ALLOWLIST_PATH));
    assert.deepEqual(readRefactorAllowancesAtRef(root, introduced, seed), [allowance]);
    assert.deepEqual(readRefactorAllowancesAtRef(root, 'HEAD^', seed), [allowance]);
  }));
});

test('Git history keeps retired allowances removed when a current change tries to reintroduce them', () => {
  legacy((edge, allowance) => gitFixture((root, baseCommit, commitAllowances) => {
    const seed = { baseCommit, entries: [allowance] };
    const introduced = commitAllowances([allowance], 'introduce R0 allowance');
    const retired = commitAllowances([], 'retire the legacy edge and its allowance');
    const historicalCeiling = readRefactorAllowancesAtRef(root, retired, seed);
    assert.deepEqual(historicalCeiling, []);
    assert.deepEqual(checkRefactorAllowlist([], [], historicalCeiling), []);
    assert.ok(checkRefactorAllowlist([edge], [allowance], historicalCeiling).length);
    // The original approved seed still contains the edge, so checking it alone is insufficient.
    assert.deepEqual(checkRefactorAllowlist([edge], [allowance], readRefactorAllowancesAtRef(root, introduced, seed)), []);
  }));
});

test('invalid Git revisions and an allowlist removed after R0 fail closed', () => {
  legacy((_edge, allowance) => gitFixture((root, baseCommit, commitAllowances) => {
    const seed = { baseCommit, entries: [allowance] };
    assert.throws(() => readRefactorAllowancesAtRef(root, 'refs/heads/no-such-fixture-ref', seed));
    commitAllowances([allowance], 'introduce R0 allowance');
    const removed = commitAllowances(null, 'incorrectly delete the R0 allowlist');
    assert.throws(() => readRefactorAllowancesAtRef(root, removed, seed), /missing refactor allowlist after R0/);
    assert.throws(() => readRefactorAllowancesAtRef(root, 'HEAD', seed), /missing refactor allowlist after R0/);
  }));
});

test('base selection respects the existing AICS_HYGIENE_BASE_REF and falls back for a zero SHA', () => {
  const ciEnvironment = { AICS_HYGIENE_BASE_REF: '  refs/remotes/origin/main  ' };
  assert.deepEqual(refactorAllowanceRefs(ciEnvironment.AICS_HYGIENE_BASE_REF), ['HEAD', 'refs/remotes/origin/main']);
  assert.deepEqual(refactorAllowanceRefs('0'.repeat(40)), ['HEAD', 'HEAD^']);
  assert.deepEqual(refactorAllowanceRefs(undefined), ['HEAD', 'HEAD^']);
  assert.deepEqual(refactorAllowanceRefs('  '), ['HEAD', 'HEAD^']);
  assert.deepEqual(refactorAllowanceRefs('HEAD'), ['HEAD']);
});
