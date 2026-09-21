#!/usr/bin/env node
import { errorMessage as runtimeErrorMessage, errorOutput as runtimeErrorOutput } from '../lib/runtime-errors';
'use strict';

/**
 * 桌面端更新发布（2026-08-29 产品运营审计 P1：Tauri updater 落地）。
 *
 * 流程：package:tauri（NSIS + updater 签名产物）→ 拷贝安装包与 .sig 到
 * runtime/desktop-updates/ → 生成 latest.json（tauri-plugin-updater 清单格式）
 * 与 SHA-256，再按需发布到主项目 GitHub Releases。
 *
 * 前置：签名密钥 runtime/keys/aics-updater.key（`npx tauri signer generate` 生成，
 * 私钥不入库；丢失则无法再给已装客户端推送更新）。
 *
 * 用法：node scripts/maintenance/release-desktop-update.js [--skip-build] [--bump patch|minor|major] [--publish]
 *   --bump  发布前先递增版本号（package.json 与 tauri.conf.json 同步），例如
 *           --bump patch 1.5.0 → 1.5.1。客户端 updater 只在远端版本 > 当前安装
 *           版本时提示，日常发版必须 bump，否则永远检不到更新。
 */

const fs: typeof import('fs') = require('fs');
const path: typeof import('path') = require('path');
const { execFileSync }: typeof import('child_process') = require('child_process');
const crypto: typeof import('crypto') = require('crypto');
const { resolveNpmInvocation }: typeof import('./desktop-stage-resources') = require('./desktop-stage-resources');

// 盘符大写归一（2026-08-31 破案）：bash 会话下 __dirname 可能带小写盘符 e:\，
// 作为 execFileSync 的 cwd 会让 npm/vite 模块 ID 盘符分裂，build 秒失败且零输出。
// 与工作区记忆配方一致：大写 cwd 一切正常。
const ROOT = path.resolve(__dirname, '..', '..').replace(/^([a-z]):/i, (_: any, letter: any) => letter.toUpperCase() + ':');
const KEY_FILE = process.env.TAURI_SIGNING_PRIVATE_KEY_PATH || path.join(ROOT, 'runtime', 'keys', 'aics-updater.key');
const OUT_DIR = path.join(ROOT, 'runtime', 'desktop-updates');
const BUNDLE_DIR = path.join(ROOT, 'desktop-tauri', 'src-tauri', 'target', 'release', 'bundle', 'nsis');
const SKIP_BUILD = process.argv.includes('--skip-build');
const BUNDLE_ONLY = process.argv.includes('--bundle-only');
const BUMP_INDEX = process.argv.indexOf('--bump');
const BUMP_KIND = BUMP_INDEX >= 0 ? String(process.argv[BUMP_INDEX + 1] || 'patch') : '';
const PUBLISH = process.argv.includes('--publish');
const MANUAL = process.argv.includes('--manual');
const COMPLETE_MANUAL = process.argv.includes('--complete-manual');
const RELEASE_REPOSITORY = 'starplatium1129-stack/huiyu';
const binding: typeof import('../lib/desktop-build-binding') = require('../lib/desktop-build-binding');
const MANUAL_MARKER = '<!-- huiyu-release-mode: manual -->';

function ghCommand() {
  const portable = path.join(ROOT, 'runtime/github-cli/bin/gh.exe');
  return process.env.GH_EXECUTABLE || (fs.existsSync(portable) ? portable : 'gh');
}

function fail(message: any) {
  console.error(`[release-desktop-update] ${message}`);
  process.exit(1);
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

/** 递增 package.json 与 tauri.conf.json 版本号（客户端当前版本编译自 tauri.conf.json，必须同步）。 */
function bumpVersion(kind: any) {
  if (!['patch', 'minor', 'major'].includes(kind)) fail(`未知 bump 档位: ${kind}（patch|minor|major）`);
  const pkgPath = path.join(ROOT, 'package.json');
  const tauriPath = path.join(ROOT, 'desktop-tauri', 'src-tauri', 'tauri.conf.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const conf = JSON.parse(fs.readFileSync(tauriPath, 'utf8'));
  const match: any = SEMVER.exec(String(pkg.version || ''));
  if (!match) fail(`无法解析 package.json version: ${pkg.version}`);
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  if (kind === 'major') { major += 1; minor = 0; patch = 0; }
  else if (kind === 'minor') { minor += 1; patch = 0; }
  else { patch += 1; }
  const next = `${major}.${minor}.${patch}`;
  if (String(conf.version || '') !== String(pkg.version || '')) {
    console.warn(`[release-desktop-update] 警告：tauri.conf.json version=${conf.version} 与 package.json ${pkg.version} 不一致，将两者都设为 ${next}`);
  }
  pkg.version = next;
  conf.version = next;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  fs.writeFileSync(tauriPath, JSON.stringify(conf, null, 2) + '\n', 'utf8');
  const lockPath = path.join(ROOT, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.version = next;
  if (lock.packages?.['']) lock.packages[''].version = next;
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');
  const cargoPath = path.join(ROOT, 'desktop-tauri/src-tauri/Cargo.toml');
  fs.writeFileSync(cargoPath, fs.readFileSync(cargoPath, 'utf8').replace(/(\[package\][\s\S]*?\nversion = ")[^"]+("\r?\n)/, `$1${next}$2`));
  const cargoLock = path.join(ROOT, 'desktop-tauri/src-tauri/Cargo.lock');
  fs.writeFileSync(cargoLock, fs.readFileSync(cargoLock, 'utf8').replace(/(name = "ai-cg-studio-desktop"\r?\nversion = ")[^"]+(")/, `$1${next}$2`));
  console.log(`[release-desktop-update] 版本 ${match[0]} → ${next}`);
  return next;
}

function releaseTag(version: any) {
  return `v${version}`;
}

function createManifest(version: any, signature: any, exeName: any, publishedAt: any = new Date()) {
  const tag = releaseTag(version);
  return {
    version,
    notes: `绘遇 HUIYU ${version}`,
    pub_date: publishedAt.toISOString(),
    platforms: {
      'windows-x86_64': {
        signature,
        url: `https://github.com/${RELEASE_REPOSITORY}/releases/download/${tag}/${encodeURIComponent(exeName)}`,
      },
    },
  };
}

function assertPublishReady(version: any) {
  if (BUMP_KIND) fail('--publish 不能与 --bump 同时使用：请先构建、提交并推送版本，再用 --skip-build --publish');
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  let tagHead = '';
  try { tagHead = execFileSync('git', ['rev-parse', `${releaseTag(version)}^{commit}`], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* New version has no tag yet. */ }
  if (branch !== 'main' && !(COMPLETE_MANUAL && !branch && tagHead === head)) fail(`发布必须在 main 执行；补签可检出原版本 tag，当前为 ${branch || '(detached)'}`);
  if (tagHead && tagHead !== head) fail('版本标签与当前源码不一致，不允许覆盖另一份源码的发行资产');
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim();
  if (dirty) fail('发布前工作区必须干净，确保安装包对应已提交源码');
  const repository = JSON.parse(execFileSync(ghCommand(), [
    'repo', 'view', RELEASE_REPOSITORY, '--json', 'nameWithOwner,isPrivate,defaultBranchRef',
  ], { cwd: ROOT, encoding: 'utf8', windowsHide: true }));
  if (repository.nameWithOwner !== RELEASE_REPOSITORY || repository.isPrivate) {
    fail(`发布目标必须是公开主项目 ${RELEASE_REPOSITORY}`);
  }
  const remoteHead = execFileSync('git', ['ls-remote', 'origin', 'refs/heads/main'], { cwd: ROOT, encoding: 'utf8' }).trim().split(/\s+/)[0];
  if (branch === 'main' && head !== remoteHead) fail(`main 尚未与远端同步：HEAD=${head.slice(0, 8)} remote=${remoteHead.slice(0, 8)}`);
  if (version !== require(path.join(ROOT, 'package.json')).version) fail('发布版本读取漂移');
  return head;
}

function publishRelease(version: any, head: any, files: any, options: any = {}) {
  const run = options.run || execFileSync;
  const manual = options.manual ?? MANUAL;
  const completeManual = options.completeManual ?? COMPLETE_MANUAL;
  if (manual && files.some((file: any) => path.basename(file) === 'latest.json' || file.endsWith('.sig'))) throw new Error('手动安装版不能发布自动更新清单或签名');
  const tag = releaseTag(version);
  const baseNotes = options.notesFile || path.join(ROOT, 'docs/releases', `${tag}.md`);
  if (!fs.existsSync(baseNotes)) throw new Error(`缺少版本说明：${baseNotes}`);
  const notes = (manual ? `${MANUAL_MARKER}\n> 本次为手动安装版：请下载下方 Windows 安装包。自动更新通道继续保留上一份已签名版本，待原签名主机补签后启用。安装包未签名，SHA-256 用于文件完整性校验。\n\n` : '') + fs.readFileSync(baseNotes, 'utf8');
  const outputDir = options.outputDir || OUT_DIR;
  fs.mkdirSync(outputDir, { recursive: true });
  const notesPath = path.join(outputDir, `release-notes-${tag}.md`);
  fs.writeFileSync(notesPath, notes);
  const cli = ghCommand();
  const queryOptions = { cwd: ROOT, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
  const writeOptions = { cwd: ROOT, stdio: 'inherit', windowsHide: true };
  let existing = null;
  try { existing = JSON.parse(run(cli, ['release', 'view', tag, '--repo', RELEASE_REPOSITORY, '--json', 'isDraft,body,targetCommitish'], queryOptions)); }
  catch (error) { if (!/release not found|404|Not Found/i.test(String(runtimeErrorOutput(error, 'stderr') || runtimeErrorMessage(error)))) throw error; }
  if (existing && !existing.isDraft && !(completeManual && !manual && existing.body.includes(MANUAL_MARKER))) throw new Error('该版本已公开发布；只有显式 --complete-manual 才能补签手动版');
  if (existing) {
    // Existing tags are immutable: completion must sign the exact released source.
    const tagCommit = existing.isDraft ? existing.targetCommitish : run('git', ['rev-parse', `${tag}^{commit}`], queryOptions).trim();
    if (tagCommit !== head) throw new Error('发行源码与草稿或已发布版本标签不一致');
    run(cli, ['release', 'upload', tag, ...files, '--repo', RELEASE_REPOSITORY, '--clobber'], writeOptions);
  } else {
    run(cli, ['release', 'create', tag, ...files, '--repo', RELEASE_REPOSITORY, '--target', head, '--title', `绘遇 HUIYU ${version}`, '--notes-file', notesPath, '--draft'], writeOptions);
  }
  const uploaded = JSON.parse(run(cli, ['release', 'view', tag, '--repo', RELEASE_REPOSITORY, '--json', 'assets'], queryOptions));
  for (const file of files) {
    const asset = uploaded.assets.find((asset: any) => asset.name === path.basename(file));
    if (!asset || asset.size !== fs.statSync(file).size) throw new Error(`发行资产上传不完整：${path.basename(file)}，未晋升发布`);
    if (asset.digest && asset.digest.toLowerCase() !== `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`) throw new Error(`发行资产校验失败：${path.basename(file)}，未晋升发布`);
  }
  run(cli, ['release', 'edit', tag, '--repo', RELEASE_REPOSITORY, '--title', `绘遇 HUIYU ${version}${manual ? ' · 手动安装版' : ''}`, '--notes-file', notesPath, '--draft=false', `--latest=${manual ? 'false' : 'true'}`], writeOptions);
}

function main() {
  if (MANUAL && COMPLETE_MANUAL) fail('--manual 与 --complete-manual 不能同时使用');
  if (PUBLISH && BUMP_KIND) fail('--publish 不能与 --bump 同时使用，请先构建、提交并推送版本');
  if (!MANUAL && !fs.existsSync(KEY_FILE)) {
    fail(`缺少原更新签名私钥 ${KEY_FILE}。请在持有原私钥的主机签名；手动安装版必须显式使用 --manual，不能生成替代私钥。`);
  }
  if (BUMP_KIND) bumpVersion(BUMP_KIND);
  const version = require(path.join(ROOT, 'package.json')).version;
  const previousBuild = SKIP_BUILD || BUNDLE_ONLY ? binding.verifyBuild(ROOT) : null;

  if (!SKIP_BUILD) {
    if (BUNDLE_ONLY) {
      const binary = path.join(ROOT, 'desktop-tauri/src-tauri/target/release/ai-cg-studio-desktop.exe');
      if (!fs.existsSync(binary)) fail('缺少已构建桌面程序，请先完整构建');
      const binaryVersion = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Item -LiteralPath '${binary.replace(/'/g, "''")}').VersionInfo.ProductVersion`],
      { encoding: 'utf8', windowsHide: true }).trim();
      if (binaryVersion !== version) fail(`已构建程序版本 ${binaryVersion} 与发行版本 ${version} 不一致，请完整构建`);
      execFileSync(process.execPath, [path.join(ROOT, 'scripts/maintenance/build-game-installer.js')], { cwd: ROOT, stdio: 'inherit' });
    }
    const buildEnv = (require('./run-tauri') as typeof import('./run-tauri')).tauriEnvironment();
    if (MANUAL) {
      delete buildEnv.TAURI_SIGNING_PRIVATE_KEY; delete buildEnv.TAURI_SIGNING_PRIVATE_KEY_PATH; delete buildEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
    } else {
      Object.assign(buildEnv, { TAURI_SIGNING_PRIVATE_KEY: fs.readFileSync(KEY_FILE, 'utf8').trim(), TAURI_SIGNING_PRIVATE_KEY_PATH: KEY_FILE, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' });
    }
    if (MANUAL && BUNDLE_ONLY) fail('手动版请使用完整构建，或对已构建的同版本安装包使用 --skip-build');
    console.log(`[release-desktop-update] ${MANUAL ? '构建手动安装版（不生成自动更新清单）' : '构建签名自动更新版'}`);
    const npm = resolveNpmInvocation();
    execFileSync(BUNDLE_ONLY ? process.execPath : npm.command, BUNDLE_ONLY
      ? [require.resolve('@tauri-apps/cli/tauri.js'), 'bundle', '--bundles', 'nsis', '--ci']
      : [...npm.args, 'run', 'package:tauri'], {
      cwd: BUNDLE_ONLY ? path.join(ROOT, 'desktop-tauri') : ROOT,
      stdio: 'inherit',
      windowsHide: true,
      env: buildEnv,
    });
  }

  // 找出本次产出的安装包与签名（NSIS：*-setup.exe + .sig）
  if (BUNDLE_ONLY && !SKIP_BUILD && previousBuild) binding.extendBuild(ROOT, previousBuild);
  const artifacts = fs.readdirSync(BUNDLE_DIR)
    .filter((f: any) => f.endsWith(`_${version}_x64-setup.exe`))
    .map((exe: any) => ({ exe, sig: `${exe}.sig` }))
    .filter((a: any) => MANUAL || fs.existsSync(path.join(BUNDLE_DIR, a.sig)));
  if (!artifacts.length) fail(`${BUNDLE_DIR} 下没有 updater 安装包（*-setup.exe + .sig）`);
  const artifact = artifacts[artifacts.length - 1];
  binding.verifyBuild(ROOT, path.join(BUNDLE_DIR, artifact.exe));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const exeName = artifact.exe;
  const executable = path.join(OUT_DIR, exeName);
  (require('./build-modern-installer') as typeof import('./build-modern-installer')).buildModernInstaller({
    payload: path.join(BUNDLE_DIR, artifact.exe), output: executable,
  });
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(executable)).digest('hex').toUpperCase();
  const shaPath = path.join(OUT_DIR, `${exeName}.sha256`);
  fs.writeFileSync(shaPath, `${sha256}  ${exeName}\n`);
  binding.verifyDistribution(ROOT, executable);
  if (MANUAL) {
    if (PUBLISH) publishRelease(version, assertPublishReady(version), [executable, shaPath]);
    console.log(`[release-desktop-update] ${version} 手动安装包已生成，未修改自动更新清单`);
    return;
  }
  // Sign the distributed wrapper, never reuse the embedded NSIS signature.
  const signerEnv: NodeJS.ProcessEnv = { ...process.env, TAURI_SIGNING_PRIVATE_KEY_PATH: KEY_FILE, TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '' };
  delete signerEnv.TAURI_SIGNING_PRIVATE_KEY;
  execFileSync(process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), 'signer', 'sign', executable], {
    cwd: ROOT, stdio: 'inherit', windowsHide: true,
    env: signerEnv,
  });
  const signature = fs.readFileSync(`${executable}.sig`, 'utf8').trim();
  const updater = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop-tauri/src-tauri/tauri.conf.json'), 'utf8')).plugins.updater;
  (require('./build-modern-installer') as typeof import('./build-modern-installer')).verifyUpdaterSignature(executable, signature, updater.pubkey);

  const manifestPath = path.join(OUT_DIR, 'latest.json');
  const manifest = createManifest(version, signature, exeName);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  console.log(`[release-desktop-update] ${version} 已生成到 runtime/desktop-updates/`);
  if (PUBLISH) {
    binding.verifyDistribution(ROOT, executable);
    const head = assertPublishReady(version);
    publishRelease(version, head, [manifestPath, executable, `${executable}.sig`, shaPath]);
    console.log(`[release-desktop-update] ${releaseTag(version)} 已发布到 ${RELEASE_REPOSITORY}`);
  } else {
    console.log('[release-desktop-update] 提交并推送 main 后，用 --skip-build --publish 发布 GitHub Release');
  }
}

if (require.main === module) main();

export = { RELEASE_REPOSITORY, createManifest, releaseTag, publishRelease, MANUAL_MARKER, bumpVersion };
