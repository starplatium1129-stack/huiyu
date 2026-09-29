/**
 * sync-desktop-content.ts — 把仓库 data/ 同步进桌面端「个人内容目录」。
 *
 * 为什么需要独立入口：打包版网关把 %APPDATA%\<ns>\gateway\content 视为权威内容
 * （runtime-rs/src/config/content.rs：「Existing user content is authoritative across
 * restarts and upgrades」，只在目录缺失时从安装包播种）。完整安装与增量部署都只更新
 * 安装目录的 gateway\data，因此任何纯数据改动（角色、服装、蓝图、场景、参考索引）在
 * 桌面端都不会生效，必须先刷新个人内容目录并清 WebView2 缓存。
 *
 * 边界：
 * - 源固定为仓库 data/（权威源），只增改、**从不删除**目标文件；目标里多出来的文件
 *   作为「陈旧项」列出来供人工判断（安装目录曾残留被仓库删除的旧场景单文件，导致
 *   「单文件与批次文件并存」使维护接口拒绝服务）。
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

const ROOT = path.resolve(__dirname, '..', '..');
const WEBVIEW_CACHE_DIRS = ['Cache', 'Code Cache', 'GPUCache'];

/** 目标个人内容目录：打包版网关的 content_root/data。 */
function defaultContentRoot(): string {
  const namespace = process.env.AICS_DESKTOP_NAMESPACE || 'com.aics.studio';
  const appData = process.env.APPDATA || '';
  if (!appData) throw new Error('APPDATA 不可用；请用 --content-root 显式指定目标目录');
  return path.join(appData, namespace, 'gateway', 'content', 'data');
}
function defaultWebviewRoot(): string | null {
  const namespace = process.env.AICS_DESKTOP_NAMESPACE || 'com.aics.studio';
  const local = process.env.LOCALAPPDATA || '';
  return local ? path.join(local, namespace, 'EBWebView', 'Default') : null;
}
function walk(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const relative = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), relative));
    else out.push(relative);
  }
  return out;
}
function digest(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function sameBytes(a: string, b: string): boolean {
  if (!fs.existsSync(b)) return false;
  const left = fs.statSync(a), right = fs.statSync(b);
  return left.size === right.size && digest(a) === digest(b);
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('sync-desktop-content [--apply] [--clear-webview-cache] [--content-root=DIR] [--source=DIR] [--webview-root=DIR]\n'
      + '默认只读预览差异；--apply 把仓库 data/ 缺失或变更的文件复制进个人内容目录（不删除目标文件）；\n'
      + '--clear-webview-cache 另外删除 WebView2 的 Cache / Code Cache / GPUCache。');
    return;
  }
  const value = (name: string) => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  for (const arg of args) {
    if (arg === '--apply' || arg === '--clear-webview-cache') continue;
    if (/^--(content-root|source|webview-root)=/.test(arg)) continue;
    throw new Error(`Unknown option: ${arg}`);
  }
  const source = path.resolve(value('source') || path.join(ROOT, 'data'));
  const target = path.resolve(value('content-root') || defaultContentRoot());
  if (!fs.existsSync(source)) throw new Error(`源数据目录不存在: ${source}`);
  if (!fs.existsSync(target)) {
    console.log(`[desktop:content-sync] 目标个人内容目录不存在（应用首次启动会自动播种）: ${target}`);
    return;
  }
  if (!fs.statSync(target).isDirectory()) throw new Error(`目标不是目录: ${target}`);

  const sourceFiles = walk(source);
  const targetFiles = walk(target);
  const sourceSet = new Set(sourceFiles);
  const toAdd = sourceFiles.filter(file => !fs.existsSync(path.join(target, file)));
  const toUpdate = sourceFiles.filter(file => !toAdd.includes(file) && !sameBytes(path.join(source, file), path.join(target, file)));
  const targetOnly = targetFiles.filter(file => !sourceSet.has(file));

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
    let copied = 0;
    for (const file of [...toAdd, ...toUpdate]) {
      const from = path.join(source, file), to = path.join(target, file);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      copied += 1;
    }
    console.log(`[desktop:content-sync] 已复制 ${copied} 个文件（未删除任何目标文件）`);
  }
  if (args.includes('--clear-webview-cache')) {
    const webviewRoot = value('webview-root') || defaultWebviewRoot();
    if (!webviewRoot) { console.log('[desktop:content-sync] 跳过缓存清理：无法确定 WebView2 根目录'); return; }
    let cleared = 0;
    for (const name of WEBVIEW_CACHE_DIRS) {
      const dir = path.join(webviewRoot, name);
      if (!fs.existsSync(dir)) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      cleared += 1;
    }
    console.log(`[desktop:content-sync] 已清理 ${cleared} 个 WebView2 缓存目录（${WEBVIEW_CACHE_DIRS.join(' / ')}）`);
  }
  if (args.includes('--apply') || args.includes('--clear-webview-cache')) {
    console.log('[desktop:content-sync] 完成后需要重启桌面端才会重新读取数据。');
  }
}

try { main(); } catch (error) { console.error(`[desktop:content-sync] ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }

export {};
