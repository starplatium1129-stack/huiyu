#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { errorMessage } from '../lib/runtime-errors';

const ROOT = fs.realpathSync(path.resolve(__dirname, '..', '..'));
const RUNTIME = path.join(ROOT, 'runtime');
const DATA = path.join(ROOT, 'data');
const UPDATES = path.join(RUNTIME, 'desktop-updates');
const ARCHIVE = path.join(ROOT, 'scripts', 'archive');

const PROTECTED_DIR = /^(?:\.git|\.cache|ai|catalog-backups|checkpoints|content|content-sync-backups|delivery-evidence|desktop-build-cache|desktop-build-sdk|desktop-deploy-logs|desktop-deploy-packages|desktop-updates|downloads|git-backups|history|inference|jobs|keys|live2d-imports|logs|maintenance-backups|models|node_modules|outputs|pose-openpose-full|projects|render-batch|review|scene-repair|state|translation|user-data|user-workspace|workspace)$/i;
const PROTECTED_FILE = /^(?:ai-workspace\.json|desktop-deploy-last\.log|desktop-deploy-build\.log|offline-install-pending\.json|desktop-deploy-timing\.json|desktop-deploy\.lock|\.env(?:\..*)?)$|\.(?:sqlite3?|db)(?:[-.].*)?$|\.(?:safetensors|ckpt|gguf|onnx|bin|pt|pth|keras|h5|pb|npz|pkl|joblib|weights|tflite)$|\.model3\.json$/i;
const EXPERIMENT = /^(?:tmp-|anima-|adult-blueprint-|functional-|frontend-|moss-|natsume-|nene-|roxy-|gpu-|native-|character-|recipe-|showcase-|catalog-|upstream-|h3-|wan-|adult-|qq-|release-|python-|manga-|ui-|global-|voice-|reart-|muse-|priority-|perf(?:$|[-_.])|phase\d*(?:$|[-_.])|desktop-(?:png-cache|reference-sync)$)/i;
const TEMP_FILE = /\.(?:log|jsonl?|png|jpe?g|webp|py|m?js|cjs|patch|txt|headers|md|html|zip)$/i;
const EXPERIMENTS = new Set([
  'short-film', 'arknights-flowingpoints-ref', 'krea150w_vs_500w', 'ling_ab_test',
  'hires-compare', 'krea2_ab', 'design-sheet-test', 'showcase-temp', 'tmp-perf-test',
]);
const ARCHIVES = new Set(['huiyu-v4-final-bundle.zip', 'local-studio-audit-code.zip']);
const CATALOG_STAGE = /^\.catalog-export-(backup-)?[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const CATALOG_LOCK = '.catalog-export.lock';
const INSTALLER = /^(AI-CG-Studio_(\d+\.\d+\.\d+)_x64(?:-full|-upgrade|-local-upgrade)?-setup\.exe)(?:\.(?:deployment\.json|sha256|sig))?$/i;
const VERSION = /^\d+\.\d+\.\d+$/;

interface Entry {
  locations: string[];
  kind: 'experiment' | 'installer' | 'catalog' | 'catalog-lock' | 'archive';
  version?: string;
}

interface ScannedPath {
  target: string;
  stat: fs.Stats;
}

function pathKey(target: string): string {
  return process.platform === 'win32' ? target.toLowerCase() : target;
}

function relative(target: string): string {
  return path.relative(ROOT, target).replaceAll(path.sep, '/');
}

function list(parent: string): fs.Dirent[] {
  if (!fs.existsSync(parent) || pathKey(fs.realpathSync(parent)) !== pathKey(parent)) return [];
  return fs.readdirSync(parent, { withFileTypes: true });
}

function isExperiment(name: string): boolean {
  return EXPERIMENTS.has(name.toLowerCase()) || EXPERIMENT.test(name);
}

function runtimeEntries(): Entry[] {
  return list(RUNTIME).flatMap(entry => {
    const { name } = entry;
    // Keep private state and unknown root inputs out of the candidate list.
    if (PROTECTED_DIR.test(name) || PROTECTED_FILE.test(name)) return [];
    const location = path.join(RUNTIME, name);
    if (entry.isDirectory() && isExperiment(name)) return [{ locations: [location], kind: 'experiment' as const }];
    if (entry.isFile() && TEMP_FILE.test(name) &&
        (isExperiment(name) || /\.(?:log|patch)$/i.test(name) || ARCHIVES.has(name.toLowerCase()))) {
      return [{ locations: [location], kind: 'experiment' as const }];
    }
    return [];
  });
}

function readJson(target: string): unknown {
  if (!fs.existsSync(target)) return null;
  if (pathKey(fs.realpathSync(target)) !== pathKey(target)) throw Error('JSON 路径经过链接');
  return JSON.parse(fs.readFileSync(target, 'utf8'));
}

function protectedLocations(): string[] {
  const desktopConfig = process.env.AICS_DESKTOP_CONFIG_ROOT ||
    (process.env.APPDATA && path.join(process.env.APPDATA, 'com.aics.studio'));
  const workspaceFile = desktopConfig && path.join(desktopConfig, 'ai-workspace.json');
  const workspace = workspaceFile && fs.existsSync(workspaceFile)
    ? readJson(path.resolve(workspaceFile)) : null;
  const desktopWorkspace = workspace && typeof workspace === 'object' && 'root' in workspace &&
    typeof workspace.root === 'string' ? workspace.root : undefined;
  const configuredRuntime = process.env.AICS_RUNTIME_ROOT && path.resolve(process.env.AICS_RUNTIME_ROOT);
  const targets = [
    desktopConfig, desktopWorkspace, process.env.AI_WORKSPACE_ROOT,
    process.env.COMFYUI_MODELS_ROOT, process.env.AICS_PIXAI_MODEL_DIR,
    process.env.AICS_ASSETS_ROOT, process.env.AICS_CHARACTER_REF_ROOT,
    configuredRuntime && pathKey(configuredRuntime) !== pathKey(RUNTIME) ? configuredRuntime : undefined,
  ];
  return targets.filter((target): target is string => Boolean(target)).flatMap(target => {
    const resolved = path.resolve(target);
    return fs.existsSync(resolved) ? [pathKey(resolved), pathKey(fs.realpathSync(resolved))] : [pathKey(resolved)];
  });
}

function overlaps(left: string, right: string): boolean {
  return left === right || left.startsWith(right + path.sep) || right.startsWith(left + path.sep);
}

function readVersion(target: string): string | undefined {
  const metadata = readJson(target);
  if (metadata && typeof metadata === 'object' && 'version' in metadata &&
      typeof metadata.version === 'string' && VERSION.test(metadata.version)) return metadata.version;
}

function keptInstallerVersions(versions: Iterable<string>): Set<string> {
  const ordered = [...new Set(versions)].sort((left, right) =>
    right.localeCompare(left, 'en', { numeric: true }));
  const current = readVersion(path.join(ROOT, 'package.json'));
  const latestPath = path.join(UPDATES, 'latest.json');
  const published = readVersion(latestPath);
  if (!current || (fs.existsSync(latestPath) && !published)) {
    throw new Error('无法核实当前安装包或自动更新版本');
  }
  return new Set([...ordered.slice(0, 2), current, ...(published ? [published] : [])]);
}

function installerEntries(): Entry[] {
  const groups = new Map<string, Entry>();
  for (const entry of list(UPDATES)) {
    const match = INSTALLER.exec(entry.name);
    if (!match) continue;
    const [, filename, version] = match;
    const key = filename.toLowerCase();
    const candidate: Entry = groups.get(key) ?? { locations: [], kind: 'installer', version };
    candidate.locations.push(path.join(UPDATES, entry.name));
    groups.set(key, candidate);
  }
  const candidates = [...groups.values()];
  for (const candidate of candidates) {
    // If Windows has an old installer open, keep its matching sidecars.
    candidate.locations.sort((left, right) => Number(!/\.exe$/i.test(left)) - Number(!/\.exe$/i.test(right)));
  }
  if (!candidates.length) return [];
  const keep = keptInstallerVersions(candidates.flatMap(entry => entry.version ?? []));
  return candidates.filter(entry => entry.version && !keep.has(entry.version));
}

function catalogEntries(): Entry[] {
  const candidates: Entry[] = [];
  const manifest = path.join(DATA, 'catalog', 'manifest.json');
  const hasExport = fs.existsSync(manifest) && pathKey(fs.realpathSync(manifest)) === pathKey(manifest);
  for (const entry of list(DATA)) {
    const match = CATALOG_STAGE.exec(entry.name);
    if (entry.isDirectory() && match && (!match[1] || (process.platform === 'win32' && hasExport))) {
      candidates.push({ locations: [path.join(DATA, entry.name)], kind: 'catalog' });
    } else if (entry.isFile() && entry.name === CATALOG_LOCK && process.platform === 'win32') {
      // Rust opens this empty file with share_mode(0). Windows prohibits
      // unlinking it while even a newly started exporter holds that handle.
      candidates.push({ locations: [path.join(DATA, entry.name)], kind: 'catalog-lock' });
    }
  }
  return candidates;
}

function inspect(entry: Entry, tracked: Set<string>, protectedPaths: string[]): ScannedPath[] {
  if (entry.kind === 'catalog' && process.platform === 'win32') {
    // Check before handling old export backups: a live rename can create a
    // backup whose directory still has the original snapshot's old mtime.
    const lock = path.join(DATA, CATALOG_LOCK);
    if (fs.existsSync(lock)) {
      if (pathKey(fs.realpathSync(lock)) !== pathKey(lock)) throw Error('导出锁经过链接');
      fs.closeSync(fs.openSync(lock, 'r'));
    }
  }
  const scanned: ScannedPath[] = [];
  const pending = [...entry.locations];
  while (pending.length) {
    const target = pending.pop()!;
    const rel = relative(target);
    const name = path.basename(target);
    if (!rel || rel.startsWith('../') || path.isAbsolute(rel) ||
        tracked.has(pathKey(rel)) || PROTECTED_DIR.test(name) || PROTECTED_FILE.test(name) ||
        protectedPaths.some(dir => overlaps(pathKey(target), dir)) ||
        pathKey(fs.realpathSync(target)) !== pathKey(target)) {
      throw Error('包含受保护、受版本管理或经过链接的路径');
    }
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) ||
        (stat.isDirectory() && ['installer', 'catalog-lock'].includes(entry.kind)) ||
        (stat.isFile() && entry.kind === 'catalog' && !/\.json(?:\.(?:br|gz))?$/i.test(name)) ||
        (entry.kind === 'catalog-lock' && stat.size !== 0)) {
      throw Error('包含不符合临时产物结构的路径');
    }
    if (entry.kind === 'catalog-lock') fs.closeSync(fs.openSync(target, 'r'));
    scanned.push({ target, stat });
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(target)) pending.push(path.join(target, child));
    }
  }
  return scanned;
}

function newestActivity(entry: Entry, scanned: ScannedPath[]): number {
  const sourceFiles = new Set(scanned.filter(({ stat }) => stat.isFile()).map(({ target }) => pathKey(target)));
  return scanned.reduce((latest, { target, stat }) => {
    if (entry.kind === 'catalog' && target !== entry.locations[0]) {
      // Interrupted exports can pick up precompressed sidecars from older build tools.
      if (stat.isDirectory() || (/\.(?:br|gz)$/i.test(target) && sourceFiles.has(pathKey(target.replace(/\.(?:br|gz)$/i, ''))))) return latest;
    }
    return Math.max(latest, stat.mtimeMs);
  }, 0);
}

function removeInspected(scanned: ScannedPath[]): void {
  // Remove only the previously inspected nodes, bottom-up. An unexpected new
  // child prevents rmdir instead of being swept up by a recursive deletion.
  for (const { target, stat } of scanned.reverse()) {
    if (pathKey(fs.realpathSync(target)) !== pathKey(target)) throw Error('清理期间路径变为链接');
    const current = fs.lstatSync(target);
    if (stat.dev !== current.dev || stat.ino !== current.ino || current.isSymbolicLink() ||
        current.isDirectory() !== stat.isDirectory() || (!stat.isDirectory() &&
          (stat.mtimeMs !== current.mtimeMs || stat.size !== current.size))) throw Error('清理期间文件已变化');
    if (current.isDirectory()) fs.rmdirSync(target);
    else fs.unlinkSync(target);
  }
}

function label(entry: Entry): string {
  return entry.locations.map(relative).join(', ');
}

function mib(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(2) + ' MiB';
}

function firstLine(error: unknown): string {
  return errorMessage(error).split('\n')[0];
}

function main(args: string[]): void {
  if (args.includes('--help') || args.includes('-h')) {
    console.log([
      '用法: npm run wf -- runtime:clean -- [--days 14] [--prune] [--include-archive]',
      '默认逐项列出可清理的旧实验、历史安装包与中断导出。保留当前、发布清单和最新两个安装包版本。',
      '加 --prune 执行清理。--include-archive 可额外筛选旧的本地 scripts/archive/。',
    ].join('\n'));
    return;
  }
  const daysIndex = args.indexOf('--days');
  const days = daysIndex < 0 ? 14 : Number(args[daysIndex + 1]);
  if (!Number.isFinite(days) || days <= 0) throw Error('--days 必须是大于 0 的天数');
  const prune = args.includes('--prune');
  const includeArchive = args.includes('--include-archive');
  const cutoff = Date.now() - days * 86_400_000;
  const tracked = new Set(execFileSync('git', [
    'ls-files', '-z', '--', 'runtime', 'data/.catalog-export*', 'scripts/archive',
  ], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean).map(pathKey));
  const protectedPaths = protectedLocations();
  const entries = [...runtimeEntries(), ...catalogEntries()];
  try { entries.push(...installerEntries()); }
  catch (error) { console.log('  [跳过] 安装包：' + firstLine(error)); }
  if (includeArchive && fs.existsSync(ARCHIVE)) entries.push({ locations: [ARCHIVE], kind: 'archive' });

  console.log('[runtime:clean] ' + (prune ? '执行清理' : '仅预览') + '，门槛 ' + days + ' 天');
  let active = 0;
  let previewBytes = 0;
  const reclaimable: Array<{ entry: Entry; bytes: number }> = [];
  for (const entry of entries) {
    try {
      const scanned = inspect(entry, tracked, protectedPaths);
      const newest = newestActivity(entry, scanned);
      if (newest > cutoff) { active++; continue; }
      const bytes = scanned.reduce((sum, { stat }) => sum + (stat.isFile() ? stat.size : 0), 0);
      previewBytes += bytes;
      reclaimable.push({ entry, bytes });
      console.log('  [可清理] ' + label(entry) + ' (' + mib(bytes) + '，最后活动 ' + new Date(newest).toISOString() + ')');
    } catch (error) { console.log('  [跳过] ' + label(entry) + '：' + firstLine(error)); }
  }
  console.log('共 ' + reclaimable.length + ' 项，' + mib(previewBytes) + '，另有 ' + active + ' 项仍活跃。');
  if (!prune) {
    if (reclaimable.length) console.log('确认清单后执行：npm run wf -- runtime:clean -- --days ' + days + ' --prune' +
      (includeArchive ? ' --include-archive' : ''));
    return;
  }

  let removed = 0;
  let freed = 0;
  for (const { entry, bytes } of reclaimable) {
    try {
      if (entry.kind === 'installer') {
        const current = installerEntries().flatMap(item => item.locations);
        if (!entry.locations.every(target => current.includes(target))) throw Error('安装包版本或保留清单已变化');
      }
      const scanned = inspect(entry, tracked, protectedPaths);
      if (newestActivity(entry, scanned) > cutoff) throw Error('预览后有新的活动');
      removeInspected(scanned);
      removed++;
      freed += bytes;
    } catch (error) {
      process.exitCode = 1;
      console.log('  [未完整清理] ' + label(entry) + '：' + firstLine(error));
    }
  }
  console.log('已清理 ' + removed + '/' + reclaimable.length + ' 项，共 ' + mib(freed) + '。');
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(firstLine(error)); process.exitCode = 1; }
}
