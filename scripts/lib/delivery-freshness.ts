import { errorMessage as runtimeErrorMessage } from './runtime-errors';
import type { GateBinding, GateInspection, IdentityGroup, Machine, Snapshot, TrackingInspection } from './delivery-types';
'use strict';
const { object, canonical, relative, fileEntry }: typeof import('./delivery-paths') = require('./delivery-paths');
const { compareSnapshot }: typeof import('./delivery-identity') = require('./delivery-identity');
const { readGateBinding }: typeof import('./delivery-records') = require('./delivery-records');
const { get, state, gatePath, MAIN_FIELDS }: typeof import('./delivery-state') = require('./delivery-state');
const { isReboundGate }: typeof import('./delivery-finalize') = require('./delivery-finalize');

function inspectTracking(root: string, document: unknown): TrackingInspection {
  const record = get(document, 'tracking');
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
function reportPaths(value: unknown): string[] {
  return [...new Set(['log', 'transcript', 'report'].map(k => get(value, k)).filter((v): v is string => typeof v === 'string' && v.length > 0))].sort();
}
function inspectGate(root: string, document: unknown, freshness: TrackingInspection, field: string): GateInspection {
  const declaredStatus = state(get(document, field));
  const result: GateInspection = { status: 'unknown', declaredStatus, effectiveStatus: declaredStatus, reports: [] };
  const tracking = get(document, 'tracking'), gates = get(tracking, 'gates');
  const rawBinding = object(gates) ? gates[field] : undefined;
  try {
    if (freshness.status === 'invalid') throw Error('追踪身份记录不可用');
    const value = get(document, field);
    if (get(document, 'finalization') && get(value, 'commit') !== undefined && get(value, 'commit') !== get(document, 'commit')
      && !isReboundGate(document, field, freshness.finalization)) throw Error('旧提交结果缺少有效 finalize 关联');
    if (!rawBinding) result.message = '缺少此项执行时的输入身份绑定';
    else {
      const binding = readGateBinding(rawBinding);
      if (MAIN_FIELDS.includes(field) && (binding.machine !== 'main' || !binding.dependsOn.includes('source') || !binding.dependsOn.includes('build'))) throw Error('主力机验收必须绑定 source/build 与 main 机器');
      if (get(value, 'machine') !== undefined && get(value, 'machine') !== binding.machine) throw Error('结果声明机器与身份绑定机器矛盾');
      result.dependsOn = binding.dependsOn;
      result.machine = binding.machine;
      result.status = binding.dependsOn.every(key => binding.identities[key] === get(tracking, `${key}.sha256`)
        && freshness[key]?.status === 'fresh') ? 'fresh' : 'stale';
      if (result.status === 'stale') result.message = '执行时绑定的输入/构建身份已改变或不可用，须复验';
      const expectedPaths = reportPaths(get(document, field));
      const recordedPaths = binding.reports.map(entry => relative(entry.path));
      if (canonical(recordedPaths) !== canonical(expectedPaths)) throw Error('结果的日志/报告引用与已绑定文件不一致');
      for (const entry of binding.reports) {
        const actual = fileEntry(root, entry.path);
        const status = actual.status === 'file' && actual.sha256 === entry.sha256 && actual.bytes === entry.bytes ? 'fresh' : 'stale';
        result.reports.push({ path: entry.path, status, expectedSha256: entry.sha256, actual });
        if (status !== 'fresh') { result.status = 'stale'; result.message = '已绑定日志/报告改变、缺失或不安全'; }
      }
      if (declaredStatus === 'passed' && !binding.reports.length && result.status === 'fresh') {
        result.status = 'unknown'; result.message = '通过声明没有实际报告文件的字节身份';
      }
      if (MAIN_FIELDS.includes(field) && declaredStatus === 'passed' && get(document, 'handoff.stage') !== 'main') throw Error('办公机交付不能声明主力机安装/设备/模型验收通过');
    }
  } catch (error) { result.status = 'invalid'; result.message = runtimeErrorMessage(error); }
  if (declaredStatus === 'passed' && result.status !== 'fresh') result.effectiveStatus = result.status === 'unknown' ? 'unknown' : 'stale';
  Object.defineProperty(freshness.gates, field, { value: result, enumerable: true, configurable: true, writable: true });
  return result;
}
function bindGate(root: string, value: unknown, dependsOn: IdentityGroup[], identities: Record<IdentityGroup, Snapshot>, machine: Machine): GateBinding {
  const reports = reportPaths(value).map(name => fileEntry(root, relative(name)));
  if (!reports.every(v => v.status === 'file')) throw Error('结果引用的日志/报告缺失、不安全或不可读');
  if (state(value) === 'passed' && !reports.length) throw Error('通过结果必须提供 root 内实际 log/transcript/report 文件');
  return { dependsOn, identities: Object.fromEntries(dependsOn.map(k => [k, identities[k].sha256])), machine, reports };
}
export = { inspectTracking, inspectGate, bindGate };
