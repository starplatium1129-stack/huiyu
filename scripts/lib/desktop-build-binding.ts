import fs = require('node:fs');
import path = require('node:path');
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import identity = require('./delivery-identity');
import deliveryPaths = require('./delivery-paths');

const receiptPath = 'runtime/delivery-evidence/desktop-build-binding.json';
const exe = 'desktop-tauri/src-tauri/target/release/ai-cg-studio-desktop.exe';
const bundle = 'desktop-tauri/src-tauri/target/release/bundle/nsis';
type Selection = { kind: 'file' | 'tree'; path: string };
function problemDetails(snapshot: ReturnType<typeof identity.snapshot>) {
  const problems = snapshot.entries.filter((entry: { status: string }) => !['file', 'directory'].includes(entry.status));
  return problems.slice(0, 5).map((entry: { path: string; status: string; message?: string }) =>
    `${entry.path} (${entry.message || entry.status})`).join('; ') + (problems.length > 5 ? `; 另有 ${problems.length - 5} 项` : '');
}
function completeSnapshot(root: string, selected: Selection[], failure: string) {
  let snapshot;
  try { snapshot = identity.snapshot(root, selected); }
  catch (error) { throw Error(`${failure}: ${error instanceof Error ? error.message : String(error)}`, { cause:error }); }
  if (snapshot.status !== 'complete') throw Error(`${failure}: ${problemDetails(snapshot)}`);
  return snapshot;
}

/** Cargo links this published executable to target/release/deps. Materialize only
 * this known output after the CLI exits, retaining the verifier's blanket link
 * rejection for source/resources/bundles. Remove when Cargo emits an independent
 * release image; a single-link output already takes the no-write path. */
function materializeNativeExecutable(root: string) {
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
  const { resolveSdkRoot, sdkInputSnapshot }: typeof import('../maintenance/desktop-build-environment') = require('../maintenance/desktop-build-environment');
  const sdkRoot = resolveSdkRoot(root, env);
  if (!sdkRoot) throw Error('缺少实际 Cubism SDK 输入，不能绑定桌面构建');
  return { root:sdkRoot, inputs:sdkInputSnapshot(sdkRoot) };
}
function buildSelection(root: string, includeBundle = true): Selection[] {
  const selected: Selection[] = [
    { kind:'tree', path:'dist' },
    { kind:'tree', path:'desktop-tauri/src-tauri/resources' },
    { kind:'tree', path:'desktop-tauri/web' },
    { kind:'file', path:exe },
  ];
  if (includeBundle) {
    const config = JSON.parse(fs.readFileSync(path.join(root, 'desktop-tauri/src-tauri/tauri.conf.json'), 'utf8'));
    const installer = deliveryPaths.relative(`${bundle}/${config.productName}_${config.version}_x64-setup.exe`);
    // Historical packages may remain in the output directory, but are not
    // inputs to this candidate. Keep the exact current package and signature.
    selected.push({ kind:'file', path:installer });
    if (fs.existsSync(path.join(root, `${installer}.sig`))) selected.push({ kind:'file', path:`${installer}.sig` });
    selected.push({ kind:'tree', path:'desktop-tauri/src-tauri/target/release/nsis/x64' });
  }
  return selected;
}
function recordBuild(root: string, before: ReturnType<typeof sourceIdentity>, includeBundle = true, sdkBefore = sdkIdentity(root)) {
  if (sourceIdentity(root).sha256 !== before.sha256) throw Error('构建期间源码发生变化，请重新完整构建');
  const { sdkInputSnapshot }: typeof import('../maintenance/desktop-build-environment') = require('../maintenance/desktop-build-environment');
  const sdk = {root:sdkBefore.root,inputs:sdkInputSnapshot(sdkBefore.root)};
  if (sdk.inputs.sha256 !== sdkBefore.inputs.sha256) throw Error('构建期间 Cubism SDK 输入发生变化，请重新完整构建');
  materializeNativeExecutable(root);
  const build = completeSnapshot(root, buildSelection(root, includeBundle), '桌面产物不完整，不能生成发行绑定回执');
  writeReceipt(root, { schemaVersion:1, kind:'desktop-build-binding', includeBundle, source:before, sdk, build, buildCommit:identity.repository(root).commit }, '构建绑定');
}
function verifyBuild(root: string, payload?: string) {
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(path.join(root, receiptPath), 'utf8')); }
  catch { throw Error('缺少桌面构建绑定回执；请从当前源码完整构建，不可复用同版本旧包'); }
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'desktop-build-binding') throw Error('发行回执格式无效');
  try { identity.validateSnapshot(receipt.source); identity.validateSnapshot(receipt.build); }
  catch (error) { throw Error(`发行源码/产物回执格式无效: ${error instanceof Error ? error.message : String(error)}`, { cause:error }); }
  if (sourceIdentity(root).sha256 !== receipt.source.sha256) throw Error('发行源码与构建不匹配，请完整重建；版本号相同不能复用旧包');
  try { identity.validateSnapshot(receipt.sdk?.inputs); }
  catch (error) { throw Error('缺少或无效的 Cubism SDK 构建绑定，请完整重建', {cause:error}); }
  if (sdkIdentity(root).inputs.sha256 !== receipt.sdk.inputs.sha256) throw Error('Cubism SDK 与构建绑定不匹配，请完整重建');
  if (typeof receipt.includeBundle !== 'boolean') throw Error('发行回执缺少产物模式');
  const build = completeSnapshot(root, buildSelection(root, receipt.includeBundle), '桌面产物缺失或已改写，请从匹配源码完整重建');
  if (build.sha256 !== receipt.build.sha256) throw Error('桌面产物缺失或已改写，请从匹配源码完整重建');
  if (payload) {
    const relative = path.relative(root, payload).replace(/\\/g, '/');
    if (!receipt.build.entries.some((entry: { path: string; status: string }) => entry.path === relative && entry.status === 'file')) {
      verifyBoundFile(root, receipt.derivedPayloads, payload, '安装 payload 未绑定本次构建');
    }
  }
  return receipt;
}
/** Bundle-only starts from a verified native/staged build and extends its receipt. */
function extendBuild(root: string, receipt: ReturnType<typeof verifyBuild>) {
  const original = completeSnapshot(root, receipt.build.selectors, '打包原构建产物不完整，拒绝绑定');
  if (original.sha256 !== receipt.build.sha256) throw Error('打包修改了原构建产物，拒绝绑定');
  recordBuild(root, receipt.source, true, { ...sdkIdentity(root), inputs:receipt.sdk.inputs });
}
function addBoundFiles(root: string, previous: any, outputs: string[]) {
  const names = outputs.map(output => path.relative(root, output).replaceAll('\\', '/'));
  if (!names.length || new Set(names).size !== names.length) throw Error('绑定产物集合为空或重复');
  names.forEach(name => deliveryPaths.relative(name));
  const others: Selection[] = previous?.selectors?.filter((item: Selection) => !names.includes(item.path)) || [];
  if (previous) {
    identity.validateSnapshot(previous);
    for (const item of others) verifyBoundFile(root, previous, path.join(root, item.path), '已绑定的另一份产物已变化');
  }
  return completeSnapshot(root, [...others, ...names.map(name => ({ kind:'file' as const, path:name }))], '发行封装产物身份不完整');
}
function verifyBoundFile(root: string, snapshot: any, output: string, message: string) {
  try { identity.validateSnapshot(snapshot); } catch { throw Error(message); }
  const relative = path.relative(root, output).replaceAll('\\', '/');
  const expected = snapshot.entries.find((item: { path:string; status:string }) => item.path === relative && item.status === 'file');
  if (!expected) throw Error(message);
  const actual = completeSnapshot(root, [{ kind:'file', path:relative }], message).entries[0];
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) throw Error(message);
}
function bindDerivedPayloads(root: string, outputs: string[]) {
  const receipt = verifyBuild(root);
  writeReceipt(root, { ...receipt, derivedPayloads:addBoundFiles(root, receipt.derivedPayloads, outputs) }, '升级载荷绑定');
}
function bindDistribution(root: string, payload: string, output: string) {
  const receipt = verifyBuild(root, payload);
  const distribution = addBoundFiles(root, receipt.distribution, [output]);
  writeReceipt(root, { ...receipt, distribution, releaseCommit:identity.repository(root).commit }, '发行封装绑定');
}
function verifyBoundDistribution(root: string, receipt: ReturnType<typeof verifyBuild>, output: string) {
  try { identity.validateSnapshot(receipt.distribution); }
  catch (error) { throw Error('缺少或无效的发行封装绑定回执，请重新封装', { cause:error }); }
  verifyBoundFile(root, receipt.distribution, output, '发行封装产物已变化，拒绝签名或上传');
}
function verifyDistribution(root: string, output: string) {
  verifyBoundDistribution(root, verifyBuild(root), output);
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
if(require.main===module){
  try{const args=process.argv.slice(2);if(args.length<1||args.length>2)throw Error('Expected source root and optional bound installer');verifyDeployment(path.resolve(args[0]),args[1]||undefined);}
  catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
}
export = { sourceIdentity, sdkIdentity, recordBuild, verifyBuild, extendBuild, bindDerivedPayloads, bindDistribution, verifyDistribution, verifyDeployment, receiptPath };
