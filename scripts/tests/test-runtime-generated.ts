import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import ts from 'typescript';

const root = path.resolve(__dirname, '../..');

test('developer tool outputs match their sources and remain outside Git', async () => {
  const { PROJECTS, loadProject } = await import('../build-node.mjs');
  const expected = new Set<string>();
  const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0'));
  for (const project of Object.keys(PROJECTS) as Array<keyof typeof PROJECTS>) {
    const parsed = loadProject(root, project);
    for (const source of parsed.fileNames.filter(file => !file.endsWith('.d.ts'))) {
      const output = source.replace(/\.mts$/, '.mjs').replace(/\.cts$/, '.cjs').replace(/\.ts$/, '.js');
      const relative = path.relative(root, output).replaceAll('\\', '/');
      assert.ok(!expected.has(relative), `duplicate output owner: ${relative}`);
      expected.add(relative);
      assert.equal(tracked.has(relative), false, `generated output is tracked: ${relative}`);
      const emitted = ts.transpileModule(fs.readFileSync(source, 'utf8'), {
        fileName: source,
        compilerOptions: { ...parsed.options, noEmit: false, noEmitOnError: false,
          ...(project === 'tests' ? { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext } : {}),
          isolatedModules: true, allowImportingTsExtensions: false, declaration: false,
          declarationMap: false, sourceMap: false, incremental: false },
      }).outputText;
      assert.ok(fs.existsSync(output), `missing output; run build:runtime: ${relative}`);
      assert.equal(fs.readFileSync(output, 'utf8'), emitted, `stale output; run build:runtime: ${relative}`);
    }
  }
  function inspect(directory: string): void {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'archive' || entry.name === 'node_modules') continue;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) inspect(file);
      else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) {
        const relative = path.relative(root, file).replaceAll('\\', '/');
        assert.ok(expected.has(relative) || tracked.has(relative), `orphan tool output: ${relative}`);
      }
    }
  }
  for (const directory of ['scripts', 'tools']) inspect(path.join(root, directory));
});
