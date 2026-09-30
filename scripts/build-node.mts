import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

/** Bootstrap from TypeScript itself; works on a clean checkout before any JS exists. */
export const PROJECTS = {
  services: 'tsconfig.runtime.json',
  node: 'tsconfig.node.json',
  tests: 'tsconfig.tests.json',
  browser: 'tsconfig.browser-tools.json',
} as const;
type ProjectName = keyof typeof PROJECTS;
interface BuildOptions { check?: boolean; force?: boolean; projects?: ProjectName[]; quiet?: boolean }
const filesystemMethods = ['readFile', 'fileExists', 'directoryExists', 'getDirectories', 'realpath', 'readDirectory'] as const;
type FilesystemMethod = typeof filesystemMethods[number];
interface FilesystemQuery { method: FilesystemMethod; args: unknown[]; value: string }
interface BuildRecord { version: 2; fingerprint: string; queries: FilesystemQuery[]; outputs: Record<string, string> }
interface BuildManifest { outputs: Record<string, string>; cache?: BuildRecord }
interface BuildResult { project: ProjectName; sources: number; outputs: number; cached: boolean }

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
const posix = (value: string) => value.replaceAll('\\', '/');
const isRecord = (value: any): value is Record<string, any> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[], root: string): string {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n',
  });
}

export function loadProject(root: string, project: ProjectName): ts.ParsedCommandLine {
  const file = path.join(root, PROJECTS[project]);
  const loaded = ts.readConfigFile(file, ts.sys.readFile);
  if (loaded.error) throw new Error(formatDiagnostics([loaded.error], root));
  const parsed = ts.parseJsonConfigFileContent(loaded.config, ts.sys, root, undefined, file);
  if (parsed.errors.length) throw new Error(formatDiagnostics(parsed.errors, root));
  if (!parsed.options.strict || parsed.options.noCheck || parsed.options.allowJs) {
    throw new Error(`${PROJECTS[project]} must strictly check TypeScript sources`);
  }
  if (!parsed.fileNames.length) throw new Error(`${PROJECTS[project]} contains no sources`);
  return parsed;
}

function relativeInside(root: string, file: string): string {
  const relative = posix(path.relative(root, file));
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error(`Build output escapes the project: ${file}`);
  }
  return relative;
}

function canonicalRelative(relative: string): boolean {
  return !!relative && !path.isAbsolute(relative) && !path.win32.isAbsolute(relative)
    && !/[\\:\x00-\x1f]/.test(relative)
    && !relative.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part));
}

/** Generated outputs and cache records must never write through filesystem aliases. */
function buildPath(root: string, relative: string): string {
  if (!canonicalRelative(relative)) throw new Error(`Build path escapes the project: ${relative}`);
  let current = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return path.join(root, relative);
    if (stat.isSymbolicLink()) throw new Error(`Build path uses a symbolic link or junction: ${relative}`);
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error(`Build parent is not a directory: ${relative}`);
    if (index === parts.length - 1 && (!stat.isFile() || stat.nlink > 1)) {
      throw new Error(`Build target must be a regular file without hard links: ${relative}`);
    }
  }
  return current;
}

function outputForSource(source: string): string {
  return source.replace(/\.mts$/, '.mjs').replace(/\.cts$/, '.cjs').replace(/\.ts$/, '.js');
}

function readManifest(file: string): BuildManifest | undefined {
  try {
    const value: any = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isRecord(value) || !isRecord(value.outputs)
      || !Object.values(value.outputs).every(item => typeof item === 'string')) return;
    const current = value.version === 2 && typeof value.fingerprint === 'string'
      && Array.isArray(value.queries) && value.queries.length > 0
      && value.queries.every((query: unknown) => isRecord(query) && filesystemMethods.includes(query.method)
        && Array.isArray(query.args) && typeof query.args[0] === 'string' && typeof query.value === 'string');
    // Output ownership survives cache invalidation. Only the current input
    // schema can certify a hit; unchanged orphan outputs can still be retired.
    return { outputs: value.outputs, cache: current ? value as unknown as BuildRecord : undefined };
  } catch { return; }
}

function filesystemValue(method: FilesystemMethod, value: unknown): string {
  return method === 'readFile' && typeof value === 'string' ? digest(value) : JSON.stringify(value) ?? 'undefined';
}

/** Replay the compiler's reads and resolution probes before allocating another AST.
 * Missing candidates, directory enumeration and package metadata matter too: a new
 * source can change module resolution even when every previously read file is unchanged.
 */
function inputsCurrent(queries: FilesystemQuery[]): boolean {
  try {
    return queries.every(query => {
      const operation = ts.sys[query.method];
      return operation && filesystemValue(query.method,
        Reflect.apply(operation, ts.sys, query.args.map(arg => arg === null ? undefined : arg))) === query.value;
    });
  } catch { return false; }
}

function recordingHost(options: ts.CompilerOptions, queries: Map<string, FilesystemQuery>): ts.CompilerHost {
  const host = ts.createCompilerHost(options);
  for (const method of filesystemMethods) {
    const operation = host[method];
    if (!operation) continue;
    Object.assign(host, { [method]: (...args: unknown[]) => {
      const value: unknown = Reflect.apply(operation, host, args);
      queries.set(JSON.stringify([method, args]), { method, args, value: filesystemValue(method, value) });
      return value;
    } });
  }
  return host;
}

function sourceForOutput(relative: string): string {
  return relative.replace(/\.d\.ts$/, '.ts').replace(/\.mjs$/, '.mts')
    .replace(/\.cjs$/, '.cts').replace(/\.js$/, '.ts');
}

function ownedOutput(project: ProjectName, relative: string): boolean {
  if (!canonicalRelative(relative) || !/\.(?:[cm]?js|d\.ts)$/.test(relative)) return false;
  if (project === 'services') return relative.startsWith('services/');
  if (project === 'browser') return /^(?:tools\/|assets\/theme-bootstrap\.|docs\/guides\/prompts\/)/.test(relative);
  if (project === 'tests') return relative.startsWith('scripts/tests/');
  return /^(?:server\.|server\/|routes\/|scripts\/|poc\/|eslint\.config\.)/.test(relative)
    && !relative.startsWith('scripts/archive/') && !relative.startsWith('scripts/tests/') && !relative.includes('/vendor/');
}

/** No output is published until every selected project passes type checking. */
export function buildProjects(root: string, options: BuildOptions = {}): BuildResult[] {
  root = fs.realpathSync(root);
  const pending: Array<{ project: ProjectName; recordFile: string; previous?: BuildManifest;
    record: BuildRecord; contents: Map<string, string> }> = [];
  const results: BuildResult[] = [];
  const lock = path.join(root, 'package-lock.json');
  const builderHash = digest(fs.readFileSync(fileURLToPath(import.meta.url)));
  const dependencyHash = fs.existsSync(lock) ? digest(fs.readFileSync(lock)) : null;
  for (const project of options.projects || Object.keys(PROJECTS) as ProjectName[]) {
    const parsed = loadProject(root, project);
    const fingerprint = digest(JSON.stringify({ compiler: ts.version, options: parsed.options,
      builder: builderHash, roots: parsed.fileNames,
      config: fs.readFileSync(path.join(root, PROJECTS[project]), 'utf8'),
      dependencies: dependencyHash }));
    const recordFile = buildPath(root, `.cache/typescript-build/${project}.json`);
    const previous = readManifest(recordFile);
    const cachedRecord = previous?.cache;
    const expected = new Set(parsed.fileNames.filter(file => !file.endsWith('.d.ts'))
      .flatMap(file => {
        const relative = relativeInside(root, outputForSource(file));
        return parsed.options.declaration ? [relative, relative.replace(/\.js$/, '.d.ts')] : [relative];
      }));
    const cached = !options.check && !options.force && cachedRecord?.fingerprint === fingerprint
      && expected.size === Object.keys(cachedRecord.outputs).length
      && inputsCurrent(cachedRecord.queries)
      && [...expected].every(relative => {
        if (!ownedOutput(project, relative) || !cachedRecord.outputs[relative]) return false;
        const file = buildPath(root, relative);
        return fs.existsSync(file) && digest(fs.readFileSync(file)) === cachedRecord.outputs[relative];
      });
    if (cached) {
      results.push({ project, sources: parsed.fileNames.length, outputs: expected.size, cached: true });
      continue;
    }
    // Classic browser scripts execute on different pages, in their own scopes.
    const groups = project === 'browser' ? parsed.fileNames.map(file => [file]) : [parsed.fileNames];
    const isolatedEmit = project === 'node' || project === 'tests';
    const queries = new Map<string, FilesystemQuery>();
    const compilerOptions = { ...parsed.options, noEmit: isolatedEmit,
      ...(isolatedEmit ? { isolatedModules: true, allowImportingTsExtensions: true } : {}),
      noEmitOnError: true, sourceMap: false, declarationMap: false, incremental: false };
    const programs = groups.map(files => ts.createProgram(files, compilerOptions, recordingHost(compilerOptions, queries)));
    const contents = new Map<string, string>();
    const ownedSources = new Set(parsed.fileNames.map(file => path.resolve(file)));
    for (const program of programs) {
      const diagnostics = ts.getPreEmitDiagnostics(program);
      if (diagnostics.length) throw new Error(formatDiagnostics(diagnostics, root));
      if (options.check) continue;
      if (isolatedEmit) {
        // Full strict checking above includes native TypeScript imports from test helpers.
        // Isolated modules can then be transformed without rewriting those working paths.
        for (const sourceFile of parsed.fileNames.filter(file => !file.endsWith('.d.ts'))) {
          const source = program.getSourceFile(sourceFile);
          if (!source) throw new Error(`Missing checked source: ${sourceFile}`);
          const result = ts.transpileModule(source.text, {
            fileName: sourceFile,
            reportDiagnostics: true,
            compilerOptions: { ...parsed.options, noEmit: false, noEmitOnError: false,
              ...(project === 'tests' ? { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext } : {}),
              isolatedModules: true, allowImportingTsExtensions: false, declaration: false,
              declarationMap: false, sourceMap: false, incremental: false },
          });
          if (result.diagnostics?.length) throw new Error(formatDiagnostics(result.diagnostics, root));
          const relative = relativeInside(root, outputForSource(sourceFile));
          if (!ownedOutput(project, relative)) throw new Error(`Unexpected ${project} output: ${relative}`);
          contents.set(relative, result.outputText);
        }
        continue;
      }
      const emitted = program.emit(undefined, (file, text, _bom, _error, sourceFiles) => {
        // Pure type imports from the SPA, and services built by their own project,
        // participate in checking but must not create a second set of runtime files.
        if (!sourceFiles?.some(source => ownedSources.has(path.resolve(source.fileName)))) return;
        const relative = relativeInside(root, file);
        if (!ownedOutput(project, relative)) throw new Error(`Unexpected ${project} output: ${relative}`);
        contents.set(relative, text);
      });
      if (emitted.emitSkipped || emitted.diagnostics.length) throw new Error(formatDiagnostics(emitted.diagnostics, root) || `Emit failed: ${project}`);
    }
    if (!options.check) {
      if (expected.size !== contents.size || [...expected].some(relative => !contents.has(relative))) {
        throw new Error(`${project}: source/output inventory is incomplete`);
      }
      pending.push({ project, recordFile, previous, contents, record: { version: 2, fingerprint, queries: [...queries.values()],
        outputs: Object.fromEntries([...contents].map(([file, text]: any) => [file, digest(text)])) } });
    }
    results.push({ project, sources: parsed.fileNames.length, outputs: options.check ? 0 : contents.size, cached: false });
  }
  // Preflight every managed path before publishing any selected project's files.
  for (const item of pending) {
    for (const relative of new Set([...item.contents.keys(), ...Object.keys(item.previous?.outputs || {})])) {
      if (ownedOutput(item.project, relative)) buildPath(root, relative);
    }
  }
  for (const item of pending) {
    for (const [relative, text] of item.contents) {
      const file = buildPath(root, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      buildPath(root, relative);
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) fs.writeFileSync(file, text, 'utf8');
    }
    for (const [relative, hash] of Object.entries(item.previous?.outputs || {})) {
      if (item.contents.has(relative) || !ownedOutput(item.project, relative)
        || fs.existsSync(path.join(root, sourceForOutput(relative)))) continue;
      const file = buildPath(root, relative);
      // Only remove a stale output previously produced by this builder, unchanged.
      if (fs.existsSync(file) && digest(fs.readFileSync(file)) === hash) fs.unlinkSync(file);
    }
    fs.mkdirSync(path.dirname(item.recordFile), { recursive: true });
    buildPath(root, relativeInside(root, item.recordFile));
    fs.writeFileSync(item.recordFile, `${JSON.stringify(item.record, null, 2)}\n`);
  }
  if (!options.quiet) for (const result of results) {
    console.log(`[typescript] ${result.project}: ${result.sources} sources; ${options.check ? 'checked' : result.cached ? 'current' : `${result.outputs} outputs built`}`);
  }
  return results;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const options: BuildOptions = {};
    for (let index = 2; index < process.argv.length; index++) {
      const argument = process.argv[index];
      if (argument === '--check') options.check = true;
      else if (argument === '--force') options.force = true;
      else if (argument === '--project') {
        const project = process.argv[++index];
        if (!project || !(project in PROJECTS)) throw new Error('Project must be services, node, tests, or browser');
        (options.projects ||= []).push(project as ProjectName);
      } else if (argument === '--help' || argument === '--plan') {
        console.log('build-node.mts [--check] [--force] [--project services|node|tests|browser]\nStrictly check and compile source files in place. --check writes nothing.\nProjects: ' + Object.values(PROJECTS).join(', '));
        process.exit(0);
      } else throw new Error(`Unknown argument: ${argument}`);
    }
    buildProjects(defaultRoot, options);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
