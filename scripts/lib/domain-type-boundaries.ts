import fs = require('node:fs');
import path = require('node:path');
import { isBuiltin } from 'node:module';
import ts = require('typescript');
import { parse } from 'vue/compiler-sfc';
import { sourceDependencies } from './source-imports';

export interface ModuleEdge {
  from: string;
  specifier: string;
  typeOnly: boolean;
  to?: string;
  external?: boolean;
}
export interface BoundaryReport {
  files: string[];
  edges: ModuleEdge[];
  violations: string[];
  unknown: string[];
  runtimeCycles: string[][];
  typeCycles: string[][];
}

/** Only the migrated domain surface is guarded; unrelated legacy modules are not scanned. */
export const DOMAIN_TYPE_ROOTS = ['src/types/promptHistory.ts', 'src/types/artwork.ts', 'src/types/generation.ts', 'src/types/anima.ts', 'src/utils/resultContext.ts'];
export const ARTWORK_USE_CASE_ROOTS = ['src/application/artwork/saveGeneratedArtwork.ts'];
const slash = (file: string) => file.replace(/\\/g, '/');
const forbiddenPath = /^(src\/(stores|composables|components|views|router|storage|api)(\/|\.)|routes\/)/;
const framework = /^(vue|pinia|vue-router)(\/|$)/;

function imports(source: string, file: string, unknown: string[]): ModuleEdge[] {
  const edges: ModuleEdge[] = [];
  const scan = (text: string, name: string) => {
    for (const edge of sourceDependencies(text, name)) {
      if (edge.specifier === null) unknown.push(file + ': non-literal ' + (edge.typeOnly ? 'type' : 'runtime') + ' import');
      else edges.push({ from: file, specifier: edge.specifier, typeOnly: edge.typeOnly });
    }
  };
  if (file.endsWith('.vue')) {
    const { descriptor, errors } = parse(source, { filename: file });
    for (const error of errors) unknown.push(`${file}: invalid SFC: ${String(error)}`);
    for (const block of [descriptor.script, descriptor.scriptSetup]) {
      if (!block) continue;
      if (block.src) edges.push({ from: file, specifier: block.src, typeOnly: false });
      scan(block.content, `${file}.${block.lang || 'js'}`);
    }
  } else scan(source, file);
  return edges;
}

function findCycles(edges: ModuleEdge[], runtimeOnly: boolean): string[][] {
  const adjacency = new Map<string, ModuleEdge[]>();
  for (const edge of edges) {
    if (!edge.to || edge.external || (runtimeOnly && edge.typeOnly)) continue;
    adjacency.set(edge.from, [...(adjacency.get(edge.from) || []), edge]);
  }
  const active: string[] = [], visited = new Set<string>(), cycles: string[][] = [];
  const visit = (file: string) => {
    const index = active.indexOf(file);
    if (index >= 0) { cycles.push([...active.slice(index), file]); return; }
    if (visited.has(file)) return;
    visited.add(file);
    active.push(file);
    for (const edge of adjacency.get(file) || []) visit(edge.to!);
    active.pop();
  };
  for (const file of adjacency.keys()) visit(file);
  return cycles;
}

/** Read source only. Resolve aliases through the real app tsconfig and traverse re-exports too. */
export function inspectModuleBoundaries(root: string, entries = [...DOMAIN_TYPE_ROOTS, ...ARTWORK_USE_CASE_ROOTS]): BoundaryReport {
  const report: BoundaryReport = { files: [], edges: [], violations: [], unknown: [], runtimeCycles: [], typeCycles: [] };
  root = fs.realpathSync(root);
  const configPath = path.join(root, 'tsconfig.app.json');
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  if (config.error) {
    report.unknown.push(ts.flattenDiagnosticMessageText(config.error.messageText, '\n'));
    return report;
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  for (const error of parsed.errors) report.unknown.push(ts.flattenDiagnosticMessageText(error.messageText, '\n'));
  const options = parsed.options;
  // TS probes Foo.d.vue.ts for an explicitly imported .vue file. Supply a virtual
  // declaration candidate, then inspect the original SFC's real script blocks.
  const vueSource = (file: string) => file.replace(/\.d\.vue\.ts$/, '.vue').replace(/\.vue\.ts$/, '.vue');
  const host: ts.ModuleResolutionHost = {
    ...ts.sys,
    fileExists: file => ts.sys.fileExists(file) || (vueSource(file) !== file && ts.sys.fileExists(vueSource(file))),
  };
  const localName = (file: string) => slash(path.relative(root, file));
  const seen = new Set<string>();
  const visit = (input: string) => {
    let absolute: string;
    try { absolute = fs.realpathSync(input); } catch {
      report.unknown.push(`${localName(input)}: missing source`);
      return;
    }
    const file = localName(absolute);
    if (seen.has(absolute)) return;
    seen.add(absolute);
    if (file.startsWith('../') || path.isAbsolute(file)) {
      report.unknown.push(`${file}: local source outside root`);
      return;
    }
    if (forbiddenPath.test(file)) {
      report.violations.push(`${file}: pure artwork modules reach state/presentation/infrastructure`);
      return;
    }
    // Test fixtures, vendored code, data and generated-only files are not counted
    // as inspected domain sources. A reachable excluded edge remains visible.
    if (/(^|\/)vendor\//.test(file) || /\.(spec|test)\.[cm]?[jt]sx?$/.test(file)
      || !/\.(vue|[cm]?[jt]sx?)$/.test(file)) {
      report.unknown.push(`${file}: reachable source outside checked scope`);
      return;
    }
    report.files.push(file);
    for (const edge of imports(fs.readFileSync(absolute, 'utf8'), file, report.unknown)) {
      report.edges.push(edge);
      if (framework.test(edge.specifier)) {
        report.violations.push(`${file}: ${edge.typeOnly ? 'type' : 'runtime'} dependency on ${edge.specifier}`);
        continue;
      }
      if (isBuiltin(edge.specifier)) {
        edge.external = true;
        if (!edge.typeOnly) report.violations.push(`${file}: runtime platform dependency on ${edge.specifier}`);
        continue;
      }
      const resolved = ts.resolveModuleName(edge.specifier, absolute, options, host).resolvedModule;
      if (!resolved) {
        report.unknown.push(`${file}: cannot resolve ${edge.specifier}`);
        continue;
      }
      let target = resolved.resolvedFileName;
      if (!fs.existsSync(target)) target = vueSource(target);
      if (!fs.existsSync(target)) {
        report.unknown.push(`${file}: missing resolved source for ${edge.specifier}`);
        continue;
      }
      target = fs.realpathSync(target);
      edge.to = localName(target);
      if (resolved.isExternalLibraryImport || slash(target).includes('/node_modules/')) {
        edge.external = true;
        if (/\/node_modules\/(vue|pinia|vue-router|@vue\/[^/]+)\//.test(slash(target))) {
          report.violations.push(`${file}: framework dependency via ${edge.specifier}`);
        }
        continue;
      }
      visit(target);
    }
  };
  for (const file of entries) visit(path.resolve(root, file));
  report.runtimeCycles = findCycles(report.edges, true);
  const runtimeKeys = new Set(report.runtimeCycles.map(cycle => [...new Set(cycle)].sort().join('|')));
  report.typeCycles = findCycles(report.edges, false)
    .filter(cycle => !runtimeKeys.has([...new Set(cycle)].sort().join('|')));
  report.files.sort();
  return report;
}
