import fs = require('node:fs');
import path = require('node:path');
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import identity = require('./delivery-identity');
import deliveryPaths = require('./delivery-paths');
import installerBinding = require('./desktop-installer-binding');
import type { Selection } from './delivery-types';
import { desktopBuildProfile, desktopHostExecutable, desktopRuntimeExecutable, type DesktopBuildProfile } from './desktop-build-profile';

const receiptPath = 'runtime/delivery-evidence/desktop-build-binding.json';
function problemDetails(snapshot: ReturnType<typeof identity.snapshot>) {
  const problems = snapshot.entries.filter(entry => entry.status !== 'file' && entry.status !== 'directory');
  return problems.slice(0, 5).map(entry =>
    `${entry.path} (${('message' in entry && entry.message) || entry.status})`).join('; ') + (problems.length > 5 ? `; 另有 ${problems.length - 5} 项` : '');
}
function completeSnapshot(root: string, selected: Selection[], failure: string) {
  let snapshot;
  try { snapshot = identity.snapshot(root, selected); }
  catch (error) { throw Error(`${failure}: ${error instanceof Error ? error.message : String(error)}`, { cause:error }); }
  if (snapshot.status !== 'complete') throw Error(`${failure}: ${problemDetails(snapshot)}`);
  return snapshot;
}

/** Cargo links this published executable to target/<profile>/deps. Materialize only
 * this known output after the CLI exits, retaining the verifier's blanket link
 * rejection for source/resources/bundles. Remove when Cargo emits an independent
 * release image; a single-link output already takes the no-write path. */
function materializeNativeExecutable(root: string, exe: string) {
  const target = deliveryPaths.resolveSafe(root, exe);
  const before = fs.lstatSync(target, { bigint:true });
  if (!before.isFile()) throw Error(`原生 EXE 不是普通文件: ${exe}`);
  if (before.nlink === 1n) return;
  const temporary = `${target}.detach-${randomUUID()}.tmp`;
  try {
    // This known Cargo output may be hardlinked, so the general fileEntry
    // verifier remains unavailable until the independent copy exists.
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
    const descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    let bytes = 0;
    try {
      let size;
      while ((size = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
        hash.update(buffer.subarray(0, size)); bytes += size;
      }
    } finally { fs.closeSync(descriptor); }
    const sha256 = hash.digest('hex');
    fs.copyFileSync(target, temporary, fs.constants.COPYFILE_EXCL);
    const copy = deliveryPaths.fileEntry(root, path.relative(root, temporary).replace(/\\/g, '/'));
    if (copy.status !== 'file' || copy.bytes !== bytes || copy.sha256 !== sha256) {
      throw Error('独立副本字节校验失败，保留原 EXE');
    }
    const current = fs.lstatSync(deliveryPaths.resolveSafe(root, exe), { bigint:true });
    if (current.dev !== before.dev || current.ino !== before.ino || current.size !== before.size
      || current.mtimeNs !== before.mtimeNs || current.ctimeNs !== before.ctimeNs || BigInt(bytes) !== before.size) {
      throw Error('复制期间原 EXE 发生变化，拒绝替换');
    }
    // Same-directory rename replaces only the release name, never writes through
    // Cargo's shared inode or unlinks the old image before the copy is verified.
    fs.renameSync(temporary, target);
    const published = deliveryPaths.fileEntry(root, exe);
    if (published.status !== 'file' || published.bytes !== bytes || published.sha256 !== sha256) {
      throw Error('原子替换后的 EXE 字节校验失败，拒绝生成回执');
    }
  } catch (error) {
    throw Error(`原生 EXE 独立化失败 (${exe}): ${error instanceof Error ? error.message : String(error)}`, { cause:error });
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function writeReceipt(root: string, receipt: unknown, stage: string) {
  const target = deliveryPaths.resolveSafe(root, receiptPath, true);
  fs.mkdirSync(path.dirname(target), { recursive:true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(receipt, null, 2), { flag:'wx' });
    fs.renameSync(temporary, deliveryPaths.resolveSafe(root, receiptPath, true));
  } catch (error) {
    throw Error(`${stage}回执写入失败，原回执保留: ${error instanceof Error ? error.message : String(error)}`, { cause:error });
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}
function sourceIdentity(root: string) {
  const names = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd:root, encoding:'utf8', windowsHide:true }).split('\0')
    .filter(name => name && !/^(docs|plans)\//.test(name) && (!/\.md$/i.test(name) || name.startsWith('runtime-rs/native-licenses/')));
  const deleted = new Set(execFileSync('git', ['ls-files', '-z', '--deleted'], { cwd:root, encoding:'utf8', windowsHide:true }).split('\0').filter(Boolean));
  const selection: Selection[] = [...new Set(names)].filter(name => {
    if (!deleted.has(name)) return true;
    // Staging a deletion must not change the identity of the same source bytes.
    // Recheck it now: a restored file, unsafe ancestor or IO error cannot vanish.
    try { deliveryPaths.resolveSafe(root, name); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }).map(name => ({ kind:'file', path:name }));
  return completeSnapshot(root, selection, '发行源码身份不完整，请检查源码文件后完整构建');
}
function sdkIdentity(root: string, env: NodeJS.ProcessEnv = process.env) {
  const { resolveSdkRoot, sdkInputSnapshot }: typeof import('./desktop-build-environment') = require('./desktop-build-environment');
  const sdkRoot = resolveSdkRoot(root, env);
  if (!sdkRoot) throw Error('缺少实际 Cubism SDK 输入，不能绑定桌面构建');
  return { root:sdkRoot, inputs:sdkInputSnapshot(sdkRoot) };
}
function buildSelection(root: string, includeBundle = true, profile: DesktopBuildProfile = 'release'): Selection[] {
  const selected: Selection[] = [
    { kind:'tree', path:'dist' },
    { kind:'tree', path:'desktop-tauri/src-tauri/resources' },
    { kind:'tree', path:'desktop-tauri/web' },
    { kind:'file', path:desktopHostExecutable(profile) },
  ];
  if (includeBundle) {
    const bundle = `desktop-tauri/src-tauri/target/${profile}/bundle/nsis`;
    const config = JSON.parse(fs.readFileSync(path.join(root, 'desktop-tauri/src-tauri/tauri.conf.json'), 'utf8'));
    const installer = deliveryPaths.relative(`${bundle}/${config.productName}_${config.version}_x64-setup.exe`);
    // Historical packages may remain in the output directory, but are not
    // inputs to this candidate. Keep the exact current package and signature.
    selected.push({ kind:'file', path:installer });
    if (fs.existsSync(path.join(root, `${installer}.sig`))) selected.push({ kind:'file', path:`${installer}.sig` });
    selected.push({ kind:'tree', path:`desktop-tauri/src-tauri/target/${profile}/nsis/x64` });
  }
  return selected;
}
function recordBuild(root: string, before: ReturnType<typeof sourceIdentity>, includeBundle = true, sdkBefore = sdkIdentity(root), profile: DesktopBuildProfile = 'release') {
  if (sourceIdentity(root).sha256 !== before.sha256) throw Error('构建期间源码发生变化，请重新完整构建');
  const { sdkInputSnapshot }: typeof import('./desktop-build-environment') = require('./desktop-build-environment');
  const sdk = {root:sdkBefore.root,inputs:sdkInputSnapshot(sdkBefore.root)};
  if (sdk.inputs.sha256 !== sdkBefore.inputs.sha256) throw Error('构建期间 Cubism SDK 输入发生变化，请重新完整构建');
  const runtime = JSON.parse(fs.readFileSync(path.join(root, 'desktop-tauri/src-tauri/resources/gateway/rust-runtime-build.json'), 'utf8'));
  if (desktopBuildProfile(runtime.buildProfile) !== profile || runtime.runtime?.path !== desktopRuntimeExecutable(profile)) throw Error('宿主与暂存后端的构建档位不一致，请完整重建');
  materializeNativeExecutable(root, desktopHostExecutable(profile));
  const build = completeSnapshot(root, buildSelection(root, includeBundle, profile), '桌面产物不完整，不能生成发行绑定回执');
  writeReceipt(root, { schemaVersion:1, kind:'desktop-build-binding', buildProfile:profile, includeBundle, source:before, sdk, build, buildCommit:identity.repository(root).commit }, '构建绑定');
}
function verifyBuild(root: string, payload?: string | readonly string[], expectedProfile?: DesktopBuildProfile) {
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(path.join(root, receiptPath), 'utf8')); }
  catch { throw Error('缺少桌面构建绑定回执；请从当前源码完整构建，不可复用同版本旧包'); }
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'desktop-build-binding') throw Error('发行回执格式无效');
  const profile = desktopBuildProfile(receipt.buildProfile);
  if (expectedProfile && profile !== expectedProfile) throw Error(`需要 ${expectedProfile} 构建，当前回执为 ${profile}；正式发行不可复用本机快速构建`);
  try { identity.validateSnapshot(receipt.source); identity.validateSnapshot(receipt.build); }
  catch (error) { throw Error(`发行源码/产物回执格式无效: ${error instanceof Error ? error.message : String(error)}`, { cause:error }); }
  if (sourceIdentity(root).sha256 !== receipt.source.sha256) throw Error('发行源码与构建不匹配，请完整重建；版本号相同不能复用旧包');
  try { identity.validateSnapshot(receipt.sdk?.inputs); }
  catch (error) { throw Error('缺少或无效的 Cubism SDK 构建绑定，请完整重建', {cause:error}); }
  if (sdkIdentity(root).inputs.sha256 !== receipt.sdk.inputs.sha256) throw Error('Cubism SDK 与构建绑定不匹配，请完整重建');
  if (typeof receipt.includeBundle !== 'boolean') throw Error('发行回执缺少产物模式');
  const build = completeSnapshot(root, buildSelection(root, receipt.includeBundle, profile), '桌面产物缺失或已改写，请从匹配源码完整重建');
  if (build.sha256 !== receipt.build.sha256) throw Error('桌面产物缺失或已改写，请从匹配源码完整重建');
  // Payload and its upgrade verifier share this checkpoint's complete source,
  // SDK and build scan. Each selected file still proves its own binding.
  for (const selected of typeof payload === 'string' ? [payload] : payload || []) {
    const relative = path.relative(root, selected).replace(/\\/g, '/');
    if (!receipt.build.entries.some((entry: { path: string; status: string }) => entry.path === relative && entry.status === 'file')) {
      verifyBoundFile(root, receipt.derivedPayloads, selected, '安装 payload 未绑定本次构建');
    }
  }
  return receipt;
}
/** Bundle-only starts from a verified native/staged build and extends its receipt. */
function extendBuild(root: string, receipt: ReturnType<typeof verifyBuild>) {
  const original = completeSnapshot(root, receipt.build.selectors, '打包原构建产物不完整，拒绝绑定');
  if (original.sha256 !== receipt.build.sha256) throw Error('打包修改了原构建产物，拒绝绑定');
  recordBuild(root, receipt.source, true, { ...sdkIdentity(root), inputs:receipt.sdk.inputs }, desktopBuildProfile(receipt.buildProfile));
}
function addBoundFiles(root: string, previous: unknown, outputs: string[]) {
  const names = outputs.map(output => path.relative(root, output).replaceAll('\\', '/'));
  if (!names.length || new Set(names).size !== names.length) throw Error('绑定产物集合为空或重复');
  names.forEach(name => deliveryPaths.relative(name));
  const validated = previous ? identity.validateSnapshot(previous) : undefined;
  const others = validated?.selectors.filter(item => !names.includes(item.path)) || [];
  if (validated) {
    for (const item of others) verifyBoundFile(root, validated, path.join(root, item.path), '已绑定的另一份产物已变化');
  }
  return completeSnapshot(root, [...others, ...names.map(name => ({ kind:'file' as const, path:name }))], '发行封装产物身份不完整');
}
function verifyBoundFile(root: string, input: unknown, output: string, message: string) {
  let snapshot;
  try { snapshot = identity.validateSnapshot(input); } catch { throw Error(message); }
  const relative = path.relative(root, output).replaceAll('\\', '/');
  const expected = snapshot.entries.find(item => item.path === relative);
  if (!expected || expected.status !== 'file') throw Error(message);
  const actual = completeSnapshot(root, [{ kind:'file', path:relative }], message).entries[0];
  if (actual.status !== 'file' || actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) throw Error(message);
}
function bindDerivedPayloads(root: string, outputs: string[]) {
  const receipt = verifyBuild(root);
  writeReceipt(root, { ...receipt, derivedPayloads:addBoundFiles(root, receipt.derivedPayloads, outputs) }, '升级载荷绑定');
}
function bindDistribution(root: string, payload: string, output: string) {
  const receipt = verifyBuild(root, payload);
  const distribution = addBoundFiles(root, receipt.distribution, [output]);
  const bound = { ...receipt, distribution, releaseCommit:identity.repository(root).commit };
  writeReceipt(root, bound, '发行封装绑定');
  installerBinding.writeInstallerManifest(root, bound, output);
}
function verifyBoundDistribution(root: string, receipt: ReturnType<typeof verifyBuild>, output: string) {
  try { identity.validateSnapshot(receipt.distribution); }
  catch (error) { throw Error('缺少或无效的发行封装绑定回执，请重新封装', { cause:error }); }
  verifyBoundFile(root, receipt.distribution, output, '发行封装产物已变化，拒绝签名或上传');
}
function verifyDistribution(root: string, output: string, expectedProfile?: DesktopBuildProfile) {
  verifyBoundDistribution(root, verifyBuild(root, undefined, expectedProfile), output);
}
function verifyDeployment(root:string,payload?:string){
  const receipt=verifyBuild(root);
  if(payload){const relative=path.relative(root,payload).replaceAll('\\','/');
    if(!receipt.build.entries.some((entry:{path:string;status:string})=>entry.status==='file'&&entry.path===relative)) {
      verifyBoundDistribution(root,receipt,payload);
    }
  }
  return receipt;
}
function deploymentPlan(root: string, options: { installDir?: string; installed?: boolean } = {}) {
  const installed = options.installed ?? (options.installDir
    ? fs.existsSync(path.join(options.installDir, 'ai-cg-studio-desktop.exe'))
    : undefined);
  if (installed === false) return { mode:'fresh', reason:'未检测到现有安装，需要发行完整包' };
  let receipt: ReturnType<typeof verifyBuild>;
  try { receipt = verifyBuild(root); }
  catch (error) { return { mode:'build', reason:error instanceof Error ? error.message : String(error) }; }
  let installationReason = '';
  if (options.installDir && installed) {
    try {
      const detail = installerBinding.inspectInstalledBuild(root, receipt, options.installDir);
      if (detail.mismatchCount === 0) {
        return { mode:'current', ...detail,
          reason:`已安装文件与当前源码和构建完全一致（${detail.fileCount} 项），无需升级包或重复部署` };
      }
      if (detail.runtimeMismatchCount === 0) {
        return { mode:'resources', ...detail,
          reason:`已安装程序、后端和原生库与当前构建一致，仅 ${detail.mismatchCount} 项静态资源不同；无需升级包，自动同步资源` };
      }
    } catch (error) {
      // A comparison failure never authorizes a static overwrite. Continue to
      // the verified installer path, which retains installation prerequisites.
      installationReason = `安装文件核对未完成：${error instanceof Error ? error.message : String(error)}；`;
    }
  }
  const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  const installer = path.join(root, 'runtime/desktop-updates', `AI-CG-Studio_${version}_x64-local-upgrade-setup.exe`);
  try {
    verifyBoundDistribution(root, receipt, installer);
  } catch (error) {
    return { mode:'package', reason:`${installationReason}原生构建匹配，仅重新封装升级包：${error instanceof Error ? error.message : String(error)}` };
  }
  return { mode:'installer', installer, reason:`${installationReason}源码、SDK、原生构建和升级包绑定均匹配，复用现有升级包` };
}
if(require.main===module){
  try{const args=process.argv.slice(2);if(args[0]==='--deployment-plan'){
    if(args.length<2||args.length>4)throw Error('Expected source root, optional installation directory and installed flag (0|1)');
    if(args[3]!==undefined&&args[3]!=='0'&&args[3]!=='1')throw Error('Installed flag must be 0 or 1');
    const installDir=args[2]?path.resolve(args[2]):undefined;
    const installed=args[3]===undefined?undefined:args[3]==='1';
    console.log(JSON.stringify(deploymentPlan(path.resolve(args[1]),{installDir,installed})));
  }else{if(args.length<1||args.length>2)throw Error('Expected source root and optional bound installer');verifyDeployment(path.resolve(args[0]),args[1]||undefined);}}
  catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
}
export = { sourceIdentity, sdkIdentity, recordBuild, verifyBuild, extendBuild, bindDerivedPayloads, bindDistribution, verifyDistribution };
