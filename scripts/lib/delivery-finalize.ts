import { errorMessage as runtimeErrorMessage } from './runtime-errors';
import type { Finalization, FinalizationInspection, GateOrigin, JsonRecord, ReadRecord, Repository, TrackedDocument } from './delivery-types';
'use strict';
const { object, canonical, sha256, readJson }: typeof import('./delivery-paths') = require('./delivery-paths');
const { trackedDocument }: typeof import('./delivery-records') = require('./delivery-records');
const { get, set, state, MAIN_FIELDS }: typeof import('./delivery-state') = require('./delivery-state');
const { COMMIT, ancestor, sourceProof }: typeof import('./delivery-git-proof') = require('./delivery-git-proof');

type LineageNode = ReadRecord<TrackedDocument & { commit: string; handoff: JsonRecord }> & {
  record: ReadRecord | null; executionCommit: unknown;
};

function reference(root: string, entry: unknown) {
  if (!object(entry) || typeof entry.path !== 'string') throw Error('finalize 缺少证据文件索引');
  const read = readJson(root, entry.path, true);
  if (read.entry.sha256 !== entry.sha256 || read.entry.bytes !== entry.bytes) throw Error(`finalize 证据文件缺失/改变: ${entry.path}`);
  return read;
}
function resultFor(root: string, entry: unknown, baseline: ReadRecord) {
  const read = reference(root, entry), value = read.value;
  if (value.schemaVersion !== 1 || typeof value.baselineSha256 !== 'string'
    || value.baselineSha256.toLowerCase() !== baseline.entry.sha256) throw Error('finalize 结果未绑定执行前快照');
  if (value.commit !== undefined && value.commit !== baseline.value.commit) throw Error('finalize 结果声明提交与执行前 HEAD 不符');
  if (value.build !== undefined && canonical(value.build) !== canonical(baseline.value.build)) throw Error('finalize 结果构建身份不符');
  return read;
}
// Walk only the explicitly linked, immutable delivery chain; no latest-file scan.
function lineage(root: string, first: ReadRecord): LineageNode[] {
  const nodes: LineageNode[] = [], seen = new Set<string>(); let current: ReadRecord | null = first;
  while (current) {
    if (nodes.length >= 64 || seen.has(current.entry.path)) throw Error('finalize 证据链循环或超过 64 阶段');
    seen.add(current.entry.path);
    const value = trackedDocument(current.value);
    if (value.schemaVersion !== 1 || value.kind !== 'office-main-handoff' || !object(value.handoff) || value.handoff.stage !== 'office'
      || typeof value.commit !== 'string' || !COMMIT.test(value.commit) || get(value.handoff, 'commit.commit') !== value.commit) throw Error('finalize 需要明确办公机 HEAD 与交接链');
    for (const group of ['source', 'build'] as const) {
      if (value.tracking[group].sha256 !== get(first.value, `tracking.${group}.sha256`)) throw Error('finalize 证据链源码/构建发生过变化');
    }
    const previous: ReadRecord | null = value.handoff.previous ? reference(root, value.handoff.previous) : null;
    if (value.handoff.resultRecord && !previous) throw Error('finalize 执行结果缺少前阶段快照');
    const record = value.handoff.resultRecord && previous ? resultFor(root, value.handoff.resultRecord, previous) : null;
    nodes.push({ ...current, value: { ...value, commit: value.commit, handoff: value.handoff }, record, executionCommit: previous?.value.commit });
    current = previous;
  }
  return nodes;
}
function gateFingerprint(value: unknown, binding: unknown) {
  return { valueSha256: sha256(canonical(value)), bindingSha256: sha256(canonical(binding)) };
}
function origins(root: string, nodes: LineageNode[], appended: ReadRecord | null): Record<string, GateOrigin> {
  // Lazy import keeps the freshness -> commit relation dependency acyclic.
  const { bindGate }: typeof import('./delivery-freshness') = require('./delivery-freshness');
  const first = nodes[0], tested = structuredClone(first.value);
  if (appended) {
    if (appended.value.checks !== undefined && !object(appended.value.checks)) throw Error('finalize 结果 checks 无效');
    for (const field of Object.keys(tested.tracking.gates)) {
      const value = get(appended.value, field);
      if (value === undefined) continue;
      if (!object(value) || (value.commit !== undefined && value.commit !== tested.commit)) throw Error('finalize 单项结果提交不符');
      const machine = MAIN_FIELDS.includes(field) ? 'main' : 'office';
      if (value.machine !== undefined && value.machine !== machine) throw Error('finalize 结果机器不符');
      if (machine === 'main' && state(value) === 'passed') throw Error('finalize 不能授予主力验收通过');
      set(tested, field, value);
      tested.tracking.gates[field] = bindGate(root, value, tested.tracking.gates[field].dependsOn, tested.tracking, machine);
    }
  }
  const candidates = [
    ...(appended ? [{ record: appended, executionCommit: first.value.commit }] : []),
    ...nodes.filter((node): node is LineageNode & { record: ReadRecord } => node.record !== null),
  ];
  const result: Record<string, GateOrigin> = {};
  for (const [field, binding] of Object.entries(tested.tracking.gates)) {
    if (MAIN_FIELDS.includes(field)) continue;
    const value = get(tested, field), candidate = candidates.find(node => get(node.record.value, field) !== undefined);
    if (binding.machine !== 'office') throw Error('finalize 只能关联办公机门禁');
    if (candidate && canonical(get(candidate.record.value, field)) !== canonical(value)) throw Error(`finalize 门禁与原始结果不符: ${field}`);
    if (!candidate && state(value) === 'passed') throw Error(`finalize 门禁缺少执行结果索引: ${field}`);
    const executionCommit = candidate?.executionCommit || nodes.at(-1)!.value.commit;
    if (typeof executionCommit !== 'string' || !COMMIT.test(executionCommit)
      || (get(value, 'commit') !== undefined && get(value, 'commit') !== executionCommit)) throw Error(`finalize 门禁执行 HEAD 不符: ${field}`);
    const expectedBinding = bindGate(root, value, binding.dependsOn, tested.tracking, 'office');
    if (canonical(expectedBinding) !== canonical(binding)) throw Error(`finalize 门禁日志或绑定已改变: ${field}`);
    result[field] = { executionCommit, ...gateFingerprint(value, binding),
      ...(candidate ? { resultRecord: candidate.record.entry } : {}) };
  }
  return result;
}
function createFinalization(root: string, document: TrackedDocument, baseline: ReadRecord, resultRecord: ReadRecord | null, finalCommit: string, repo: Repository): Finalization {
  if (!COMMIT.test(finalCommit) || repo.commit !== finalCommit) throw Error('显式 finalCommit 必须等于当前 HEAD');
  // lineage starts with the supplied baseline, so a successful result is nonempty.
  const nodes = lineage(root, baseline), original = nodes.at(-1)!;
  ancestor(root, original.value.commit, finalCommit);
  ancestor(root, nodes[0].value.commit, finalCommit);
  const appended = resultRecord ? resultFor(root, resultRecord.entry, baseline) : null;
  const gates = origins(root, nodes, appended);
  for (const [field, origin] of Object.entries(gates)) {
    const actual = gateFingerprint(get(document, field), document.tracking.gates[field]);
    if (actual.valueSha256 !== origin.valueSha256 || actual.bindingSha256 !== origin.bindingSha256) throw Error(`finalize 不得重写已测结果: ${field}`);
  }
  return { schemaVersion: 1, baselineHead: original.value.commit, finalCommit, previousCommit: nodes[0].value.commit,
    baseline: original.entry, evidence: baseline.entry, lineage: nodes.map(node => node.entry),
    ...(appended ? { resultRecord: appended.entry } : {}),
    sourceSha256: document.tracking.source.sha256, buildSha256: document.tracking.build.sha256,
    sourceProof: sourceProof(root, finalCommit, document.tracking.source), gates,
    worktree: { baseline: get(original.value.handoff, 'commit.worktree'), final: repo.worktree,
      source: 'matches-final-commit', sourceIndex: 'matches-final-commit', scope: 'selected-source-only' } };
}
function inspectFinalization(root: string, document: unknown): FinalizationInspection | null {
  const value = get(document, 'finalization');
  if (value === undefined) return null;
  try {
    if (!object(value) || value.schemaVersion !== 1 || typeof value.finalCommit !== 'string'
      || value.finalCommit !== get(document, 'commit')) throw Error('finalize 身份或版本无效');
    const first = reference(root, value.evidence), nodes = lineage(root, first), original = nodes.at(-1)!;
    if (canonical(value.baseline) !== canonical(original.entry) || value.baselineHead !== original.value.commit
      || value.previousCommit !== first.value.commit || canonical(value.lineage) !== canonical(nodes.map(n => n.entry))) throw Error('finalize 基线 HEAD/阶段关系不一致');
    if (value.sourceSha256 !== get(document, 'tracking.source.sha256') || value.buildSha256 !== get(document, 'tracking.build.sha256')
      || value.sourceSha256 !== nodes[0].value.tracking.source.sha256 || value.buildSha256 !== nodes[0].value.tracking.build.sha256) throw Error('finalize 源码/构建身份被替换');
    ancestor(root, original.value.commit, value.finalCommit); ancestor(root, nodes[0].value.commit, value.finalCommit);
    const appended = value.resultRecord ? resultFor(root, value.resultRecord, first) : null;
    const gates = origins(root, nodes, appended);
    if (canonical(value.gates) !== canonical(gates)) throw Error('finalize 原始结果/日志/执行 HEAD 关系不一致');
    const proof = sourceProof(root, value.finalCommit, get(document, 'tracking.source'));
    if (canonical(proof) !== canonical(value.sourceProof)) throw Error('finalize 提交源码证明不一致');
    if (!object(value.worktree) || value.worktree.source !== 'matches-final-commit' || value.worktree.sourceIndex !== 'matches-final-commit'
      || value.worktree.baseline !== get(original.value.handoff, 'commit.worktree')
      || (value.worktree.final !== 'clean' && value.worktree.final !== 'dirty') || value.worktree.scope !== 'selected-source-only') throw Error('finalize 工作树证明不完整');
    return { status: 'matched', baselineHead: original.value.commit, finalCommit: value.finalCommit,
      worktree: value.worktree, sourceProof: proof, gates };
  } catch (error) { return { status: 'invalid', message: runtimeErrorMessage(error) }; }
}
function isReboundGate(document: unknown, field: string, verdict: FinalizationInspection | null | undefined) {
  const origin = verdict?.status === 'matched' ? verdict.gates?.[field] : null, value = get(document, field);
  if (!origin || MAIN_FIELDS.includes(field) || get(value, 'commit') !== origin.executionCommit) return false;
  const gates = get(document, 'tracking.gates');
  const actual = gateFingerprint(value, object(gates) ? gates[field] : undefined);
  return actual.valueSha256 === origin.valueSha256 && actual.bindingSha256 === origin.bindingSha256;
}
export = { createFinalization, inspectFinalization, isReboundGate };
