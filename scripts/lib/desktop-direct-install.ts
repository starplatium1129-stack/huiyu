import fs = require('node:fs');
import path = require('node:path');
import { createHash, randomUUID } from 'node:crypto';
import binding = require('./desktop-build-binding');
import installer = require('./desktop-installer-binding');
import safe = require('./delivery-paths');
import { desktopHostExecutable } from './desktop-build-profile';
import type { FileIdentity } from './delivery-types';
import { errorCode, errorMessage } from './runtime-errors';

type InstallFile = Pick<FileIdentity, 'path' | 'bytes' | 'sha256'>;
type Plan = {
  schemaVersion: 1;
  installDir: string;
  host: FileIdentity;
  files: InstallFile[];
  changed: string[];
};

const stage = 'desktop-tauri/src-tauri/resources';
const hostPath = 'ai-cg-studio-desktop.exe';
const stagedHost = desktopHostExecutable('desktop-local');
const iconPath = 'huiyu-icon.ico';
const deploymentId = /^[0-9a-f]{32}$/;
const hashPattern = /^[0-9a-f]{64}$/;
const gatewayFolders = new Set(['assets', 'data', 'dist', 'docs', 'native', 'native-licenses', 'qq-sdk', 'scripts', 'tools']);
const gatewayFiles = new Set(['bundled-resource-inventory.json', 'huiyu-runtime.exe', 'installer-resource-cleanup.exe',
  'native-dependencies.windows-x64.json', 'remote-scene-recipes.sqlite', 'resource-layers.json', 'rust-runtime-build.json']);

function exactRoot(raw: string) {
  const resolved = path.resolve(raw);
  const disk = path.parse(resolved).root;
  if (resolved === disk || !/^[a-z]:[\\/]$/i.test(disk)) throw Error('本机直写需要 Windows 本地子目录');
  safe.resolveSafe(disk, path.relative(disk, resolved));
  if (!fs.lstatSync(resolved).isDirectory() || fs.realpathSync.native(resolved).toLowerCase() !== resolved.toLowerCase()) {
    throw Error('本机直写目录必须是不含链接的实际目录');
  }
  return resolved;
}

function isIdentity(item: unknown): item is InstallFile {
  return safe.object(item) && typeof item.path === 'string' && typeof item.bytes === 'number'
    && Number.isSafeInteger(item.bytes) && item.bytes >= 0 && typeof item.sha256 === 'string' && hashPattern.test(item.sha256);
}

function managed(relative: string) {
  if (safe.relative(relative) !== relative) return false;
  const [gateway, name, child] = relative.split('/');
  return relative === hostPath || relative === iconPath || (gateway === 'gateway'
    && (child === undefined ? gatewayFiles.has(name) : gatewayFolders.has(name)));
}

function checkPlan(input: unknown, installDir: string): Plan {
  if (!safe.object(input) || input.schemaVersion !== 1 || input.installDir !== installDir || !isIdentity(input.host)
      || (input.host as FileIdentity).status !== 'file' || input.host.path !== stagedHost
      || !Array.isArray(input.files) || !Array.isArray(input.changed)) throw Error('本机部署清单格式无效');
  const names = new Set<string>();
  for (const file of input.files) {
    if (!isIdentity(file) || !managed(file.path) || names.has(file.path.toLowerCase())) throw Error('本机部署清单文件无效或重复');
    names.add(file.path.toLowerCase());
  }
  for (const required of [hostPath, iconPath, 'gateway/huiyu-runtime.exe', 'gateway/installer-resource-cleanup.exe',
    'gateway/native/libvips-42.dll', 'gateway/bundled-resource-inventory.json', 'gateway/data/catalog/manifest.json']) {
    if (!names.has(required)) throw Error(`本机部署清单缺少 ${required}`);
  }
  const exactNames = new Set(input.files.map((file: InstallFile) => file.path));
  if (new Set(input.changed).size !== input.changed.length || input.changed.some(name => !exactNames.has(name))) {
    throw Error('本机部署改动清单未绑定到已核验文件');
  }
  return input as Plan;
}

function planRelative(id: string) {
  if (!deploymentId.test(id)) throw Error('无效的本机部署编号');
  return `runtime/desktop-deploy-packages/${id}/local-plan.json`;
}

async function prepare(root: string, installDir: string, id: string) {
  const name = planRelative(id);
  let receipt;
  try { receipt = await binding.verifyBuildParallel(root, undefined, 'desktop-local'); }
  catch (error) { return { mode: 'build', reason: errorMessage(error) }; }
  const { files } = installer.installedBuildFiles(root, receipt);
  const host = (receipt.build.entries as FileIdentity[]).find(entry => entry.path === stagedHost);
  const detail = await installer.compareInstalledFilesParallel(files, installDir);
  if (detail.unsafePaths.length) throw Error(`安装路径含链接、硬链接或不可读文件：${detail.unsafePaths.slice(0, 5).join(', ')}`);
  const plan = checkPlan({ schemaVersion: 1, installDir, host, files, changed: detail.mismatchPaths }, installDir);
  const directory = safe.resolveSafe(root, path.posix.dirname(name), true);
  fs.mkdirSync(safe.resolveSafe(root, 'runtime/desktop-deploy-packages', true), { recursive: true });
  fs.mkdirSync(directory);
  const bytes = JSON.stringify(plan);
  fs.writeFileSync(safe.resolveSafe(root, name, true), bytes, { flag: 'wx' });
  return { mode: detail.mismatchCount ? 'direct' : 'current', id, changed: detail.mismatchCount, files: detail.fileCount, sha256: safe.sha256(bytes) };
}

function chooseTarget(root: string, relative: string) {
  const target = safe.resolveSafe(root, relative, true);
  try {
    const stat = fs.lstatSync(target, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw Error(`安装目标不是无硬链接的普通文件：${relative}`);
    return { target, stat };
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error;
    return { target, stat: undefined };
  }
}

// Both staging and rollback copies read from a checked descriptor. A later
// replacement of a source path cannot change bytes that were already bound.
function copyFile(root: string, relative: string, target: string, expected?: InstallFile) {
  const scan = safe.pathScan(root);
  const { file, stat } = scan(relative);
  if (!stat.isFile() || stat.nlink !== 1n) throw Error(`不是无硬链接的普通文件：${relative}`);
  const source = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (!safe.sameFile(stat, fs.fstatSync(source, { bigint: true }))) throw Error(`文件打开期间发生变化：${relative}`);
    const destination = fs.openSync(target, 'wx');
    try {
      const digest = expected ? createHash('sha256') : undefined;
      const buffer = Buffer.allocUnsafe(256 * 1024);
      let bytes = 0;
      for (let count; (count = fs.readSync(source, buffer, 0, buffer.length, null)) > 0;) {
        digest?.update(buffer.subarray(0, count));
        for (let offset = 0; offset < count;) offset += fs.writeSync(destination, buffer, offset, count - offset);
        bytes += count;
      }
      if (BigInt(bytes) !== stat.size || !safe.sameFile(stat, fs.fstatSync(source, { bigint: true }))
          || !safe.sameFile(stat, scan(relative).stat)) throw Error(`文件读取期间发生变化：${relative}`);
      if (expected && (bytes !== expected.bytes || digest?.digest('hex') !== expected.sha256)) {
        throw Error(`候选文件与本机部署清单不一致：${relative}`);
      }
    } finally { fs.closeSync(destination); }
  } finally { fs.closeSync(source); }
  return stat;
}

function loadPlan(root: string, installDir: string, id: string, expectedHash: string) {
  const record = safe.readJson(root, planRelative(id));
  if (!hashPattern.test(expectedHash) || record.entry.sha256 !== expectedHash) throw Error('本机部署清单已变化');
  return checkPlan(record.value, installDir);
}

async function apply(root: string, installDir: string, id: string, expectedHash: string) {
  const plan = loadPlan(root, installDir, id, expectedHash);
  const scratch = safe.resolveSafe(installDir, `.huiyu-local-${randomUUID()}`, true);
  fs.mkdirSync(scratch);
  const scratchFiles: string[] = [];
  const applied: { relative: string; backup?: string }[] = [];
  let keepBackups = false;
  try {
    const changed = new Set(plan.changed);
    const prepared = plan.files.filter(file => changed.has(file.path)).map((file, i) => {
      const relative = file.path;
      const next = path.join(scratch, `${i}.next`);
      scratchFiles.push(next);
      if (relative === hostPath) {
        const bytes = installer.installedHostBytes(root, plan.host);
        if (bytes.length !== file.bytes || safe.sha256(bytes) !== file.sha256) throw Error('候选宿主与 NSS 清单不一致');
        fs.writeFileSync(next, bytes, { flag: 'wx' });
      } else {
        const source = relative === iconPath ? 'desktop-tauri/src-tauri/icons/icon.ico' : `${stage}/${relative}`;
        copyFile(root, source, next, file);
      }
      const previous = chooseTarget(installDir, relative);
      const backup = previous.stat ? path.join(scratch, `${i}.previous`) : undefined;
      if (backup) scratchFiles.push(backup);
      const previousStat = backup ? copyFile(installDir, relative, backup) : undefined;
      return { relative, next, backup, previousStat };
    });
    // Publish the launcher after the files it opens on startup.
    prepared.sort((left, right) => Number(left.relative === hostPath) - Number(right.relative === hostPath));
    for (const entry of prepared) {
      const { relative, next, backup, previousStat } = entry;
      const { target, stat } = chooseTarget(installDir, relative);
      if (previousStat ? !stat || !safe.sameFile(previousStat, stat) : stat) throw Error(`安装目标在部署期间发生变化：${relative}`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const pending = chooseTarget(installDir, path.relative(installDir, next));
      if (!pending.stat) throw Error(`暂存文件已消失：${relative}`);
      fs.renameSync(pending.target, chooseTarget(installDir, relative).target);
      applied.push({ relative, backup });
    }
    const detail = await installer.compareInstalledFilesParallel(plan.files, installDir);
    if (detail.mismatchCount) throw Error(`安装后文件与绑定清单不一致：${detail.mismatches.join(', ')}`);
    return { files: detail.fileCount, changed: applied.length };
  } catch (error) {
    const failures = [];
    for (const { relative, backup } of applied.reverse()) {
      try {
        const { target, stat } = chooseTarget(installDir, relative);
        if (backup) fs.renameSync(backup, target);
        else if (stat) fs.unlinkSync(target);
      } catch (rollbackError) { failures.push(`${relative}: ${errorMessage(rollbackError)}`); }
    }
    if (failures.length) {
      keepBackups = true;
      throw Error(`${errorMessage(error)}。部分文件无法回滚，备份在 ${scratch}：${failures.join('；')}`, { cause: error });
    }
    throw error;
  } finally {
    if (!keepBackups) {
      for (const owned of scratchFiles) {
        try { fs.unlinkSync(owned); } catch (error) { if (errorCode(error) !== 'ENOENT') console.error(errorMessage(error)); }
      }
      try { fs.rmdirSync(scratch); } catch (error) { if (errorCode(error) !== 'ENOENT') console.error(errorMessage(error)); }
    }
  }
}

async function main() {
  const [action, worktree, installed, id, sha256] = process.argv.slice(2);
  if (!worktree || !installed || !id) throw Error('需要工作区、已登记安装目录和部署编号');
  const root = exactRoot(worktree);
  const installDir = exactRoot(installed);
  let result;
  if (action === 'prepare') result = await prepare(root, installDir, id);
  else if (action === 'validate' && sha256) result = { files: loadPlan(root, installDir, id, sha256).files.length };
  else if (action === 'apply' && sha256) result = await apply(root, installDir, id, sha256);
  else throw Error('仅支持 prepare、validate 或 apply');
  console.log(JSON.stringify(result));
}

if (require.main === module) main().catch((error: unknown) => { console.error(errorMessage(error)); process.exitCode = 1; });
