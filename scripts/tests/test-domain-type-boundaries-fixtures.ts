import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { test } from 'node:test';
import { inspectModuleBoundaries, type BoundaryReport } from '../lib/domain-type-boundaries';

function fixture(files: Record<string, string>, check: (report: BoundaryReport) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-boundaries-'));
  try {
    const sources = {
      'tsconfig.app.json': JSON.stringify({ compilerOptions: {
        module: 'ESNext', moduleResolution: 'Bundler', allowJs: true,
        paths: { '@/*': ['./src/*'], '#state': ['./src/stores/hidden.ts'] },
      }, include: ['src/**/*'] }),
      ...files,
    };
    for (const [file, source] of Object.entries(sources)) {
      const target = path.join(root, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, source);
    }
    check(inspectModuleBoundaries(root, ['src/types/domain.ts']));
  } finally {
    // The only recursive deletion is the exact temporary directory made above.
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('allows pure aliases, inline type imports, import types and source behind .js paths', () => {
  fixture({
    'src/types/domain.ts': "import { type A } from '@/types/a'; export type B = import('./a.js').A",
    'src/types/a.ts': 'export interface A { id: string }',
  }, report => {
    assert.deepEqual(report.unknown, []);
    assert.deepEqual(report.violations, []);
    assert.equal(report.edges.length, 2);
    assert.ok(report.edges.every(edge => edge.typeOnly && edge.to === 'src/types/a.ts'));
  });
});

for (const source of [
  "import type { State } from '#state'",
  "export type { State } from '#state'",
  "const state = require('#state')",
  "const state = import(`#state`)",
  "import state = require('#state')",
  "type State = import('#state').State",
]) {
  test(`rejects a store dependency through a re-export: ${source}`, () => {
    fixture({
      'src/types/domain.ts': "export * from './barrel'",
      'src/types/barrel.ts': source,
      'src/stores/hidden.ts': 'export interface State { value: number }',
    }, report => {
      assert.deepEqual(report.unknown, []);
      assert.ok(report.violations.some(item => item.includes('src/stores/hidden.ts')));
    });
  });
}

test('reports type and runtime cycles separately', () => {
  fixture({
    'src/types/domain.ts': "import type { A } from './a'; import './runtime'; export type B = A",
    'src/types/a.ts': "import type { B } from './domain'; export interface A { b: B }",
    'src/types/runtime.ts': "import './domain'",
  }, report => {
    assert.deepEqual(report.unknown, []);
    assert.deepEqual(report.runtimeCycles, [['src/types/domain.ts', 'src/types/runtime.ts', 'src/types/domain.ts']]);
    assert.deepEqual(report.typeCycles, [['src/types/domain.ts', 'src/types/a.ts', 'src/types/domain.ts']]);
  });
});

test('mixed imports and side effects remain runtime edges, inline re-exports can be type-only', () => {
  fixture({
    'src/types/domain.ts': "import { type A, value } from './a'; export { type A } from './a'; import './a'",
    'src/types/a.ts': 'export interface A {}\nexport const value = 1',
  }, report => {
    assert.deepEqual(report.unknown, []);
    assert.deepEqual(report.edges.map(edge => edge.typeOnly), [false, true, false]);
  });
});

test('parses both Vue script blocks and script src, ignoring import-like template text', () => {
  fixture({
    'src/types/domain.ts': "import './bridge.vue'; import './external.vue'",
    'src/types/bridge.vue': '<template>require("not-an-import")</template>\n<script lang="ts">export const value = 1</script>\n<script setup lang="ts">import type { A } from "./a"</script>',
    'src/types/external.vue': '<script src="./external.ts"></script>',
    'src/types/external.ts': "export * from '#state'",
    'src/types/a.ts': 'export interface A {}',
    'src/stores/hidden.ts': 'export const value = 1',
  }, report => {
    assert.deepEqual(report.unknown, []);
    assert.ok(report.violations.some(item => item.includes('src/stores/hidden.ts')));
    assert.ok(report.files.includes('src/types/bridge.vue'));
    assert.ok(report.edges.some(edge => edge.specifier === './a' && edge.typeOnly));
  });
});

test('unresolved, computed imports and reachable excluded files stay unknown', () => {
  fixture({
    'src/types/domain.ts': "import './missing'; require(name); import(`./${name}`); import './helper.spec'",
    'src/types/helper.spec.ts': 'export const fixture = true',
  }, report => {
    assert.equal(report.unknown.length, 4);
    assert.ok(report.unknown.some(item => item.includes('cannot resolve ./missing')));
    assert.ok(report.unknown.some(item => item.includes('outside checked scope')));
  });
});

test('rejects framework imports even when type-only; does not read dependency packages', () => {
  fixture({ 'src/types/domain.ts': "import type { Ref } from 'vue'; export type { Store } from 'pinia'" }, report => {
    assert.equal(report.violations.length, 2);
    assert.deepEqual(report.unknown, []);
  });
});

test('invalid SFCs are unknown rather than a clean scan', () => {
  fixture({
    'src/types/domain.ts': "import './broken.vue'",
    'src/types/broken.vue': '<script src="./external.ts"></script><script setup>const n = 1</script>',
  }, report => assert.ok(report.unknown.some(item => item.includes('invalid SFC'))));
});

test('direct component imports are forbidden even when they have no script', () => {
  fixture({
    'src/types/domain.ts': "import View from '@/components/View.vue'",
    'src/components/View.vue': '<template>view</template>',
  }, report => {
    assert.deepEqual(report.unknown, []);
    assert.ok(report.violations.some(item => item.includes('src/components/View.vue')));
  });
});
