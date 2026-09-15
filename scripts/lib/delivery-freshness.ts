import { errorMessage as runtimeErrorMessage } from './runtime-errors';
'use strict';
const { object, canonical, relative, fileEntry }: typeof import('./delivery-paths') = require('./delivery-paths');
const { HASH, compareSnapshot }: typeof import('./delivery-identity') = require('./delivery-identity');
const { get, state, gatePath, MAIN_FIELDS }: typeof import('./delivery-state') = require('./delivery-state');
const { isReboundGate }: typeof import('./delivery-finalize') = require('./delivery-finalize');

function inspectTracking(root, document) {
  const record = document.tracking;
  if (record === undefined) return { status: 'unknown', message: '旧记录没有输入追踪；历史通过声明的新鲜度未知', gates: {} };
  if (!object(record) || record.schemaVersion !== 1 || record.algorithm !== 'sha256' || !object(record.gates)
    || Object.keys(record.gates).some(k => !gatePath(k) && !MAIN_FIELDS.includes(k))) {
    return { status: 'invalid', message: 'tracking 格式或版本不支持', gates: {} };
  }
  const source = compareSnapshot(root, record.source), build = compareSnapshot(root, record.build);
  const status = [source, build].some(v => v.status === 'invalid') ? 'invalid'
    : [source, build].some(v => v.status !== 'fresh') ? 'stale' : 'fresh';
  return { status, source, build, gates: {} };
}
function reportPaths(value) {
  return [...new Set(['log', 'transcript', 'report'].map(k => value?.[k]).filter(v => typeof v === 'string' && v))].sort();
}
function inspectGate(root, document, freshness, field) {
  const declaredStatus = state(get(document, field));
  const result = { status: 'unknown', declaredStatus, effectiveStatus: declaredStatus, reports: [] };
  const binding = document.tracking?.gates?.[field];
  try {
    if (freshness.status === 'invalid') throw Error('追踪身份记录不可用');
    const value = get(document, field);
    if (document.finalization && value?.commit !== undefined && value.commit !== document.commit
      && !isReboundGate(document, field, freshness.finalization)) throw Error('旧提交结果缺少有效 finalize 关联');
    if (!binding) result.message = '缺少此项执行时的输入身份绑定';
    else {
      if (!object(binding) || !Array.isArray(binding.dependsOn) || !binding.dependsOn.length
        || new Set(binding.dependsOn).size !== binding.dependsOn.length
        || binding.dependsOn.some(k => !['source', 'build'].includes(k))
        || !object(binding.identities) || !['office', 'main'].includes(binding.machine)) throw Error('门禁依赖绑定格式错误');
      if (MAIN_FIELDS.includes(field) && (binding.machine !== 'main' || !['source', 'build'].every(k => binding.dependsOn.includes(k)))) throw Error('主力机验收必须绑定 source/build 与 main 机器');
      if (get(document, field)?.machine !== undefined && get(document, field).machine !== binding.machine) throw Error('结果声明机器与身份绑定机器矛盾');
      result.dependsOn = binding.dependsOn;
      result.machine = binding.machine;
      result.status = binding.dependsOn.every(key => HASH.test(binding.identities[key])
        && binding.identities[key] === document.tracking[key]?.sha256 && freshness[key]?.status === 'fresh') ? 'fresh' : 'stale';
      if (result.status === 'stale') result.message = '执行时绑定的输入/构建身份已改变或不可用，须复验';
      if (!Array.isArray(binding.reports)) throw Error('缺少报告文件绑定列表');
      const expectedPaths = reportPaths(get(document, field));
      const recordedPaths = binding.reports.map(entry => relative(entry.path));
      if (canonical(recordedPaths) !== canonical(expectedPaths)) throw Error('结果的日志/报告引用与已绑定文件不一致');
      for (const entry of binding.reports) {
        if (entry.status !== 'file' || !HASH.test(entry.sha256) || !Number.isSafeInteger(entry.bytes)) throw Error('报告文件身份不完整');
        const actual = fileEntry(root, entry.path);
        const status = actual.status === 'file' && actual.sha256 === entry.sha256 && actual.bytes === entry.bytes ? 'fresh' : 'stale';
        result.reports.push({ path: entry.path, status, expectedSha256: entry.sha256, actual });
        if (status !== 'fresh') { result.status = 'stale'; result.message = '已绑定日志/报告改变、缺失或不安全'; }
      }
      if (declaredStatus === 'passed' && !binding.reports.length && result.status === 'fresh') {
        result.status = 'unknown'; result.message = '通过声明没有实际报告文件的字节身份';
      }
      if (MAIN_FIELDS.includes(field) && declaredStatus === 'passed' && document.handoff?.stage !== 'main') throw Error('办公机交付不能声明主力机安装/设备/模型验收通过');
    }
  } catch (error) { result.status = 'invalid'; result.message = runtimeErrorMessage(error); }
  if (declaredStatus === 'passed' && result.status !== 'fresh') result.effectiveStatus = result.status === 'unknown' ? 'unknown' : 'stale';
  Object.defineProperty(freshness.gates, field, { value: result, enumerable: true, configurable: true, writable: true });
  return result;
}
function bindGate(root, value, dependsOn, identities, machine) {
  const reports = reportPaths(value).map(name => fileEntry(root, relative(name)));
  if (reports.some(v => v.status !== 'file')) throw Error('结果引用的日志/报告缺失、不安全或不可读');
  if (state(value) === 'passed' && !reports.length) throw Error('通过结果必须提供 root 内实际 log/transcript/report 文件');
  return { dependsOn, identities: Object.fromEntries(dependsOn.map(k => [k, identities[k].sha256])), machine, reports };
}
export = { inspectTracking, inspectGate, bindGate };
