import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import { spawnSync } from 'node:child_process';
import identity = require('./delivery-identity');
import safe = require('./delivery-paths');
import dataVersion = require('./data-version');
import { desktopHostExecutable } from './desktop-build-profile';
import { COMPRESSIBLE } from './precompressed-artifacts';
import type { Selection, Snapshot } from './delivery-types';

const hostExe = desktopHostExecutable('desktop-local');
const uiTrees = ['dist', 'desktop-tauri/web'];
const uiOutputs: Selection[] = uiTrees.map(path => ({ kind: 'tree', path }));
const hostOutputs: Selection[] = [{ kind: 'file', path: hostExe }];
const uiSections = ['src/', 'public/', 'css/', 'assets/chibi/', 'types/'];
const uiFiles = new Set([
  'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json', 'tsconfig.app.json',
  'index.html', 'companion.html', 'resource-assistant.html', 'try.html',
  'assets/favicon.svg', 'assets/logo.svg', 'assets/logo-light.svg', 'assets/theme-bootstrap.js',
  'data/popular-onboarding.json', 'data/presets.json', 'data/tags-dictionary.json',
  'scripts/lib/data-version.ts', 'scripts/lib/page-bundle-report.ts', 'scripts/lib/precompressed-artifacts.ts',
  'scripts/maintenance/check-bundle-budget.ts', 'scripts/maintenance/precompress.ts',
]);
const viteEnvFiles = ['.env', '.env.local', '.env.production', '.env.production.local', '.env.desktop', '.env.desktop.local'];
const viteEnvPattern = /^(?:VITE_|BROWSERSLIST|NODE_ENV$|NODE_OPTIONS$)/i;
const nativeEnvPattern = /^(?:TAURI_|AICS_BUNDLED_UI_VERIFIED$|CARGO_(?:HOME$|BUILD_|TARGET_|PROFILE_)|RUST(?:FLAGS|C|UP_TOOLCHAIN$)|(?:CC|CXX|AR|CFLAGS|CXXFLAGS|LDFLAGS)(?:_|$)|LIB(?:PATH)?$|INCLUDE$|LINK$)/i;

export type LocalBuildInputs = { frontend: string; host: string; data?: string };
type LocalReuse = { build: Snapshot; inputs: LocalBuildInputs };

function digest(value: unknown) {
  return safe.sha256(safe.canonical(value));
}

function relevantEnv(env: NodeJS.ProcessEnv, pattern: RegExp) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => pattern.test(key)));
}

function fileInputs(root: string, names: string[]) {
  const scan = safe.pathScan(root);
  return names.sort().map(name => {
    const entry = safe.fileEntry(root, name, scan);
    if (entry.status !== 'file' && entry.status !== 'missing') throw Error(`Unsafe desktop build input: ${name}`);
    return entry.status === 'file' ? [entry.path, entry.bytes, entry.sha256] : [entry.path, null];
  });
}

function frontendEnvAndData(root: string) {
  return fileInputs(root, [...viteEnvFiles, ...dataVersion.VERSIONED_FILES.map(file => `data/${file}`)]);
}

function frontendInput(root: string, source: Snapshot, env: NodeJS.ProcessEnv) {
  const entries = source.entries.filter(({ path }) => uiFiles.has(path) || uiSections.some(prefix => path.startsWith(prefix))
    // Static JSON modules are imported from these runtime source trees.
    || (/^(runtime-rs\/src\/|tools\/inference\/).*\.json$/i.test(path)));
  // Vite copies public/ itself, including any local files ignored by Git.
  const publicFiles = identity.snapshot(root, [{ kind: 'tree', path: 'public' }]);
  if (publicFiles.status !== 'complete') throw Error('Unsafe or missing frontend public inputs');
  return digest({ entries, publicFiles: publicFiles.sha256, external: frontendEnvAndData(root),
    versions: process.versions, env: relevantEnv(env, viteEnvPattern) });
}

function dataCompressionState(root: string) {
  const directory = safe.resolveSafe(root, 'data');
  const names = fs.readdirSync(directory).filter(name => COMPRESSIBLE.test(name.replace(/\.(?:br|gz)$/i, '')));
  // Only root-level data sidecars are eligible for the desktop resource map.
  return digest(fileInputs(root, names.map(name => `data/${name}`)));
}

function cargoConfigInputs(root: string, env: NodeJS.ProcessEnv) {
  const directories = new Set<string>([path.join(root, 'desktop-tauri/src-tauri'), path.join(root, 'desktop-tauri'), root]);
  for (let parent = path.dirname(root); !directories.has(parent); parent = path.dirname(parent)) {
    directories.add(parent);
    if (parent === path.dirname(parent)) break;
  }
  const configs = [...directories].map(directory => path.join(directory, '.cargo'));
  configs.push(env.CARGO_HOME || path.join(os.homedir(), '.cargo'));
  return [...new Set(configs)].map(directory => {
    if (!fs.existsSync(directory)) return [directory, null];
    // Cargo may load either spelling. Record both; any unsafe config disables reuse.
    if (fs.lstatSync(directory).isSymbolicLink()) throw Error('Unsafe Cargo configuration directory');
    return [directory, fileInputs(safe.rootPath(directory), ['config', 'config.toml'])];
  });
}

function hostToolchain(root: string, env: NodeJS.ProcessEnv) {
  const options = { cwd: path.join(root, 'desktop-tauri'), env, encoding: 'utf8', windowsHide: true } as const;
  const rustc = spawnSync(env.RUSTC || env.CARGO_BUILD_RUSTC || 'rustc', ['-vV'], options);
  const cargo = spawnSync('cargo', ['-V'], options);
  if (rustc.status !== 0 || cargo.status !== 0) return;
  return [rustc.stdout.trim(), cargo.stdout.trim(), cargoConfigInputs(root, env)];
}

function hostInput(root: string, source: Snapshot, sdk: string, ui: Snapshot, args: string[], env: NodeJS.ProcessEnv) {
  try {
    const toolchain = hostToolchain(root, env);
    if (!toolchain) return;
    // Gateway resources are copied beside the EXE. Tauri only embeds frontendDist.
    const sources = source.entries.filter(({ path }) => path.startsWith('desktop-tauri/src-tauri/')
      || path.startsWith('desktop-tauri/native-live2d/') || path === 'package-lock.json');
    return digest({
      sources, sdk, toolchain, args, env: relevantEnv(env, nativeEnvPattern),
      web: projection(ui, [{ kind: 'tree', path: 'desktop-tauri/web' }]),
    });
  } catch { return; }
}

function readLocalReuse(root: string, receiptPath: string): LocalReuse | undefined {
  try {
    const { value } = safe.readJson(root, receiptPath, true);
    if (value.schemaVersion !== 1 || value.kind !== 'desktop-build-binding' || value.buildProfile !== 'desktop-local') return;
    const inputs = value.localInputs;
    if (!safe.object(inputs) || typeof inputs.frontend !== 'string' || !identity.HASH.test(inputs.frontend)
      || typeof inputs.host !== 'string' || !identity.HASH.test(inputs.host)) return;
    const build = identity.validateSnapshot(value.build);
    if (build.status !== 'complete') return;
    return { build, inputs: { frontend: inputs.frontend, host: inputs.host, data: typeof inputs.data === 'string' ? inputs.data : undefined } };
  } catch { return; }
}

function projection(build: Snapshot, outputs: Selection[]) {
  return build.entries.filter(entry => outputs.some(({ kind, path }) => entry.path === path || (kind === 'tree' && entry.path.startsWith(`${path}/`))));
}

function matchOutputs(current: Snapshot, previous: Snapshot, outputs: Selection[]) {
  return current.status === 'complete' && digest(projection(current, outputs)) === digest(projection(previous, outputs));
}

function assertBoundOutputs(final: Snapshot, ui: Snapshot, reusedHost?: Snapshot) {
  if (!matchOutputs(final, ui, uiOutputs) || (reusedHost && !matchOutputs(final, reusedHost, hostOutputs))) {
    throw Error('桌面前端或复用宿主在构建期间发生变化，请重新构建');
  }
}

export { assertBoundOutputs, dataCompressionState, frontendInput, hostInput, hostOutputs, matchOutputs, readLocalReuse, uiOutputs };
