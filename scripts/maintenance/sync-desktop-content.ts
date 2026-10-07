/**
 * sync-desktop-content.ts — 同步仍按文件维护的 data/ 到桌面个人内容目录。
 *
 * 完整安装与增量部署只更新安装目录 gateway\data，已有个人文件数据需显式同步。
 * 人物/服装/场景/蓝图由 content/catalog.sqlite 管理；快照、旧分片和聚合文件
 * 不参与本入口同步，记录变更应通过内容库快照预览/导入交付。
 *
 * 边界：
 * - 从桌面打包白名单中排除上述记录域；覆盖前备份，目标独有文件保留并报告。
 * - 不调用模型、不安装、不改安装目录、不动用户作品（history/projects/prompts 等）。
 * - 默认只读预览；写盘与清缓存需显式开关。
 *
 * 用法：
 *   node scripts/maintenance/sync-desktop-content.js                 # 只读预览差异
 *   node scripts/maintenance/sync-desktop-content.js --apply          # 复制缺失/变更文件
 *   node scripts/maintenance/sync-desktop-content.js --apply --clear-webview-cache
 *   node scripts/maintenance/sync-desktop-content.js --content-root=<目录> --source=<目录>
 */
'use strict';

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const crypto: typeof import('node:crypto') = require('node:crypto');
const zlib: typeof import('node:zlib') = require('node:zlib');
const io: typeof import('../lib/maintenance-recovery-fs') = require('../lib/maintenance-recovery-fs');
const { includeData }: typeof import('./desktop-stage-resources') = require('./desktop-stage-resources');

const ROOT = path.resolve(__dirname, '..', '..');
const WEBVIEW_CACHE_DIRS = ['Cache', 'Code Cache', 'GPUCache'];
// Catalog migration.rs / views.rs: four record kinds and their seed/export projections.
// References, tag shards and file-backed policy/model metadata still have consumers.
const CATALOG_RECORD_DIRS = new Set(['catalog', 'popular', 'scenes', 'blueprints']);
const CATALOG_RECORD_FILES = new Set(['characters.json', 'popular-characters.json', 'scene-blueprints.json',
  'scenes.json', 'scenes-nene.json', 'scenes-natsume.json', 'scenes-shared.json', 'scenes-core.json', 'scenes-index.json']);
function catalogRecordPath(relative: string): boolean {
  const name = process.platform === 'win32' ? relative.toLowerCase() : relative;
  return CATALOG_RECORD_DIRS.has(name.split('/')[0]!) || CATALOG_RECORD_FILES.has(name.replace(/\.(br|gz)$/i, ''));
}

/** 目标个人内容目录：打包版网关的 content_root/data。 */
function defaultContentRoot(): string {
  const configured = process.env.AICS_DESKTOP_CONFIG_ROOT;
  if (configured && path.isAbsolute(configured)) return path.join(configured, 'gateway', 'content', 'data');
  const namespace = process.env.AICS_DESKTOP_NAMESPACE || 'com.aics.studio';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(namespace)) throw new Error('桌面命名空间无效');
  const appData = process.env.APPDATA || '';
  if (!appData) throw new Error('APPDATA 不可用；请用 --content-root 显式指定目标目录');
  return path.join(appData, namespace, 'gateway', 'content', 'data');
}
function defaultWebviewRoot(): string | null {
  const configured = process.env.AICS_DESKTOP_WEBVIEW_DATA_DIR;
  if (configured && path.isAbsolute(configured)) return path.join(configured, 'EBWebView', 'Default');
  const namespace = process.env.AICS_DESKTOP_NAMESPACE || 'com.aics.studio';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(namespace)) throw new Error('桌面命名空间无效');
  const local = process.env.LOCALAPPDATA || '';
  return local ? path.join(local, namespace, 'EBWebView', 'Default') : null;
}
function walk(dir: string, base = '', source = false): string[] {
  io.safePath(dir, 'directory', false);
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = base ? `${base}/${entry.name}` : entry.name;
    if (catalogRecordPath(relative)) continue;
    const full = path.join(dir, entry.name);
    if (source && !includeData(relative.split('/'), full)) continue;
    if (source) io.safePath(full, entry.isDirectory() ? 'directory' : 'file', false);
    if (entry.isDirectory()) out.push(...walk(full, relative, source));
    else out.push(relative);
  }
  return out;
}
function assertStopped(target: string) {
  const content = path.dirname(target);
  if (io.safePath(path.join(content, 'runtime', 'maintenance-transactions', 'lease'), 'directory')) {
    throw new Error('CONTENT_BUSY: 内容维护事务尚未释放，请先完成维护或恢复');
  }
  if (io.keyPath(path.basename(content)) !== 'content' || io.keyPath(path.basename(path.dirname(content))) !== 'gateway') return;
  const config = path.resolve(content, '../..');
  const capability = path.join(config, 'desktop-maintenance.json');
  if (io.safePath(capability)) {
    const { hostPid } = io.readJson(capability);
    if (!Number.isInteger(hostPid) || hostPid <= 0) throw new Error('DESKTOP_IDENTITY_INVALID: 宿主身份无效');
    let alive = true;
    try { process.kill(hostPid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; else throw error; }
    if (alive) throw new Error('DESKTOP_RUNNING: 请先从托盘正常退出桌面端，再同步内容或清理缓存');
  }
  for (const name of ['workspace-active.json', 'workspace-candidate.json']) {
    const pointer = path.join(config, name);
    if (!io.safePath(pointer)) continue;
    const { workspaceId } = io.readJson(pointer);
    if (typeof workspaceId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workspaceId)) throw new Error('WORKSPACE_POINTER_INVALID');
    if (io.safePath(path.join(config, 'workspaces', workspaceId, '.workspace-owner.json'))) throw new Error('WORKSPACE_LOCK_REMAINS: 请先完成桌面端退出或工作区恢复');
  }
}

function main(args = process.argv.slice(2)) {
  if (args.includes('--help')) {
    console.log('sync-desktop-content [--apply] [--clear-webview-cache] [--content-root=DIR] [--source=DIR] [--webview-root=DIR]\n'
      + '仅同步参考、标签等文件维护域；跳过人物/服装/场景/蓝图，不更新 catalog.sqlite；\n'
      + '默认只读预览；--apply 先备份覆盖项，再原子写入差异文件（不删除目标文件）；\n'
      + '--clear-webview-cache 另外删除 WebView2 的 Cache / Code Cache / GPUCache。');
    return;
  }
  const value = (name: string) => {
    const arg = args.find(a => a.startsWith(`--${name}=`));
    if (arg && !arg.slice(name.length + 3)) throw new Error(`--${name} 不能为空`);
    return arg?.slice(name.length + 3);
  };
  for (const arg of args) {
    if (arg === '--apply' || arg === '--clear-webview-cache') continue;
    if (/^--(content-root|source|webview-root)=/.test(arg)) continue;
    throw new Error(`Unknown option: ${arg}`);
  }
  const source = path.resolve(value('source') || path.join(ROOT, 'data'));
  const target = path.resolve(value('content-root') || defaultContentRoot());
  io.safePath(source, 'directory', false);
  if (io.samePath(source, target) || io.within(source, target) || io.within(target, source)) throw new Error('源与目标目录不能重叠');
  if (!io.safePath(target, 'directory')) {
    console.log(`[desktop:content-sync] 目标个人内容目录不存在（应用首次启动会自动播种）: ${target}`);
    return;
  }
  const sourceFiles = walk(source, '', true);
  const targetFiles = walk(target);
  const sourceSet = new Set(sourceFiles);
  const changes = sourceFiles.flatMap(file => {
    const bytes = io.readBytes(path.join(source, file)) as Buffer;
    if (/\.(br|gz)$/i.test(file)) {
      const raw = io.readBytes(path.join(source, file.replace(/\.(br|gz)$/i, ''))) as Buffer;
      const decoded = /\.gz$/i.test(file) ? zlib.gunzipSync(bytes) : zlib.brotliDecompressSync(bytes);
      if (!raw.equals(decoded)) throw new Error(`预压内容与源不一致，请先重新预压: ${file}`);
    }
    const previous = io.readBytes(path.join(target, file), true) as Buffer | null;
    return previous?.equals(bytes) ? [] : [{ file, bytes, previous }];
  });
  const toAdd = changes.filter(change => change.previous === null);
  const toUpdate = changes.filter(change => change.previous !== null);
  const targetOnly = targetFiles.filter(file => !sourceSet.has(file));
  const cacheRoot = args.includes('--clear-webview-cache') ? value('webview-root') || defaultWebviewRoot() : null;
  const caches: string[] = [];
  if (cacheRoot) {
    for (const name of WEBVIEW_CACHE_DIRS) {
      const directory = path.resolve(cacheRoot, name);
      if (io.safePath(directory, 'directory')) caches.push(directory);
    }
  }

  console.log('[desktop:content-sync] 仅同步文件维护域；已跳过人物/服装/场景/蓝图，记录变更请使用内容库快照导入。');
  console.log(`[desktop:content-sync] 源=${source}`);
  console.log(`[desktop:content-sync] 目标=${target}`);
  console.log(`[desktop:content-sync] 源文件 ${sourceFiles.length}；目标文件 ${targetFiles.length}；新增 ${toAdd.length}；更新 ${toUpdate.length}；目标多余 ${targetOnly.length}`);
  if (targetOnly.length) {
    console.log('[desktop:content-sync] 目标目录多余项（不自动删除，需人工判断是否为仓库已删除的遗留）：');
    for (const file of targetOnly.slice(0, 40)) console.log(`  - ${file}`);
    if (targetOnly.length > 40) console.log(`  … 另有 ${targetOnly.length - 40} 项`);
  }
  if (!args.includes('--apply')) {
    console.log('[desktop:content-sync] 预览模式：未写入。加 --apply 复制差异文件。');
  } else {
    assertStopped(target);
    const backup = path.join(path.dirname(target), 'content-sync-backups', crypto.randomUUID());
    if (toUpdate.length) {
      for (const { file, previous } of toUpdate) io.atomicWrite(path.join(backup, file), previous, true);
      io.atomicWrite(path.join(backup, 'sync-manifest.json'), Buffer.from(JSON.stringify({ target, added: toAdd.map(change => change.file), updated: toUpdate.map(change => change.file) }, null, 2) + '\n'), true);
      console.log(`[desktop:content-sync] 覆盖前原字节备份（可恢复）: ${backup}`);
    }
    // A running application must be closed by its owner. Refuse concurrent edits
    // rather than silently replacing bytes that were not included in the backup.
    for (const { file, previous } of changes) {
      const current = io.readBytes(path.join(target, file), true) as Buffer | null;
      if (previous === null ? current !== null : !current?.equals(previous)) throw new Error(`CONTENT_CHANGED: 同步期间目标发生变化，未覆盖: ${file}`);
    }
    for (const { file, bytes, previous } of changes) {
      const current = io.readBytes(path.join(target, file), true) as Buffer | null;
      if (previous === null ? current !== null : !current?.equals(previous)) throw new Error(`CONTENT_CHANGED: 同步期间目标发生变化，未覆盖: ${file}`);
      io.atomicWrite(path.join(target, file), bytes, true);
    }
    console.log(`[desktop:content-sync] 已复制 ${changes.length} 个文件（未删除任何目标文件）`);
  }
  if (args.includes('--clear-webview-cache')) {
    if (!cacheRoot) { console.log('[desktop:content-sync] 跳过缓存清理：无法确定 WebView2 根目录'); return; }
    assertStopped(target);
    let cleared = 0;
    for (const dir of caches) {
      io.safePath(dir, 'directory', false);
      fs.rmSync(dir, { recursive: true, force: true });
      cleared += 1;
    }
    console.log(`[desktop:content-sync] 已清理 ${cleared} 个 WebView2 缓存目录（${WEBVIEW_CACHE_DIRS.join(' / ')}）`);
  }
  if (args.includes('--apply') || args.includes('--clear-webview-cache')) {
    console.log('[desktop:content-sync] 完成后需要重启桌面端才会重新读取数据。');
  }
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(`[desktop:content-sync] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
}

export = { main };
