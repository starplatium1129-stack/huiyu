import fs = require('node:fs');
import path = require('node:path');
import { execFileSync } from 'node:child_process';
import identity = require('./delivery-identity');

const receiptPath = 'runtime/delivery-evidence/desktop-build-binding.json';
const exe = 'desktop-tauri/src-tauri/target/release/ai-cg-studio-desktop.exe';
const bundle = 'desktop-tauri/src-tauri/target/release/bundle/nsis';
type Selection = { kind: 'file' | 'tree'; path: string };
function sourceIdentity(root: string) {
  const names = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd:root, encoding:'utf8', windowsHide:true }).split('\0')
    .filter(name => name && !/^(docs|plans)\//.test(name) && !/\.md$/i.test(name));
  const selection = [...new Set(names)].map(name => ({ kind:'file', path:name }));
  const result = identity.snapshot(root, selection);
  if (result.status !== 'complete') throw Error('发行源码身份不完整，请检查源码文件后完整构建');
  return result;
}
function buildSelection(root: string, includeBundle = true): Selection[] {
  const selected: Selection[] = [
    { kind:'tree', path:'dist' },
    { kind:'tree', path:'desktop-tauri/src-tauri/resources' },
    { kind:'file', path:exe },
  ];
  if (includeBundle) selected.push({ kind:'tree', path:bundle });
  return selected;
}
function recordBuild(root: string, before: ReturnType<typeof sourceIdentity>, includeBundle = true) {
  if (sourceIdentity(root).sha256 !== before.sha256) throw Error('构建期间源码发生变化，请重新完整构建');
  const build = identity.snapshot(root, buildSelection(root, includeBundle));
  if (build.status !== 'complete') throw Error('桌面产物不完整，不能生成发行绑定回执');
  const target = path.join(root, receiptPath);
  fs.mkdirSync(path.dirname(target), { recursive:true });
  const temporary = target + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ schemaVersion:1, kind:'desktop-build-binding', includeBundle, source:before, build, buildCommit:identity.repository(root).commit }, null, 2));
  fs.renameSync(temporary, target);
}
function verifyBuild(root: string, payload?: string) {
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(path.join(root, receiptPath), 'utf8')); }
  catch { throw Error('缺少桌面构建绑定回执；请从当前源码完整构建，不可复用同版本旧包'); }
  if (receipt.schemaVersion !== 1 || receipt.kind !== 'desktop-build-binding') throw Error('发行回执格式无效');
  identity.validateSnapshot(receipt.source); identity.validateSnapshot(receipt.build);
  if (sourceIdentity(root).sha256 !== receipt.source.sha256) throw Error('发行源码与构建不匹配，请完整重建；版本号相同不能复用旧包');
  if (typeof receipt.includeBundle !== 'boolean') throw Error('发行回执缺少产物模式');
  const build = identity.snapshot(root, buildSelection(root, receipt.includeBundle));
  if (build.status !== 'complete' || build.sha256 !== receipt.build.sha256) throw Error('桌面产物缺失或已改写，请从匹配源码完整重建');
  if (payload) {
    const relative = path.relative(root, payload).replace(/\\/g, '/');
    if (!receipt.build.entries.some((entry: { path: string; status: string }) => entry.path === relative && entry.status === 'file')) throw Error('安装 payload 未绑定本次构建');
  }
  return receipt;
}
/** Bundle-only starts from a verified native/staged build and extends its receipt. */
function extendBuild(root: string, receipt: ReturnType<typeof verifyBuild>) {
  const original = identity.snapshot(root, receipt.build.selectors);
  if (original.sha256 !== receipt.build.sha256) throw Error('打包修改了原构建产物，拒绝绑定');
  recordBuild(root, receipt.source);
}
function bindDistribution(root: string, payload: string, output: string) {
  const receipt = verifyBuild(root, payload);
  const distribution = identity.snapshot(root, [{ kind:'file', path:path.relative(root, output).replace(/\\/g, '/') }]);
  if (distribution.status !== 'complete') throw Error('发行封装产物身份不完整');
  fs.writeFileSync(path.join(root, receiptPath), JSON.stringify({ ...receipt, distribution, releaseCommit:identity.repository(root).commit }, null, 2));
}
function verifyDistribution(root: string, output: string) {
  const receipt = verifyBuild(root);
  identity.validateSnapshot(receipt.distribution);
  const relative = path.relative(root, output).replace(/\\/g, '/');
  const actual = identity.snapshot(root, [{ kind:'file', path:relative }]);
  if (actual.status !== 'complete' || actual.sha256 !== receipt.distribution.sha256) throw Error('发行封装产物已变化，拒绝签名或上传');
}
export = { sourceIdentity, recordBuild, verifyBuild, extendBuild, bindDistribution, verifyDistribution, receiptPath };
