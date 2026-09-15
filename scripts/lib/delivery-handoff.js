'use strict';
const { object, canonical, evidencePath, fileEntry, readJson } = require('./delivery-paths');
const { snapshot, repository, HASH } = require('./delivery-identity');
const { get, set, state, gatePath, MAIN_FIELDS } = require('./delivery-state');
const { inspectTracking, inspectGate, bindGate } = require('./delivery-freshness');
const { createFinalization, inspectFinalization } = require('./delivery-finalize');

const environment = machine => ({ machine, platform: process.platform, node: process.version, arch: process.arch });
const mainRequirements = [
  { field: 'installation', machine: 'main', action: '通过 deploy-desktop.bat 安装并保留实际结果' },
  { field: 'deviceAcceptance', machine: 'main', action: '原生桌面、4K、Windows 150% 缩放验收' },
  { field: 'modelAcceptance', machine: 'main', action: '实际模型/GPU 调用与真实画面验收' },
];
function handoff(document, repo, officeEnvironment, machine, previous) {
  return { schemaVersion: 1, from: 'office', to: 'main', stage: machine,
    commit: repo,
    source: { sha256: document.tracking.source.sha256, status: document.tracking.source.status },
    build: { sha256: document.tracking.build.sha256, status: document.tracking.build.status },
    environment: { office: officeEnvironment, main: machine === 'main' ? document.environment : { status: 'pending' } },
    install: { field: 'installation', machine: 'main', entry: 'deploy-desktop.bat' },
    requiredMain: mainRequirements,
    ...(previous ? { previous } : {}),
  };
}
function capture(root, options) {
  const machine = options.machine || 'office';
  if (!['office', 'main'].includes(machine)) throw Error('machine 必须为 office/main');
  if (options.finalizeCommit && (!options.baseline || machine !== 'office')) throw Error('finalize 需要办公机 baseline');
  const repo = repository(root);
  if (!options.baseline) {
    if (machine !== 'office' || options.record) throw Error('主力机接收/记录结果必须提供 --baseline');
    const source = snapshot(root, options.source), build = snapshot(root, options.build);
    const gates = options.gates || { 'checks.office': ['source', 'build'] };
    if (!object(gates) || !Object.keys(gates).length || !options.scope?.trim()) throw Error('必须提供 scope 与明确门禁');
    const document = { schemaVersion: 1, kind: 'office-main-handoff', capturedAt: new Date().toISOString(),
      ...(repo.commit ? { commit: repo.commit } : {}), scope: options.scope, environment: environment(machine),
      build: { manifestSha256: build.sha256 }, tracking: { schemaVersion: 1, algorithm: 'sha256', source, build, gates: {} } };
    for (const [field, dependsOn] of Object.entries(gates)) {
      if (!gatePath(field) || !Array.isArray(dependsOn) || !dependsOn.length || new Set(dependsOn).size !== dependsOn.length
        || dependsOn.some(k => !['source', 'build'].includes(k))) throw Error(`门禁配置无效: ${field}`);
      set(document, field, { status: 'unrun' });
      document.tracking.gates[field] = bindGate(root, get(document, field), dependsOn, { source, build }, machine);
    }
    for (const field of MAIN_FIELDS) {
      document[field] = { status: 'pending', machine: 'main', reason: '需主力机实际执行并记录' };
      document.tracking.gates[field] = bindGate(root, document[field], ['source', 'build'], { source, build }, 'main');
    }
    document.handoff = handoff(document, repo, document.environment, machine);
    return document;
  }
  const baseline = readJson(root, options.baseline, true);
  const original = baseline.value;
  if (original.schemaVersion !== 1 || original.kind !== 'office-main-handoff') throw Error('baseline 必须是版本化交接快照，旧结果不能补签成新通过');
  const freshness = inspectTracking(root, original);
  if (freshness.status !== 'fresh') throw Error('baseline 的输入/构建已改变或不可用；重新建立快照并复验');
  if (!repo.commit || (!options.finalizeCommit && original.commit !== repo.commit)) throw Error('当前 HEAD 与交接 baseline 不一致或未知');
  const prior = inspectHandoff(root, original, freshness, { allowHeadMismatch: Boolean(options.finalizeCommit) });
  if (!prior || prior.errors.length || !original.handoff?.environment?.office) throw Error(`baseline 交接结构不完整: ${prior?.errors.join('; ') || '缺少 handoff'}`);
  if (machine === 'office' && original.handoff.stage !== 'office') throw Error('不能将主力机记录降级为办公机记录');
  const resultRecord = options.record ? readJson(root, options.record, true) : null;
  const document = structuredClone(original), results = resultRecord?.value || {};
  if (options.record && results.schemaVersion !== 1) throw Error('结果记录需要 schemaVersion: 1');
  if (options.record && (typeof results.baselineSha256 !== 'string' || results.baselineSha256.toLowerCase() !== baseline.entry.sha256)) throw Error('结果必须用 baselineSha256 明确绑定执行前快照，旧无追踪结果不能补签');
  if (results.checks !== undefined && !object(results.checks)) throw Error('结果 checks 必须为对象');
  if (results.commit !== undefined && results.commit !== original.commit) throw Error('结果记录提交与 baseline 不一致');
  if (results.build !== undefined && canonical(results.build) !== canonical(original.build)) throw Error('结果记录构建与 baseline 不一致');
  const declaredFields = [...['fullGate', 'gate', ...MAIN_FIELDS].filter(k => results[k] !== undefined),
    ...Object.keys(object(results.checks) ? results.checks : {}).map(k => `checks.${k}`)];
  for (const field of declaredFields) if (!Object.hasOwn(original.tracking.gates, field)) throw Error(`结果字段未在 baseline 声明: ${field}`);
  for (const [field, binding] of Object.entries(original.tracking.gates)) {
    const value = get(results, field);
    if (value === undefined) {
      const checked = inspectGate(root, original, freshness, field);
      if (checked.status === 'invalid' || (checked.declaredStatus === 'passed' && checked.status !== 'fresh')) throw Error(`旧结果已陈旧/不可用: ${field}`);
      continue;
    }
    if (!object(value) || (value.status === undefined && value.result === undefined && typeof value.passed !== 'boolean')) throw Error(`结果没有明确状态: ${field}`);
    if (MAIN_FIELDS.includes(field) && machine !== 'main' && state(value) === 'passed') throw Error('办公机不能登记主力机验收通过');
    const resultMachine = MAIN_FIELDS.includes(field) ? 'main' : machine;
    if (value.machine !== undefined && value.machine !== resultMachine) throw Error(`结果声明机器不匹配: ${field}`);
    if (value.commit !== undefined && value.commit !== original.commit) throw Error(`此项结果属于另一提交: ${field}`);
    if (value.build !== undefined && canonical(value.build) !== canonical(original.build)) throw Error(`此项结果属于另一构建: ${field}`);
    set(document, field, value);
    document.tracking.gates[field] = bindGate(root, value, binding.dependsOn, original.tracking, resultMachine);
  }
  document.capturedAt = new Date().toISOString();
  if (options.finalizeCommit) {
    document.finalization = createFinalization(root, document, baseline, resultRecord, options.finalizeCommit, repo);
    document.commit = options.finalizeCommit;
  }
  document.environment = environment(machine);
  document.handoff = handoff(document, repo, original.handoff.environment.office, machine, baseline.entry);
  if (resultRecord) document.handoff.resultRecord = resultRecord.entry;
  if (inspectTracking(root, document).status !== 'fresh') throw Error('绑定结果期间输入/构建发生变化');
  if (options.finalizeCommit && repository(root).commit !== document.commit) throw Error('finalize 期间 HEAD 发生变化');
  // This is a declared result plus immutable file references, never a gate runner.
  return document;
}
function inspectHandoff(root, document, freshness, options = {}) {
  const value = document.handoff;
  if (value === undefined) return null;
  const result = { status: 'pending', errors: [], pending: [], source: freshness.source, build: freshness.build };
  try {
    if (!object(value) || value.schemaVersion !== 1 || value.from !== 'office' || value.to !== 'main'
      || !['office', 'main'].includes(value.stage)) throw Error('handoff 格式或方向不支持');
    if (value.commit?.commit !== (document.commit ?? null) || value.source?.sha256 !== document.tracking?.source?.sha256
      || value.build?.sha256 !== document.tracking?.build?.sha256 || document.build?.manifestSha256 !== value.build?.sha256) throw Error('交接的 commit/source/build 身份不一致');
    if (canonical(value.requiredMain) !== canonical(mainRequirements) || value.install?.field !== 'installation'
      || value.install?.machine !== 'main' || value.install?.entry !== 'deploy-desktop.bat') throw Error('主力机待验项目或安装入口缺失/改变');
    if (value.environment?.office?.machine !== 'office' || !value.environment.office.platform || !value.environment.office.node
      || document.environment?.machine !== value.stage) throw Error('交接机器环境缺失或矛盾');
    if (value.stage === 'main' && (value.environment.main?.machine !== 'main' || canonical(value.environment.main) !== canonical(document.environment))) throw Error('主力机环境记录缺失或矛盾');
    if (value.stage === 'office' && canonical(value.environment.office) !== canonical(document.environment)) throw Error('办公机环境记录不一致');
    result.stage = value.stage;
    result.environment = value.environment;
    result.install = value.install;
    result.requiredMain = value.requiredMain.map(item => ({ ...item, status: state(document[item.field]) }));
    const repo = repository(root);
    result.commit = { expected: document.commit ?? null, actual: repo.commit,
      status: !repo.commit || !document.commit ? 'unknown' : document.commit === repo.commit ? 'matched' : 'mismatch' };
    if (result.commit.status === 'mismatch' && !options.allowHeadMismatch) result.errors.push('交接最终 commit 与当前 HEAD 不同');
    if (result.commit.status === 'unknown') result.pending.push('当前 HEAD 或交接最终 commit 未知');
    for (const field of ['previous', 'resultRecord']) if (value[field] !== undefined) {
      const record = value[field];
      if (!object(record) || !HASH.test(record.sha256)) throw Error(`交接 ${field} 格式错误`);
      const actual = fileEntry(root, evidencePath(record.path));
      if (actual.status !== 'file' || record.sha256 !== actual.sha256) throw Error(`交接 ${field} 索引文件缺失/改变/不安全`);
    }
    if (value.stage === 'main' && !value.previous) throw Error('主力机记录缺少前阶段证据索引');
    if (document.finalization !== undefined) {
      result.finalization = freshness.finalization = inspectFinalization(root, document);
      if (result.finalization.status !== 'matched') result.errors.push(`finalize: ${result.finalization.message}`);
    }
    for (const field of MAIN_FIELDS) {
      const checked = inspectGate(root, document, freshness, field);
      if (checked.status === 'invalid') result.errors.push(`${field}: ${checked.message}`);
      if (checked.effectiveStatus !== 'passed') result.pending.push(`${field}: ${checked.effectiveStatus}`);
      result.requiredMain.find(item => item.field === field).status = checked.effectiveStatus;
    }
  } catch (error) { result.errors.push(error.message); }
  result.status = result.errors.length ? 'failed' : result.pending.length ? 'pending' : 'passed';
  return result;
}
module.exports = { capture, inspectHandoff, mainRequirements };
