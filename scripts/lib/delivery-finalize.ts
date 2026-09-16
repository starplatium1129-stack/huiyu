import { errorMessage as runtimeErrorMessage } from './runtime-errors';
'use strict';
const { object, canonical, sha256, readJson }: typeof import('./delivery-paths') = require('./delivery-paths');
const { validateSnapshot }: typeof import('./delivery-identity') = require('./delivery-identity');
const { get, set, state, MAIN_FIELDS }: typeof import('./delivery-state') = require('./delivery-state');
const { COMMIT, ancestor, sourceProof }: typeof import('./delivery-git-proof') = require('./delivery-git-proof');

function reference(root: any, entry: any) {
  if (!object(entry)) throw Error('finalize 缺少证据文件索引');
  const read = readJson(root, entry.path, true);
  if (read.entry.sha256 !== entry.sha256 || read.entry.bytes !== entry.bytes) throw Error(`finalize 证据文件缺失/改变: ${entry.path}`);
  return read;
}
function resultFor(root: any, entry: any, baseline: any) {
  const read = reference(root, entry), value = read.value;
  if (value.schemaVersion !== 1 || typeof value.baselineSha256 !== 'string'
    || value.baselineSha256.toLowerCase() !== baseline.entry.sha256) throw Error('finalize 结果未绑定执行前快照');
  if (value.commit !== undefined && value.commit !== baseline.value.commit) throw Error('finalize 结果声明提交与执行前 HEAD 不符');
  if (value.build !== undefined && canonical(value.build) !== canonical(baseline.value.build)) throw Error('finalize 结果构建身份不符');
  return read;
}
// Walk only the explicitly linked, immutable delivery chain; no latest-file scan.
function lineage(root: any, first: any) {
  const nodes = [], seen = new Set(); let current = first;
  while (current) {
    if (nodes.length >= 64 || seen.has(current.entry.path)) throw Error('finalize 证据链循环或超过 64 阶段');
    seen.add(current.entry.path);
    const value = current.value;
    if (value.schemaVersion !== 1 || value.kind !== 'office-main-handoff' || value.handoff?.stage !== 'office'
      || !COMMIT.test(value.commit) || value.handoff?.commit?.commit !== value.commit) throw Error('finalize 需要明确办公机 HEAD 与交接链');
    for (const group of ['source', 'build']) {
      validateSnapshot(value.tracking?.[group]);
      if (value.tracking[group].sha256 !== first.value.tracking[group].sha256) throw Error('finalize 证据链源码/构建发生过变化');
    }
    const previous = value.handoff.previous ? reference(root, value.handoff.previous) : null;
    const record = value.handoff.resultRecord ? resultFor(root, value.handoff.resultRecord, previous || {}) : null;
    nodes.push({ ...current, record, executionCommit: previous?.value.commit });
    current = previous;
  }
  return nodes;
}
function gateFingerprint(value: any, binding: any) {
  return { valueSha256: sha256(canonical(value)), bindingSha256: sha256(canonical(binding)) };
}
function origins(root: any, nodes: any, appended: any) {
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
    ...nodes.filter((node: any) => node.record),
  ];
  const result: any = {};
  for (const [field, binding] of Object.entries<any>(tested.tracking.gates)) {
    if (MAIN_FIELDS.includes(field)) continue;
    const value = get(tested, field), candidate = candidates.find(node => get(node.record.value, field) !== undefined);
    if (binding.machine !== 'office') throw Error('finalize 只能关联办公机门禁');
    if (candidate && canonical(get(candidate.record.value, field)) !== canonical(value)) throw Error(`finalize 门禁与原始结果不符: ${field}`);
    if (!candidate && state(value) === 'passed') throw Error(`finalize 门禁缺少执行结果索引: ${field}`);
    const executionCommit = candidate?.executionCommit || nodes.at(-1).value.commit;
    if (!COMMIT.test(executionCommit) || (value?.commit !== undefined && value.commit !== executionCommit)) throw Error(`finalize 门禁执行 HEAD 不符: ${field}`);
    const expectedBinding = bindGate(root, value, binding.dependsOn, tested.tracking, 'office');
    if (canonical(expectedBinding) !== canonical(binding)) throw Error(`finalize 门禁日志或绑定已改变: ${field}`);
    result[field] = { executionCommit, ...gateFingerprint(value, binding),
      ...(candidate ? { resultRecord: candidate.record.entry } : {}) };
  }
  return result;
}
function createFinalization(root: any, document: any, baseline: any, resultRecord: any, finalCommit: any, repo: any) {
  if (!COMMIT.test(finalCommit) || repo.commit !== finalCommit) throw Error('显式 finalCommit 必须等于当前 HEAD');
  const nodes = lineage(root, baseline), original = nodes.at(-1);
  ancestor(root, original.value.commit, finalCommit);
  ancestor(root, baseline.value.commit, finalCommit);
  const appended = resultRecord ? resultFor(root, resultRecord.entry, baseline) : null;
  const gates = origins(root, nodes, appended);
  for (const [field, origin] of Object.entries<any>(gates)) {
    const actual = gateFingerprint(get(document, field), document.tracking.gates[field]);
    if (actual.valueSha256 !== origin.valueSha256 || actual.bindingSha256 !== origin.bindingSha256) throw Error(`finalize 不得重写已测结果: ${field}`);
  }
  return { schemaVersion: 1, baselineHead: original.value.commit, finalCommit, previousCommit: baseline.value.commit,
    baseline: original.entry, evidence: baseline.entry, lineage: nodes.map(node => node.entry),
    ...(appended ? { resultRecord: appended.entry } : {}),
    sourceSha256: document.tracking.source.sha256, buildSha256: document.tracking.build.sha256,
    sourceProof: sourceProof(root, finalCommit, document.tracking.source), gates,
    worktree: { baseline: original.value.handoff.commit.worktree, final: repo.worktree,
      source: 'matches-final-commit', sourceIndex: 'matches-final-commit', scope: 'selected-source-only' } };
}
function inspectFinalization(root: any, document: any) {
  const value = document.finalization;
  if (value === undefined) return null;
  const result: any = { status: 'invalid' };
  try {
    if (!object(value) || value.schemaVersion !== 1 || value.finalCommit !== document.commit) throw Error('finalize 身份或版本无效');
    const first = reference(root, value.evidence), nodes = lineage(root, first), original = nodes.at(-1);
    if (canonical(value.baseline) !== canonical(original.entry) || value.baselineHead !== original.value.commit
      || value.previousCommit !== first.value.commit || canonical(value.lineage) !== canonical(nodes.map(n => n.entry))) throw Error('finalize 基线 HEAD/阶段关系不一致');
    if (value.sourceSha256 !== document.tracking?.source?.sha256 || value.buildSha256 !== document.tracking?.build?.sha256
      || value.sourceSha256 !== first.value.tracking.source.sha256 || value.buildSha256 !== first.value.tracking.build.sha256) throw Error('finalize 源码/构建身份被替换');
    ancestor(root, value.baselineHead, value.finalCommit); ancestor(root, value.previousCommit, value.finalCommit);
    const appended = value.resultRecord ? resultFor(root, value.resultRecord, first) : null;
    if (canonical(value.gates) !== canonical(origins(root, nodes, appended))) throw Error('finalize 原始结果/日志/执行 HEAD 关系不一致');
    const proof = sourceProof(root, value.finalCommit, document.tracking.source);
    if (canonical(proof) !== canonical(value.sourceProof)) throw Error('finalize 提交源码证明不一致');
    if (value.worktree?.source !== 'matches-final-commit' || value.worktree?.sourceIndex !== 'matches-final-commit'
      || value.worktree.baseline !== original.value.handoff.commit.worktree
      || !['clean', 'dirty'].includes(value.worktree.final) || value.worktree.scope !== 'selected-source-only') throw Error('finalize 工作树证明不完整');
    Object.assign(result, { status: 'matched', baselineHead: value.baselineHead, finalCommit: value.finalCommit,
      worktree: value.worktree, sourceProof: proof, gates: value.gates });
  } catch (error) { result.message = runtimeErrorMessage(error); }
  return result;
}
function isReboundGate(document: any, field: any, verdict: any) {
  const origin = verdict?.status === 'matched' ? verdict.gates?.[field] : null, value = get(document, field);
  if (!origin || MAIN_FIELDS.includes(field) || value?.commit !== origin.executionCommit) return false;
  const actual = gateFingerprint(value, document.tracking.gates[field]);
  return actual.valueSha256 === origin.valueSha256 && actual.bindingSha256 === origin.bindingSha256;
}
export = { createFinalization, inspectFinalization, isReboundGate };
