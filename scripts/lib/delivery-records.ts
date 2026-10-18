import type { GateBinding, JsonRecord, Tracking, TrackedDocument } from './delivery-types';
const { object }: typeof import('./delivery-paths') = require('./delivery-paths');
const { HASH, validateSnapshot }: typeof import('./delivery-identity') = require('./delivery-identity');
const { gatePath, identityGroup, MAIN_FIELDS }: typeof import('./delivery-state') = require('./delivery-state');

function readGateBinding(value: unknown): GateBinding {
  if (!object(value) || !Array.isArray(value.dependsOn) || !value.dependsOn.length
    || new Set(value.dependsOn).size !== value.dependsOn.length
    || !value.dependsOn.every(identityGroup) || !object(value.identities)
    || (value.machine !== 'office' && value.machine !== 'main')) throw Error('门禁依赖绑定格式错误');
  for (const key of ['source', 'build'] as const) {
    const hash = value.identities[key];
    if ((value.dependsOn.includes(key) || hash !== undefined)
      && (typeof hash !== 'string' || !HASH.test(hash))) throw Error('门禁依赖身份格式错误');
  }
  if (!Array.isArray(value.reports)) throw Error('缺少报告文件绑定列表');
  const reports: unknown[] = value.reports;
  for (const entry of reports) {
    if (!object(entry) || entry.status !== 'file' || typeof entry.path !== 'string'
      || typeof entry.sha256 !== 'string' || !HASH.test(entry.sha256)
      || typeof entry.bytes !== 'number' || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0) throw Error('报告文件身份不完整');
  }
  // Keep extension fields and the original representation for fingerprinting.
  return value as GateBinding;
}

function readTracking(value: unknown): Tracking {
  if (!object(value) || value.schemaVersion !== 1 || value.algorithm !== 'sha256' || !object(value.gates)
    || Object.keys(value.gates).some(k => !gatePath(k) && !MAIN_FIELDS.includes(k))) throw Error('tracking 格式或版本不支持');
  validateSnapshot(value.source);
  validateSnapshot(value.build);
  for (const binding of Object.values(value.gates)) readGateBinding(binding);
  return value as Tracking;
}

function trackedDocument(value: JsonRecord): TrackedDocument {
  return { ...value, tracking: readTracking(value.tracking) };
}

export = { readGateBinding, trackedDocument };
