import fs = require('node:fs');
import path = require('node:path');
import { isBuiltin } from 'node:module';
import ts = require('typescript');
import { parse } from 'vue/compiler-sfc';
import { sourceDependencies, type SourceDependency } from './source-imports';

export interface RefactorEdge {
  source: string;
  target: string;
  kind: SourceDependency['kind'];
  typeOnly: boolean;
}
export interface RefactorViolation extends RefactorEdge { rule: string }
export interface RefactorAllowance extends RefactorViolation { exitBatch: string; reason: string }
export interface RefactorReport {
  files: string[];
  edges: RefactorEdge[];
  violations: RefactorViolation[];
  unknown: string[];
}

const slash = (file: string) => file.replace(/\\/g, '/');
const sourceExtension = /\.(?:[cm]?[jt]sx?|vue)$/;
const sourceExcluded = /(?:^|\/)(?:vendor|node_modules)\/|\.(?:spec|test|d)\.[cm]?[jt]sx?$/;
const rawBrowserStorage = /^src\/composables\/use(?:KV|Image)Store\.ts$/;
// These are live browser implementations, not temporary exemptions for UI consumers.
const webStorageAdapters = new Set([
  'src/storage/artworkRepository.ts', 'src/storage/backupRestore.ts', 'src/storage/chatArchiveRepository.ts',
]);

function rules(edge: RefactorEdge): string[] {
  const { source, target, typeOnly } = edge;
  const violations: string[] = [];
  if (/^scripts\/tests\//.test(target) || /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(target)) {
    violations.push('production-no-test-dependency');
  }
  if (/^(?:server\.ts|(?:server|routes|services)\/)/.test(source) && target.startsWith('src/')) {
    violations.push('runtime-no-frontend');
  }
  if (typeOnly) return violations;
  if (rawBrowserStorage.test(target)
    && !webStorageAdapters.has(source) && !source.startsWith('src/platform/web/')) {
    violations.push('browser-storage-port');
  }
  if (source.startsWith('src/application/') && (
    /^src\/(?:storage|api|stores|composables|components|views|router|platform)\//.test(target)
    || /^(?:vue|pinia|vue-router|@tauri-apps)(?:\/|$)/.test(target) || isBuiltin(target))) {
    violations.push('application-no-infrastructure');
  }
  if (!source.startsWith('src/platform/desktop/')
    && /^@tauri-apps\//.test(target)) violations.push('desktop-capability-boundary');
  if (source.startsWith('src/platform/web/') && target.startsWith('src/platform/desktop/')) {
    violations.push('web-no-desktop');
  }
  return violations;
}

/** Scan production imports, including barrels. This does not infer effects of arbitrary calls/globals. */
export function inspectRefactorBoundaries(root: string): RefactorReport {
  root = fs.realpathSync(root);
  const report: RefactorReport = { files: [], edges: [], violations: [], unknown: [] };
  const config = ts.readConfigFile(path.join(root, 'tsconfig.app.json'), ts.sys.readFile);
  if (config.error) {
    report.unknown.push(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
    return report;
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  for (const error of parsed.errors) report.unknown.push(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  const vueSource = (file: string) => file.replace(/\.d\.vue\.ts$/, '.vue').replace(/\.vue\.ts$/, '.vue');
  const host: ts.ModuleResolutionHost = {
    ...ts.sys,
    fileExists: file => ts.sys.fileExists(file) || (vueSource(file) !== file && ts.sys.fileExists(vueSource(file))),
  };
  const localName = (file: string) => slash(path.relative(root, file));
  const collect = (absolute: string) => {
    if (!fs.existsSync(absolute)) return;
    if (fs.statSync(absolute).isDirectory()) {
      for (const child of fs.readdirSync(absolute)) collect(path.join(absolute, child));
      return;
    }
    const file = localName(absolute);
    if (!sourceExtension.test(file) || sourceExcluded.test(file)) return;
    // Never scan emitted siblings as a second authority for the same module.
    if (/\.[cm]?js$/.test(file) && fs.existsSync(absolute.replace(/js$/, 'ts'))) return;
    report.files.push(file);
  };
  for (const entry of ['src', 'server', 'routes', 'services', 'server.ts']) collect(path.join(root, entry));
  report.files.sort();
  const scheduled = new Set(report.files);

  const resolve = (source: string, specifier: string): string | undefined => {
    if (isBuiltin(specifier)) return specifier;
    const input = specifier.startsWith('/src/') ? path.join(root, specifier.slice(1)) : specifier;
    const resolved = ts.resolveModuleName(input, path.join(root, source), parsed.options, host).resolvedModule;
    if (resolved) {
      const candidate = vueSource(resolved.resolvedFileName);
      if (!fs.existsSync(candidate)) {
        report.unknown.push(`${source}: missing resolved source: ${specifier}`);
        return;
      }
      const target = fs.realpathSync(candidate);
      if (resolved.isExternalLibraryImport || slash(target).includes('/node_modules/')) {
        const packagePath = slash(target).split('/node_modules/').pop()!;
        const packageName = packagePath.split('/').slice(0, packagePath.startsWith('@') ? 2 : 1).join('/');
        return specifier === packageName || specifier.startsWith(packageName + '/') ? specifier : packagePath;
      }
      const relative = localName(target);
      if (relative.startsWith('../') || path.isAbsolute(relative)) {
        report.unknown.push(`${source}: source outside repository: ${specifier}`);
        return;
      }
      return relative;
    }
    // CSS/media/data and virtual modules are not executable dependency edges.
    // Missing TS/JS/Vue/extensionless local modules must not silently disappear.
    if (/\.(?:css|scss|less|json|png|jpe?g|webp|svg|gif|ico|woff2?|mp[34]|wav)(?:\?.*)?$/.test(specifier)
      || specifier.startsWith('virtual:')) return specifier;
    if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('@/')
      && !Object.keys(parsed.options.paths || {}).some(alias => specifier.startsWith(alias.split('*')[0]))) {
      return specifier;
    }
    report.unknown.push(`${source}: unresolved import: ${specifier}`);
  };
  const inspect = (source: string, text: string, filename: string) => {
    for (const dependency of sourceDependencies(text, filename)) {
      if (dependency.specifier === null) {
        report.unknown.push(`${source}: non-literal ${dependency.kind} dependency`);
        continue;
      }
      const target = resolve(source, dependency.specifier);
      if (!target) continue;
      const edge: RefactorEdge = { source, target, kind: dependency.kind,
        typeOnly: dependency.typeOnly || /\.d\.[cm]?ts$/.test(source) };
      report.edges.push(edge);
      for (const rule of rules(edge)) report.violations.push({ ...edge, rule });
      if (sourceExtension.test(target) && fs.existsSync(path.join(root, target))
        && !/^scripts\/tests\//.test(target) && !/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(target)) {
        if (/\.d\.[cm]?ts$/.test(target) && !edge.typeOnly) {
          report.unknown.push(`${source}: runtime import of declaration-only source: ${target}`);
        }
        if (!scheduled.has(target)) {
          // Production already uses scripts/lib helpers. Inspect reachable code rather than
          // exempting that directory or dropping vendor/barrel/declaration targets.
          scheduled.add(target);
          report.files.push(target);
        }
      }
    }
  };
  for (const file of report.files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    if (!file.endsWith('.vue')) { inspect(file, text, file); continue; }
    const { descriptor, errors } = parse(text, { filename: file });
    for (const error of errors) report.unknown.push(`${file}: invalid SFC: ${String(error)}`);
    for (const block of [descriptor.script, descriptor.scriptSetup]) {
      if (!block) continue;
      if (block.src) inspect(file, `import ${JSON.stringify(block.src)}`, file + '.ts');
      inspect(file, block.content, `${file}.${block.lang || 'js'}`);
    }
  }
  // Preserve the caller's boundary through shared helpers outside the named roots.
  const adjacency = new Map<string, RefactorEdge[]>();
  for (const edge of report.edges) {
    adjacency.set(edge.source, [...(adjacency.get(edge.source) || []), edge]);
  }
  const seen = new Set<string>();
  const visitWeb = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const edge of adjacency.get(file) || []) {
      if (edge.typeOnly) continue;
      if (edge.target.startsWith('src/platform/desktop/') || edge.target.startsWith('@tauri-apps/')) {
        report.violations.push({ ...edge, rule: 'web-no-desktop' });
      } else visitWeb(edge.target);
    }
  };
  for (const file of report.files.filter(file => file.startsWith('src/platform/web/'))) visitWeb(file);
  const runtimeSeen = new Set<string>();
  const visitRuntime = (file: string) => {
    if (runtimeSeen.has(file)) return;
    runtimeSeen.add(file);
    for (const edge of adjacency.get(file) || []) {
      if (edge.target.startsWith('src/')) report.violations.push({ ...edge, rule: 'runtime-no-frontend' });
      else visitRuntime(edge.target);
    }
  };
  for (const file of report.files.filter(file => /^(?:server\.ts|(?:server|routes|services)\/)/.test(file))) visitRuntime(file);
  report.files.sort();
  report.violations = [...new Map(report.violations.map(edge => [refactorEdgeKey(edge), edge])).values()];
  return report;
}

export function refactorEdgeKey(edge: RefactorViolation): string {
  return JSON.stringify([edge.source, edge.target, edge.kind, edge.typeOnly, edge.rule]);
}
const allowanceKey = (edge: RefactorAllowance) => JSON.stringify([refactorEdgeKey(edge), edge.exitBatch]);

/** ceiling is approved history, never the current candidate list itself. */
export function checkRefactorAllowlist(
  violations: readonly RefactorViolation[], allowances: readonly RefactorAllowance[], ceiling: readonly RefactorAllowance[],
): string[] {
  const errors: string[] = [];
  const approved = new Set(ceiling.map(allowanceKey));
  const current = new Set(violations.map(refactorEdgeKey));
  const allowed = new Set<string>();
  for (const entry of allowances) {
    const key = refactorEdgeKey(entry);
    if (!approved.has(allowanceKey(entry))) errors.push(`unapproved allowance: ${allowanceKey(entry)}`);
    if (allowed.has(key)) errors.push(`duplicate allowance: ${key}`);
    if ([entry.source, entry.target].some(value => !value || /[*?\\]/.test(value)
      || path.posix.normalize(value) !== value || value.startsWith('../') || value.startsWith('/'))
      || !/^R(?:[0-9]|1[01])(?:[a-d])?$/.test(entry.exitBatch) || !entry.reason?.trim()) {
      errors.push(`invalid exact allowance: ${key}`);
    }
    if (!current.has(key)) errors.push(`stale allowance (remove it): ${key}`);
    allowed.add(key);
  }
  for (const edge of violations) {
    const key = refactorEdgeKey(edge);
    if (!allowed.has(key)) errors.push(`new forbidden dependency: ${key}`);
  }
  return [...new Set(errors)];
}
