'use strict';

const fs = (require('node:fs') as typeof import('node:fs'));
const path = (require('node:path') as typeof import('node:path'));
const { spawnSync } = (require('node:child_process') as typeof import('node:child_process'));
const ts = (require('typescript') as typeof import('typescript'));

function toPosix(filePath: string) {
  return filePath.replaceAll(path.sep, '/');
}

function formatDiagnostics(diagnostics: readonly import('typescript').Diagnostic[], root: string) {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (fileName: any) => fileName,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n',
  });
}

function parseRuntimeConfig(root: string) {
  const configPath = path.join(root, 'tsconfig.runtime.json');
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) throw new Error(formatDiagnostics([loaded.error], root));

  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root, undefined, configPath);
  if (parsed.errors.length > 0) throw new Error(formatDiagnostics(parsed.errors, root));
  return parsed;
}

function isInside(directory: string, filePath: string) {
  const relative = path.relative(directory, filePath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function outputRelative(sourceFile: string, servicesRoot: string, extension: string) {
  return toPosix(path.relative(servicesRoot, sourceFile).replace(/\.ts$/, extension));
}

function getRuntimeGeneratedInventory(root: string) {
  const parsed = parseRuntimeConfig(root);
  const servicesRoot = path.resolve(root, parsed.options.rootDir || 'services');
  const sourceFiles = parsed.fileNames
    .filter((filePath: any) => filePath.endsWith('.ts') && !filePath.endsWith('.d.ts') && isInside(servicesRoot, filePath))
    .sort();

  if (sourceFiles.length === 0) {
    throw new Error('tsconfig.runtime.json does not include any services TypeScript sources');
  }

  const javascriptFiles = sourceFiles.map((sourceFile: any) => outputRelative(sourceFile, servicesRoot, '.js'));
  const declarationFiles = sourceFiles.map((sourceFile: any) => outputRelative(sourceFile, servicesRoot, '.d.ts'));

  return {
    parsed,
    servicesRoot,
    sourceFiles,
    javascriptFiles: javascriptFiles.sort(),
    declarationFiles: declarationFiles.sort(),
    generatedFiles: [...javascriptFiles, ...declarationFiles].sort(),
  };
}

function listGeneratedFiles(directory: string, prefix: any = ''): string[] {
  if (!fs.existsSync(directory)) return [];

  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listGeneratedFiles(fullPath, relative));
    } else if (/\.(?:js|d\.ts)$/.test(entry.name)) {
      files.push(toPosix(relative));
    }
  }
  return files.sort();
}

function listTrackedGeneratedFiles(root: string, servicesRoot: string) {
  const servicesRelative = toPosix(path.relative(root, servicesRoot)) || '.';
  const result = spawnSync('git', ['ls-files', '-z', '--', servicesRelative], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ls-files failed with exit=${result.status}: ${result.stderr.trim()}`);
  }

  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map((relativePath: any) => path.resolve(root, relativePath))
    .filter((filePath: any) => isInside(servicesRoot, filePath))
    .map((filePath: any) => toPosix(path.relative(servicesRoot, filePath)))
    .filter((relativePath: any) => /\.(?:js|d\.ts)$/.test(relativePath))
    .sort();
}

function difference(left: readonly string[], right: readonly string[]) {
  const rightSet = new Set(right);
  return left.filter((item: any) => !rightSet.has(item)).sort();
}

function auditGeneratedFileSets(expected: readonly string[], onDisk: readonly string[], tracked: readonly string[]) {
  return {
    missing: difference(expected, onDisk),
    orphan: difference(onDisk, expected),
    untracked: difference(onDisk, tracked),
    expectedUntracked: difference(expected, tracked),
    trackedOrphan: difference(tracked, expected),
  };
}

function emitRuntime(root: string, inventory: ReturnType<typeof getRuntimeGeneratedInventory>, outputRoot: string) {
  const options = {
    ...inventory.parsed.options,
    noEmit: false,
    outDir: outputRoot,
    declaration: true,
    sourceMap: false,
    declarationMap: false,
  };
  const program = ts.createProgram(inventory.sourceFiles, options);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length > 0) throw new Error(formatDiagnostics(diagnostics, root));
  const emitted = program.emit();
  if (emitted.diagnostics.length > 0) throw new Error(formatDiagnostics(emitted.diagnostics, root));
  return emitted;
}

function findByteDrift(files: readonly string[], committedRoot: string, emittedRoot: string) {
  return files.filter((relativePath: any) => {
    const committed = fs.readFileSync(path.join(committedRoot, relativePath));
    const emitted = fs.readFileSync(path.join(emittedRoot, relativePath));
    return !committed.equals(emitted);
  });
}

export = {
  auditGeneratedFileSets,
  emitRuntime,
  findByteDrift,
  getRuntimeGeneratedInventory,
  listGeneratedFiles,
  listTrackedGeneratedFiles,
};
