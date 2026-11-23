import type { ManifestEntry, ManifestIssue } from '../resource-manifest-types';
import { checkManifestPath } from './paths';

export const SCHEMA_VERSION = 1;

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export function comparePath(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 清单结构检查（纯函数，不触 fs，核验与比较共用同一套检查）：对象/schemaVersion/
 * entries 数组/unverified 形态、逐条目 path/bytes/sha256 类型、Windows 大小写与精确
 * 重复、路径合规。返回 errors、listed（含坏条目在内的条目数）、byPath（唯一路径 →
 * { count, bytes, sha256 }）与 invalidPaths（路径合规失败的路径，调用方跳过其后续
 * fs 检查，比较端不得用其产出差异）。
 */
export function parseManifestStructure(manifest: unknown) {
  const errors: ManifestIssue[] = [];
  const push = (error: ManifestIssue) => errors.push(error);
  const byPath = new Map<string, { count: number; bytes: number; sha256: string }>();
  const invalidPaths = new Set<string>();
  const empty = () => ({ errors, listed: 0, byPath, invalidPaths });
  if (!object(manifest)) {
    push({ code: 'bad-manifest', message: '清单必须是 JSON 对象' });
    return empty();
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    push({ code: 'unsupported-schema', message: `不支持的 schemaVersion: ${JSON.stringify(manifest.schemaVersion)}（本工具支持 ${SCHEMA_VERSION}）` });
    return empty();
  }
  if (!Array.isArray(manifest.entries)) {
    push({ code: 'bad-manifest', message: 'entries 必须是数组' });
    return empty();
  }
  if (manifest.unverified !== undefined) {
    if (!Array.isArray(manifest.unverified)) {
      push({ code: 'bad-manifest', message: 'unverified 必须是数组' });
    } else if (manifest.unverified.length) {
      push({ code: 'unverified-items', count: manifest.unverified.length, message: '清单仍包含未核验项；已列条目字节正确不代表完整清单通过' });
    }
  }
  const pathIdentities = new Map<string, string>();
  let listed = 0;
  for (const entry of manifest.entries) {
    listed++;
    if (!object(entry)) {
      push({ code: 'bad-entry', message: '条目必须是对象' });
      continue;
    }
    const { path: rel, bytes, sha256 } = entry;
    if (typeof rel !== 'string' || rel === '') {
      push({ code: 'bad-entry', message: '条目缺少非空字符串 path' });
      continue;
    }
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes < 0) {
      push({ path: rel, code: 'bad-entry', message: `bytes 必须是非负整数，收到 ${JSON.stringify(bytes)}` });
      continue;
    }
    if (typeof sha256 !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sha256)) {
      push({ path: rel, code: 'bad-entry', message: 'sha256 必须是 64 位十六进制字符串' });
      continue;
    }
    const identity = process.platform === 'win32' ? rel.toLowerCase() : rel;
    const previous = pathIdentities.get(identity);
    if (previous !== undefined && previous !== rel) {
      push({ path: rel, code: 'duplicate-path', message: '路径与 ' + previous + ' 指向相同的 Windows 路径' });
      push({ path: previous, code: 'duplicate-path', message: '路径存在 Windows 大小写重复条目' });
    }
    pathIdentities.set(identity, rel);
    byPath.set(rel, { count: (byPath.get(rel)?.count || 0) + 1, bytes, sha256 });
  }
  for (const [rel, record] of byPath) {
    if (record.count > 1) push({ path: rel, code: 'duplicate-path', message: `路径在清单中出现 ${record.count} 次` });
    const check = checkManifestPath(rel);
    if (!check.ok) {
      push({ path: rel, code: check.code, message: check.message });
      invalidPaths.add(rel);
    }
  }
  return { errors, listed, byPath, invalidPaths };
}

/**
 * 差异比较结果的范围说明（G7）：identical 只覆盖两份清单已列条目；「完整一致」
 * 的成功结论要求 ok 且 identical 同时为真。
 */
export const DIFF_SCOPE = Object.freeze({
  basis: '按精确路径比较两份清单已列条目；不读取实际资产；不用 generatedAt 判定新旧；不按相同哈希猜测重命名',
  coverageNote: '一致仅表示两份清单已列条目的集合与记录内容一致；不证明目录覆盖完整、当前文件存在、内容已审核或已交付。「完整一致」结论要求 ok 且 identical 同时为真',
});

/**
 * 纯比较两份清单对象（G7，不触 fs、不读取实际资产）：先做与核验一致的结构检查；
 * 除非空 unverified 外的任何结构错误（坏格式、不支持 schema、坏条目、重复或非法/
 * 越界路径）都阻止差异计算——不可信的条目集合不产出可信差异；非空 unverified 时
 * 仍比较已列条目，但整体 ok=false，不构成「完整一致」的成功结论。old→new 由调用
 * 参数顺序决定；结果路径按码元顺序稳定排序。
 */
export function compareManifests({ oldManifest, newManifest }: { oldManifest: unknown; newManifest: unknown }) {
  const oldStructure = parseManifestStructure(oldManifest);
  const newStructure = parseManifestStructure(newManifest);
  const errors = [
    ...oldStructure.errors.map((e) => ({ ...e, side: 'old' })),
    ...newStructure.errors.map((e) => ({ ...e, side: 'new' })),
  ];
  const added: ManifestEntry[] = [];
  const removed: ManifestEntry[] = [];
  const changed: Array<{ path: string; before: Omit<ManifestEntry, 'path'>; after: Omit<ManifestEntry, 'path'> }> = [];
  const result = {
    schemaVersion: SCHEMA_VERSION,
    kind: 'resource-manifest-diff',
    ok: errors.length === 0,
    identical: false,
    totals: { added: 0, removed: 0, changed: 0, unchanged: 0 },
    added,
    removed,
    changed,
    errors,
    scope: DIFF_SCOPE,
  };
  const blocking = (list: ManifestIssue[]) => list.some((e) => e.code !== 'unverified-items');
  if (blocking(oldStructure.errors) || blocking(newStructure.errors)) return result;
  let unchanged = 0;
  for (const [rel, before] of oldStructure.byPath) {
    const after = newStructure.byPath.get(rel);
    if (!after) {
      removed.push({ path: rel, bytes: before.bytes, sha256: before.sha256 });
    } else if (after.bytes !== before.bytes || after.sha256.toLowerCase() !== before.sha256.toLowerCase()) {
      changed.push({ path: rel, before: { bytes: before.bytes, sha256: before.sha256 }, after: { bytes: after.bytes, sha256: after.sha256 } });
    } else {
      unchanged++;
    }
  }
  for (const [rel, entry] of newStructure.byPath) {
    if (!oldStructure.byPath.has(rel)) added.push({ path: rel, bytes: entry.bytes, sha256: entry.sha256 });
  }
  const byPathOrder = (a: { path: string; }, b: { path: string; }) => comparePath(a.path, b.path);
  added.sort(byPathOrder);
  removed.sort(byPathOrder);
  changed.sort(byPathOrder);
  result.totals = { added: added.length, removed: removed.length, changed: changed.length, unchanged };
  result.identical = added.length === 0 && removed.length === 0 && changed.length === 0;
  return result;
}
