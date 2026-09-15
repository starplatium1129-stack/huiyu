import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';

type ProjectName = 'services' | 'node' | 'tests' | 'browser';
const builder = import('../build-node.mjs');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huiyu-typescript-build-'));
  const write = (relative: string, content: string) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const configs: Record<ProjectName, Record<string, any>> = {
    services: { compilerOptions: { target: 'ES2022', module: 'CommonJS', strict: true, declaration: true,
      rootDir: 'services', outDir: 'services', types: [], skipLibCheck: true },
      include: ['services/**/*.ts'], exclude: ['services/**/*.d.ts'] },
    node: { compilerOptions: { target: 'ES2022', module: 'Node16', moduleResolution: 'Node16',
      strict: true, noEmitOnError: true, rootDir: '.', outDir: '.', types: [], skipLibCheck: true },
      include: ['server.ts', 'server/**/*.ts'], exclude: [] },
    browser: { compilerOptions: { target: 'ES2022', module: 'None', strict: true, noEmitOnError: true,
      rootDir: '.', outDir: '.', types: [], lib: ['ES2022', 'DOM'], skipLibCheck: true },
      include: ['tools/*.ts'], exclude: [] },
    tests: { compilerOptions: { target: 'ES2022', module: 'Preserve', moduleResolution: 'Bundler',
      strict: true, noEmit: true, resolveJsonModule: true, rootDir: '.', outDir: '.', types: [], skipLibCheck: true },
      include: ['scripts/tests/**/*.ts'], exclude: [] },
  };
  const configFile: Record<ProjectName, string> = {
    services: 'tsconfig.runtime.json', node: 'tsconfig.node.json', tests: 'tsconfig.tests.json', browser: 'tsconfig.browser-tools.json',
  };
  for (const project of Object.keys(configs) as ProjectName[]) write(configFile[project], JSON.stringify(configs[project]));
  write('package.json', JSON.stringify({ name: 'isolated-typescript-fixture', private: true, type: 'commonjs' }));
  write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {} }));
  write('services/value.ts', 'export const serviceValue: number = 1;\n');
  write('server/value.ts', 'export const value: number = 41;\n');
  write('server.ts', "import { value } from './server/value';\nexport = { value };\n");
  write('scripts/tests/probe.ts', 'export const value: number = 7;\n');
  // These are separate classic scripts served on different pages, not one global module.
  write('tools/one.ts', "const label: string = 'one'; document.title = label;\n");
  write('tools/two.ts', "const label: string = 'two'; document.title = label;\n");
  return {
    root, write,
    read: (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8'),
    exists: (relative: string) => fs.existsSync(path.join(root, relative)),
    remove: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('clean source checkout builds working CommonJS and independent classic browser scripts', async () => {
  const f = fixture();
  try {
    const { buildProjects } = await builder;
    const result = buildProjects(f.root, { quiet: true });
    assert.deepEqual(result.map(item => [item.project, item.sources, item.outputs, item.cached]), [
      ['services', 1, 2, false], ['node', 2, 2, false], ['tests', 1, 1, false], ['browser', 2, 2, false],
    ]);
    const value = execFileSync(process.execPath,
      ['-e', 'process.stdout.write(String(require(process.argv[1]).value))', path.join(f.root, 'server.js')], { encoding: 'utf8' });
    assert.equal(value, '41');
    assert.match(f.read('services/value.d.ts'), /serviceValue/);
    for (const file of ['tools/one.js', 'tools/two.js']) {
      assert.doesNotMatch(f.read(file), /\b(?:exports|require)\b/);
      assert.match(f.read(file), /document\.title = label/);
    }
    assert.ok(buildProjects(f.root, { quiet: true }).every(item => item.cached));
  } finally { f.remove(); }
});

test('read-only check leaves both generated files and build cache absent', async () => {
  const f = fixture();
  try {
    const { buildProjects } = await builder;
    const result = buildProjects(f.root, { quiet: true, check: true });
    assert.ok(result.every(item => item.outputs === 0 && !item.cached));
    assert.equal(f.exists('server.js'), false);
    assert.equal(f.exists('services/value.js'), false);
    assert.equal(f.exists('tools/one.js'), false);
    assert.equal(f.exists('.cache'), false);
  } finally { f.remove(); }
});

test('type errors in any selected project prevent publication of all project outputs', async () => {
  const f = fixture();
  try {
    const { buildProjects } = await builder;
    buildProjects(f.root, { quiet: true });
    const previous = f.read('services/value.js');
    const record = f.read('.cache/typescript-build/services.json');
    f.write('services/value.ts', 'export const serviceValue: number = 2;\n');
    f.write('server/value.ts', "export const value: number = 'invalid';\n");
    assert.throws(() => buildProjects(f.root, { quiet: true }), /not assignable to type 'number'/);
    assert.equal(f.read('services/value.js'), previous);
    assert.equal(f.read('.cache/typescript-build/services.json'), record);
    f.write('server/value.ts', 'export const value: number = 42;\n');
    buildProjects(f.root, { quiet: true });
    assert.match(f.read('services/value.js'), /serviceValue = 2/);
  } finally { f.remove(); }
});

test('browser source imports are checked in the test environment and execute through the preserved native TypeScript path', async () => {
  const f = fixture();
  try {
    const { buildProjects } = await builder;
    // The application is a mixed package: gateway scripts are CommonJS and browser sources use ESM.
    f.write('package.json', JSON.stringify({ name: 'isolated-typescript-fixture', private: true }));
    f.write('src/metadata.json', JSON.stringify({ value: 23 }));
    f.write('src/browser.ts', "import metadata from './metadata.json' with { type: 'json' };\nexport const value: number = metadata.value;\n");
    f.write('scripts/tests/probe.ts', "import { value } from '../../src/browser.ts';\nexport = { value };\n");
    buildProjects(f.root, { quiet: true });
    assert.equal(f.exists('src/browser.js'), false, 'the test compiler must not publish browser runtime files');
    const value = execFileSync(process.execPath,
      ['-e', 'process.stdout.write(String(require(process.argv[1]).value))', path.join(f.root, 'scripts/tests/probe.js')],
      { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    assert.equal(value, '23');
    assert.match(f.read('scripts/tests/probe.js'), /src\/browser\.ts/);
  } finally { f.remove(); }
});

test('a failing test type check blocks publication even when services and gateway sources pass', async () => {
  const f = fixture();
  try {
    const { buildProjects } = await builder;
    buildProjects(f.root, { quiet: true });
    const previous = f.read('services/value.js');
    const cache = f.read('.cache/typescript-build/services.json');
    f.write('services/value.ts', 'export const serviceValue: number = 12;\n');
    f.write('scripts/tests/probe.ts', "export const value: number = 'invalid test';\n");
    assert.throws(() => buildProjects(f.root, { quiet: true }), /not assignable to type 'number'/);
    assert.equal(f.read('services/value.js'), previous);
    assert.equal(f.read('.cache/typescript-build/services.json'), cache);
    f.write('scripts/tests/probe.ts', 'export const value: number = 12;\n');
    buildProjects(f.root, { quiet: true });
    assert.match(f.read('services/value.js'), /serviceValue = 12/);
  } finally { f.remove(); }
});

test('source, compiler options, dependency lock and changed or missing outputs invalidate cached builds', async () => {
  const f = fixture();
  try {
    const { buildProjects } = await builder;
    const build = () => buildProjects(f.root, { quiet: true, projects: ['node'] })[0];
    assert.equal(build().cached, false);
    assert.equal(build().cached, true);
    f.write('server/value.ts', 'export const value: number = 42;\n');
    assert.equal(build().cached, false);
    const compiled = f.read('server/value.js');
    f.write('server/value.js', 'module.exports = { value: 0 };\n');
    assert.equal(build().cached, false);
    assert.equal(f.read('server/value.js'), compiled);
    fs.unlinkSync(path.join(f.root, 'server/value.js'));
    assert.equal(build().cached, false);
    assert.equal(f.read('server/value.js'), compiled);
    f.write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {}, fixtureRevision: 1 }));
    assert.equal(build().cached, false);
    const config = JSON.parse(f.read('tsconfig.node.json')) as { compilerOptions: Record<string, any> };
    config.compilerOptions.removeComments = true;
    f.write('tsconfig.node.json', JSON.stringify(config));
    assert.equal(build().cached, false);
    assert.equal(build().cached, true);
    assert.equal(buildProjects(f.root, { quiet: true, projects: ['node'], force: true })[0].cached, false);
  } finally { f.remove(); }
});

test('deleted source removes only its unchanged owned output and preserves unrelated or edited files', async () => {
  const f = fixture();
  try {
    const { buildProjects } = await builder;
    f.write('server/retired.ts', 'export const retired = true;\n');
    f.write('server/edited.ts', 'export const edited = true;\n');
    buildProjects(f.root, { quiet: true, projects: ['node'] });
    f.write('server/edited.js', '// user-owned recovery note\n');
    f.write('server/unrelated.js', '// pre-existing external fixture\n');
    fs.unlinkSync(path.join(f.root, 'server/retired.ts'));
    fs.unlinkSync(path.join(f.root, 'server/edited.ts'));
    buildProjects(f.root, { quiet: true, projects: ['node'] });
    assert.equal(f.exists('server/retired.js'), false);
    assert.equal(f.read('server/edited.js'), '// user-owned recovery note\n');
    assert.equal(f.read('server/unrelated.js'), '// pre-existing external fixture\n');
  } finally { f.remove(); }
});

test('build refuses weakened checking, corrupted caches cannot count as successful verification', async () => {
  const f = fixture();
  try {
    const { buildProjects } = await builder;
    buildProjects(f.root, { quiet: true, projects: ['node'] });
    f.write('.cache/typescript-build/node.json', '{corrupt');
    assert.equal(buildProjects(f.root, { quiet: true, projects: ['node'] })[0].cached, false);
    const config = JSON.parse(f.read('tsconfig.node.json')) as { compilerOptions: Record<string, any> };
    config.compilerOptions.strict = false;
    f.write('tsconfig.node.json', JSON.stringify(config));
    assert.throws(() => buildProjects(f.root, { quiet: true, projects: ['node'] }), /strictly check TypeScript/);
  } finally { f.remove(); }
});
