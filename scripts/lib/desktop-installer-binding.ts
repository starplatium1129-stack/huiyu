import fs = require('node:fs');
import path = require('node:path');
import { createHash, randomUUID } from 'node:crypto';
import identity = require('./delivery-identity');
import safe = require('./delivery-paths');
import type { FileIdentity as SnapshotFile } from './delivery-types';
import { desktopBuildProfile, desktopHostExecutable } from './desktop-build-profile';

type FileIdentity = Pick<SnapshotFile, 'path' | 'bytes' | 'sha256'>;
type DeploymentManifest = { schemaVersion: 1; kind: 'desktop-installer-deployment'; sourceSha256: string; installer: FileIdentity; files: FileIdentity[] };
const RESOURCE_PREFIX = 'desktop-tauri/src-tauri/resources/';
const REQUIRED = ['ai-cg-studio-desktop.exe', 'gateway/huiyu-runtime.exe', 'gateway/native/libvips-42.dll', 'gateway/data/catalog/manifest.json'];
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const manifestPath = (installer: string) => `${path.resolve(installer)}.deployment.json`;

function checkedFile(root: string, expected: FileIdentity) {
  const actual = safe.fileEntry(root, expected.path);
  if (actual.status !== 'file' || actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) throw Error(`安装文件字节不匹配：${expected.path}`);
}

/** Tauri 2.12 changes only this marker in its NSIS copy. Derive the installed
 * hash from verified build bytes while packaging, never from later source/SDK. */
function installedHost(root: string, expected: FileIdentity): FileIdentity {
  checkedFile(root, expected);
  const bytes = fs.readFileSync(safe.resolveSafe(root, expected.path));
  if (digest(bytes) !== expected.sha256) throw Error('生成安装清单时宿主已变化');
  const marker = Buffer.from('__TAURI_BUNDLE_TYPE_VAR_UNK');
  const offset = bytes.indexOf(marker);
  if (offset < 0 || bytes.indexOf(marker, offset + marker.length) >= 0) throw Error('Tauri NSIS 宿主标记不明确，请重新打包');
  Buffer.from('__TAURI_BUNDLE_TYPE_VAR_NSS').copy(bytes, offset);
  return { path: 'ai-cg-studio-desktop.exe', bytes: bytes.length, sha256: digest(bytes) };
}

function installedBuildFiles(root: string, receipt: unknown) {
  if (!safe.object(receipt) || receipt.schemaVersion !== 1 || receipt.kind !== 'desktop-build-binding') throw Error('安装包构建回执无效');
  const source = identity.validateSnapshot(receipt.source);
  const build = identity.validateSnapshot(receipt.build);
  const hostPath = desktopHostExecutable(desktopBuildProfile(receipt.buildProfile));
  const host = build.entries.find(entry => entry.path === hostPath);
  if (!host || host.status !== 'file') throw Error('原构建回执缺少宿主身份，无法准备旧包的安装校验清单');
  const files: FileIdentity[] = build.entries.filter((entry): entry is SnapshotFile => entry.status === 'file' && entry.path.startsWith(RESOURCE_PREFIX))
    .map(entry => ({ path: entry.path.slice(RESOURCE_PREFIX.length), bytes: entry.bytes, sha256: entry.sha256 }));
  files.push(installedHost(root, host));
  const icon = source.entries.find(entry => entry.path === 'desktop-tauri/src-tauri/icons/icon.ico');
  if (icon?.status === 'file') files.push({ path: 'huiyu-icon.ico', bytes: icon.bytes, sha256: icon.sha256 });
  if (REQUIRED.some(file => !files.some(entry => entry.path === file))) throw Error('构建缺少宿主、后端、原生库或内容快照');
  return { source, files: files.sort((a, b) => a.path.localeCompare(b.path, 'en')), receipt };
}

export function writeInstallerManifest(root: string, receipt: unknown, installer: string) {
  const { source, files, receipt: buildReceipt } = installedBuildFiles(root, receipt);
  const distribution = identity.validateSnapshot(buildReceipt.distribution);
  const relative = safe.relative(path.relative(root, installer).replaceAll('\\', '/'));
  const packaged = distribution.entries.find(entry => entry.path === relative);
  if (!packaged || packaged.status !== 'file') throw Error('指定安装包未登记在构建回执中');
  checkedFile(root, packaged);
  const manifest: DeploymentManifest = { schemaVersion: 1, kind: 'desktop-installer-deployment', sourceSha256: source.sha256,
    installer: { path: path.basename(installer), bytes: packaged.bytes, sha256: packaged.sha256 }, files };
  validateManifest(manifest, installer);
  const target = manifestPath(installer), temporary = `${target}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(manifest), { flag: 'wx' }); fs.renameSync(temporary, target); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return target;
}

function validateManifest(manifest: DeploymentManifest, installer: string) {
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'desktop-installer-deployment' || !identity.HASH.test(manifest.sourceSha256)
    || manifest.installer?.path?.toLowerCase() !== path.basename(installer).toLowerCase() || !Array.isArray(manifest.files) || !manifest.files.length) throw Error('安装校验清单格式无效');
  const names = new Set<string>();
  for (const file of [manifest.installer, ...manifest.files]) {
    safe.relative(file.path);
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !identity.HASH.test(file.sha256) || names.has(file.path.toLowerCase())) throw Error('安装校验清单的文件身份无效或重复');
    names.add(file.path.toLowerCase());
  }
  if (REQUIRED.some(file => !manifest.files.some(entry => entry.path === file))) throw Error('安装校验清单缺少宿主、后端、原生库或内容快照');
}

function verifyInstaller(installer: string, expectedManifestSha256?: string, installedRoot?: string) {
  installer = path.resolve(installer);
  const directory = safe.rootPath(path.dirname(installer));
  const record = safe.readJson(directory, path.basename(manifestPath(installer)));
  if (expectedManifestSha256 && record.entry.sha256 !== expectedManifestSha256) throw Error('本次安装校验清单已变化，部署停止');
  const manifest = record.value as DeploymentManifest;
  if (manifest?.installer?.path && manifest.installer.path.toLowerCase() !== path.basename(installer).toLowerCase()) {
    throw Error(`安装包文件名与部署清单不一致：清单为 ${manifest.installer.path}；请保持发行附件原名（浏览器重复下载可能追加 (1)）。`);
  }
  validateManifest(manifest, installer);
  checkedFile(directory, manifest.installer);
  if (installedRoot) {
    const root = safe.rootPath(installedRoot);
    // Only declared application files are checked. Extra user files, personal
    // SQLite content and AI directories are neither removed nor rewritten.
    for (const file of manifest.files) checkedFile(root, file);
  }
  return { installer, manifestSha256: record.entry.sha256, installerSha256: manifest.installer.sha256, fileCount: manifest.files.length };
}

/** Read-only comparison used to choose between a no-op, resource sync and a
 * full installer run. Executable/runtime mismatches require the installer;
 * everything else can be refreshed from the bound staged resources. */
export function inspectInstalled(installer: string, installedRoot: string) {
  installer = path.resolve(installer);
  const verified = verifyInstaller(installer);
  const directory = safe.rootPath(path.dirname(installer));
  const manifest = safe.readJson(directory, path.basename(manifestPath(installer))).value as DeploymentManifest;
  return { installer: verified.installer, manifestSha256: verified.manifestSha256,
    ...compareInstalledFiles(manifest.files, installedRoot) };
}

/** Caller verifies the current source/SDK/build before using these expected bytes.
 * Static repair and no-op detection do not depend on keeping an installer EXE. */
export function inspectInstalledBuild(root: string, receipt: unknown, installedRoot: string) {
  return compareInstalledFiles(installedBuildFiles(root, receipt).files, installedRoot);
}

function compareInstalledFiles(files: FileIdentity[], installedRoot: string) {
  const root = safe.rootPath(installedRoot);
  const mismatches = files.filter(file => {
    try {
      const actual = safe.fileEntry(root, file.path);
      return actual.status !== 'file' || actual.bytes !== file.bytes || actual.sha256 !== file.sha256;
    } catch { return true; }
  }).map(file => file.path);
  const isRuntime = (file: string) => file === 'ai-cg-studio-desktop.exe' || file === 'gateway/huiyu-runtime.exe' || file.startsWith('gateway/native/');
  const runtimeMismatches = mismatches.filter(isRuntime);
  return {
    fileCount: files.length,
    mismatchCount: mismatches.length,
    runtimeMismatchCount: runtimeMismatches.length,
    mismatches: mismatches.slice(0, 8),
  };
}

function freezeInstaller(installer: string, directory: string, manifestSha256: string) {
  verifyInstaller(installer, manifestSha256);
  fs.mkdirSync(directory, { recursive: true });
  const selected = path.join(directory, path.basename(installer));
  fs.copyFileSync(installer, selected, fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(manifestPath(installer), manifestPath(selected), fs.constants.COPYFILE_EXCL);
  // A concurrent change of the original output can only fail this copy check;
  // subsequent UAC/installation uses this operation's private copy throughout.
  return verifyInstaller(selected, manifestSha256);
}

if (require.main === module) {
  try {
    const [action, installer, ...args] = process.argv.slice(2);
    if (!installer) throw Error('需要明确指定安装包');
    if (action === 'prepare') {
      const root = args[0];
      if (!root || args.length !== 1) throw Error('旧包准备需要原构建回执所在目录');
      if (!fs.existsSync(manifestPath(installer))) {
        let receipt: any;
        try {
          receipt = safe.readJson(root, 'runtime/delivery-evidence/desktop-build-binding.json', true).value;
        } catch (error) {
          throw Error(`安装包缺少同名 .deployment.json，当前工作区也没有可用的构建回执；请从发行附件同时保留该清单，或在本机构建后使用。`, { cause: error });
        }
        try {
          writeInstallerManifest(root, receipt, path.resolve(installer));
        } catch (error) {
          throw Error(`安装包未登记在当前构建回执中，无法生成部署清单；请使用与当前源码匹配的构建产物。`, { cause: error });
        }
      }
      console.log(JSON.stringify(verifyInstaller(installer)));
    } else if (action === 'freeze' && args.length === 2) console.log(JSON.stringify(freezeInstaller(installer, args[0], args[1])));
    else if (action === 'verify' && args.length <= 2) console.log(JSON.stringify(verifyInstaller(installer, args[0] || undefined, args[1] || undefined)));
    else if (action === 'inspect' && args.length === 1) console.log(JSON.stringify(inspectInstalled(installer, args[0])));
    else throw Error('仅支持固定安装包 prepare / freeze / verify / inspect');
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
