import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { createHash }: typeof import('node:crypto') = require('node:crypto');
const { spawnSync }: typeof import('node:child_process') = require('node:child_process');
const { WORKFLOWS }: typeof import('../workflow') = require('../workflow');
const { formatReport }: typeof import('../lib/delivery-report-format') = require('../lib/delivery-report-format');
const { state }: typeof import('../lib/delivery-state') = require('../lib/delivery-state');
const { inspectTracking, inspectGate }: typeof import('../lib/delivery-freshness') = require('../lib/delivery-freshness');
const { inspectHandoff }: typeof import('../lib/delivery-handoff') = require('../lib/delivery-handoff');
const { validateSnapshot }: typeof import('../lib/delivery-identity') = require('../lib/delivery-identity');
const { isReboundGate }: typeof import('../lib/delivery-finalize') = require('../lib/delivery-finalize');
const ROOT = path.resolve(__dirname, '../..');
const text = (v: any) => typeof v === 'string' && v.trim().length > 0;
const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const get = (v: any, key: any) => key.split('.').reduce((a: any, k: any) => object(a) && Object.hasOwn(a, k) ? a[k] : undefined, v);
const help = 'audit:delivery --evidence <JSON> [--require <gate.path>] [--expect-commit <SHA>] [--expect-build <field=SHA256>] [--root <directory>] [--json] [--help] [--plan]\n--require 可重复；路径相对于证据根对象。未指定时识别 fullGate/gate/checks.fullGate/checks.gateFull。退出 0=记录检查通过，1=错误，2=输入错误，3=仍有未知/未运行/待验。只读，不执行推荐命令。';
function parse(args: any) {
  const o: any = { root: ROOT, require: [], builds: [], verifyFiles: [], fileHashes: [], comparisons: [] };
  const values: any = { '--evidence': 'evidence', '--root': 'root', '--expect-commit': 'commit', '--require': 'require', '--expect-build': 'builds', '--verify-file': 'verifyFiles', '--expect-file-sha256': 'fileHashes' };
  values['--compare-evidence'] = 'comparisons';
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (['--help', '--json', '--plan', '--check-head', '--check-worktree'].includes(flag)) { o[flag.slice(2)] = true; continue; }
    if (!values[flag] || !text(args[i + 1]) || args[i + 1].startsWith('--')) throw Error(`无效参数或缺值: ${flag}`);
    const key = values[flag], value = args[++i];
    if (Array.isArray(o[key])) o[key].push(value);
    else { if (key !== 'root' && o[key]) throw Error(`重复参数: ${flag}`); o[key] = value; }
  }
  if (!o.help && !o.evidence) throw Error('必须显式指定 --evidence');
  if (o.commit && !/^[a-f\d]{40}$/i.test(o.commit)) throw Error('--expect-commit 需要完整 Git SHA');
  if (o.builds.some((v: any) => !/^[\w.]+=[a-f\d]{64}$/i.test(v))) throw Error('--expect-build 需要 field=SHA256');
  if (o.require.some((v: any) => !/^[\w.-]+$/.test(v))) throw Error('--require 需要字段路径');
  if (o.fileHashes.some((v: any) => !/^.+=[a-f\d]{64}$/i.test(v))) throw Error('--expect-file-sha256 需要 相对root路径=64位SHA256');
  return o;
}
function report(o: any) {
  const root = fs.realpathSync(o.root);
  const r: any = { schemaVersion: 1, errors: [], passed: [], pending: [], limitations: [], records: [], recommendations: [], verifiedFiles: [] };
  const add = (bucket: any, file: any, field: any, message: any, status: any) => r[bucket].push({ file, field, message, ...(status ? { status } : {}) });
  if (o['check-worktree']) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]: any) => !/^GIT_/i.test(key)));
    const worktree = r.repositoryWorktree = { root, status: 'unavailable', changedFiles: [] };
    try {
      const result = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
        cwd: root, env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
        encoding: 'utf8', windowsHide: true, timeout: 10000,
      });
      if (result.error || result.status !== 0) throw Error(result.error?.message || result.stderr?.trim() || 'Git status 命令失败');
      if (typeof result.stdout !== 'string') throw Error('Git status 输出不可解析');
      worktree.rawPorcelain = result.stdout;
      const lines = result.stdout === '' ? [] : result.stdout.replace(/\r?\n$/, '').split(/\r?\n/);
      for (const raw of lines) {
        const xy = raw.slice(0, 2), file = raw.slice(3);
        const valid = xy === '??' || /^(DD|AU|UD|UA|DU|AA|UU)$/.test(xy)
          || (/^[ MTADRCT][ MTDRCT]$/.test(xy) && xy !== '  ');
        if (!valid || raw[2] !== ' ' || !file || /[\x00-\x1f]/.test(file)
          || (file.startsWith('"') && !file.endsWith('"'))) throw Error(`Git status 行不可解析: ${JSON.stringify(raw)}`);
        worktree.changedFiles.push({ kind: xy === '??' ? 'untracked' : 'uncommitted', indexStatus: xy[0], worktreeStatus: xy[1], pathPorcelain: file, raw });
      }
      worktree.status = lines.length ? 'dirty' : 'clean';
      worktree.message = lines.length ? '存在未提交或未跟踪文件，详见 changedFiles 与原始 porcelain 行' : 'Git status 未报告工作树或索引改动及未跟踪文件';
    } catch (e) { worktree.status = 'unavailable'; worktree.message = runtimeErrorMessage(e); }
    add(worktree.status === 'clean' ? 'passed' : 'errors', o.evidence, 'repositoryWorktree', worktree.message, worktree.status);
  }
  if (o['check-head']) {
    // Ignore inherited repository overrides so cwd selects the requested repository.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]: any) => !/^GIT_/i.test(key)));
    const result = spawnSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: root, env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    const head = result.stdout?.trim();
    r.repositoryHead = { root, commit: head && /^[a-f\d]{40,64}$/i.test(head) ? head : null, status: 'pending', evidenceCommit: null };
    r.limitations.push({ message: '只比较 HEAD commit，不覆盖 dirty working tree；不验证未提交工作树改动，不查询远端。' });
    if (result.error || result.status !== 0 || !r.repositoryHead.commit) {
      r.repositoryHead.status = 'unavailable';
      r.repositoryHead.message = result.error?.message || result.stderr?.trim() || 'Git HEAD commit 不可用';
      add('errors', o.evidence, 'repositoryHead', r.repositoryHead.message, 'unavailable');
    }
  }
  const outside = (value: any) => { const rel = path.relative(root, value); return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel); };
  const requests = [
    ...(o.verifyFiles || []).map((file: any) => ({ file })),
    ...(o.fileHashes || []).map((value: any) => ({ file: value.slice(0, -65), expectedSha256: value.slice(-64).toLowerCase() })),
  ];
  for (const request of requests) {
    const result: any = { ...request };
    try {
      // Reject lexical escapes as well as symlinks/junctions escaping the real root.
      if (!text(request.file) || path.isAbsolute(request.file) || path.win32.isAbsolute(request.file) || /^[a-z]:/i.test(request.file) || outside(path.resolve(root, request.file))) {
        result.status = 'outside-root'; throw Error('文件路径必须为 root 内相对路径');
      }
      const resolved = fs.realpathSync(path.resolve(root, request.file));
      if (outside(resolved)) { result.status = 'outside-root'; throw Error('文件真实路径越过 root'); }
      result.realPath = path.relative(root, resolved).replaceAll('\\', '/');
      if (!fs.statSync(resolved).isFile()) { result.status = 'not-file'; throw Error('目标不是普通文件'); }
      if (request.expectedSha256) {
        result.actualSha256 = createHash('sha256').update(fs.readFileSync(resolved)).digest('hex');
        if (result.actualSha256 !== request.expectedSha256) { result.status = 'mismatch'; throw Error('文件 SHA-256 与显式期望不匹配'); }
        result.status = 'matched';
      } else result.status = 'exists';
      add('passed', request.file, 'verifiedFiles', result.status, undefined);
    } catch (e) {
      result.status ||= ['ENOENT', 'ENOTDIR'].includes(runtimeErrorCode(e)) ? 'missing' : 'error';
      result.message = runtimeErrorMessage(e);
      add('errors', request.file, 'verifiedFiles', runtimeErrorMessage(e), result.status);
    }
    r.verifiedFiles.push(result);
  }
  function read(file: any) {
    const resolved = fs.realpathSync(path.resolve(root, file));
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error(`证据路径越过 root: ${file}`);
    const d = JSON.parse(fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, ''));
    if (!object(d)) throw Error(`证据必须为 JSON 对象: ${file}`);
    return { file: relative.replaceAll('\\', '/'), d };
  }
  // Comparison resolves at most one link; it never imports acceptance states.
  function comparisonIdentity(input: any) {
    function boundedRead(name: any) {
      if (!text(name) || path.isAbsolute(name) || path.win32.isAbsolute(name) || /^[a-z]:/i.test(name) || outside(path.resolve(root, name))) throw Error('比较证据必须为 root 内相对路径');
      return read(name);
    }
    const first = boundedRead(input), docs = [first];
    const isReceipt = (value: any) => text(value.evidence) && Object.hasOwn(value, 'commit');
    if (isReceipt(first.d)) {
      const linked = boundedRead(first.d.evidence);
      if (linked.d.schemaVersion !== 1 || isReceipt(linked.d)) throw Error('关联证据格式不支持');
      docs.push(linked);
    } else {
      if (first.d.schemaVersion !== 1) throw Error('比较仅支持 schemaVersion 1 或 delivery-receipt');
      if (first.d.delivery?.receipt !== undefined) {
        const linked = boundedRead(first.d.delivery.receipt);
        if (!isReceipt(linked.d)) throw Error('关联回执格式不支持');
        // Check the backlink lexically; do not follow a second link.
        if (path.resolve(root, linked.d.evidence) !== path.resolve(root, first.file)) throw Error('关联回执指向另一份证据');
        docs.push(linked);
      }
    }
    const ids: Record<string, any> = {};
    function id(key: any, value: any, length: any) {
      if (typeof value !== 'string' || !new RegExp(`^[a-f\\d]{${length}}$`, 'i').test(value)) throw Error(`无效标识: ${key}`);
      value = value.toLowerCase();
      if (ids[key] && ids[key] !== value) throw Error(`关联证据标识冲突: ${key}`);
      ids[key] = value;
    }
    for (const { d } of docs) {
      if (d.schemaVersion !== undefined && d.schemaVersion !== 1) throw Error('证据版本不支持');
      if (d.commit !== undefined) id('commit', d.commit, 40);
      for (const [key, value] of Object.entries(object(d.build) ? d.build : {})) {
        if (/Sha256$/.test(key) && !/source|snapshot|baseline/i.test(key)) id(`build.${key}`, value, 64);
      }
      if (d.browser?.distIndexSha256BeforeAndAfter !== undefined) id('build.distIndexSha256', d.browser.distIndexSha256BeforeAndAfter, 64);
      if (d.tracking !== undefined) {
        if (d.tracking?.schemaVersion !== 1) throw Error('输入追踪版本不支持');
        validateSnapshot(d.tracking.source); validateSnapshot(d.tracking.build);
        id('source.sha256', d.tracking.source.sha256, 64);
      }
    }
    if (!ids.commit) throw Error('缺少最终 commit，baseline 不能代替');
    if (Object.keys(ids).length < 2) throw Error('缺少可识别构建 SHA，source hash 不能代替');
    return { files: docs.map((v: any) => v.file), ids };
  }
  if (o.comparisons?.length) {
    r.comparisons = o.comparisons.map((input: any) => {
      const result: any = { file: input, status: 'failed', sharedIds: [] };
      try {
        result.primary = comparisonIdentity(o.evidence);
        result.other = comparisonIdentity(input);
        result.sharedIds = Object.keys(result.primary.ids).filter((key: any) => Object.hasOwn(result.other.ids, key));
        if (!result.sharedIds.some((key: any) => key.startsWith('build.'))) throw Error('两份证据没有共有的构建 SHA 字段');
        const mismatches = result.sharedIds.filter((key: any) => result.primary.ids[key] !== result.other.ids[key]);
        if (mismatches.length) throw Error(`交付标识不匹配: ${mismatches.join(', ')}`);
        result.status = 'matched';
        add('passed', input, 'comparisons', '共有最终提交及构建标识一致', undefined);
      } catch (e) { result.message = runtimeErrorMessage(e); add('errors', input, 'comparisons', runtimeErrorMessage(e), undefined); }
      return result;
    });
  }
  let primary;
  try { primary = read(o.evidence); } catch (e) { add('errors', o.evidence, '$', runtimeErrorMessage(e), undefined); return finish(); }
  const receipt = text(primary.d.evidence) && Object.hasOwn(primary.d, 'commit') ? primary : null;
  let evidence = primary;
  if (receipt) {
    try { evidence = read(receipt.d.evidence); } catch (e) { add('errors', receipt.file, 'evidence', runtimeErrorMessage(e), undefined); }
  }
  let delivery = receipt;
  if (!receipt && text(evidence.d.delivery?.receipt)) {
    try { delivery = read(evidence.d.delivery.receipt); } catch (e) { add('pending', evidence.file, 'delivery.receipt', runtimeErrorMessage(e), 'unknown'); }
  }
  const { d, file } = evidence;
  if (d.schemaVersion !== 1) add('errors', file, 'schemaVersion', '仅支持已有 schemaVersion: 1 的证据对象', undefined);
  const commit = delivery?.d.commit ?? d.commit;
  if (r.repositoryHead) {
    const head = r.repositoryHead;
    head.evidenceCommit = commit ?? null;
    if (head.status !== 'unavailable') {
      head.status = !commit ? 'missing-commit' : typeof commit !== 'string' || commit.toLowerCase() !== head.commit.toLowerCase() ? 'mismatch' : 'matched';
      head.message = head.status === 'matched' ? '证据最终 commit 与仓库 HEAD 一致' : head.status === 'missing-commit' ? '证据缺少最终 commit，不能用 baseline 代替' : '证据最终 commit 与仓库 HEAD 不匹配';
      add(head.status === 'matched' ? 'passed' : 'errors', file, 'repositoryHead', head.message, head.status);
    }
  }
  const baseline = d.baseline ?? d.baseCommit;
  for (const [field, value] of [['commit', commit], ['baseline', baseline]]) {
    if (value !== undefined && !/^[a-f\d]{40}$/i.test(value)) add('errors', file, field, '提交标识需要完整 Git SHA', undefined);
  }
  if (!commit) add('pending', file, 'commit', '基线提交不能证明最终交付提交', 'unknown');
  else add('passed', file, 'commit', commit, undefined);
  if (o.commit && commit !== o.commit) add('errors', file, 'commit', '与显式预期提交不匹配或缺失', undefined);
  if (delivery) {
    const q = delivery.d;
    if (d.commit !== undefined && d.commit !== q.commit) add('errors', delivery.file, 'commit', '回执与证据最终提交不匹配', undefined);
    if (q.baseline !== undefined && q.baseline !== baseline) add('errors', delivery.file, 'baseline', '回执与证据基线不匹配', undefined);
    if (q.remoteCommit !== undefined && q.remoteCommit !== q.commit) add('errors', delivery.file, 'remoteCommit', '远端记录与交付提交不匹配', undefined);
    if (q.pushExitCode !== undefined && q.pushExitCode !== 0) add('errors', delivery.file, 'pushExitCode', '记录的推送失败', undefined);
    try {
      if (read(q.evidence).file !== file) add('errors', delivery.file, 'evidence', '回执指向另一份证据', undefined);
    } catch (e) { add('errors', delivery.file, 'evidence', runtimeErrorMessage(e), undefined); }
  }
  const build = object(d.build) ? d.build : {};
  const ids = Object.entries(build).filter(([k]: any) => /Sha256$/.test(k) && !/source|snapshot|baseline/i.test(k));
  if (text(d.browser?.distIndexSha256BeforeAndAfter)) ids.push(['browser.distIndexSha256BeforeAndAfter', d.browser.distIndexSha256BeforeAndAfter]);
  if (!ids.length) add('pending', file, 'build', '缺少构建产物哈希；日志或源哈希不能代替构建标识', 'unknown');
  for (const [k, v] of ids) add(/^[a-f\d]{64}$/i.test(v) ? 'passed' : 'errors', file, `build.${k}`, String(v), undefined);
  for (const expected of o.builds || []) {
    const [field, hash] = expected.split('=');
    if (get(d, field) !== hash) add('errors', file, field, '构建证据与显式预期哈希不匹配或缺失', undefined);
    else add('passed', file, field, '与预期构建一致', undefined);
  }
  if (!text(d.scope)) add('pending', file, 'scope', '缺少明确执行范围', 'unknown');
  if (!object(d.environment) || !text(d.environment.platform)) add('pending', file, 'environment', '缺少结构化执行机器/platform；不从文件名或 prose 推断', 'unknown');
  if (!text(d.environment?.node)) add('pending', file, 'environment.node', '运行时版本未知', 'unknown');
  r.records.push({ file, commit: commit ?? null, baseline: baseline ?? null, scope: d.scope ?? null, environment: d.environment ?? null });
  const freshness: any = r.freshness = inspectTracking(root, d);
  if (freshness.status === 'unknown') add('pending', file, 'tracking', freshness.message, 'unknown');
  if (freshness.status === 'invalid') add('errors', file, 'tracking', freshness.message || '输入身份记录无效', 'invalid');
  for (const key of ['source', 'build']) if (freshness[key]) {
    const group = freshness[key];
    add(group.status === 'fresh' ? 'passed' : 'errors', file, `tracking.${key}`,
      group.message || (group.status === 'fresh' ? '所选文件集合及字节身份一致' : `已陈旧或不可用；${group.changes.length} 个路径变化`), group.status);
  }
  if (d.handoff !== undefined) {
    r.handoff = inspectHandoff(root, d, freshness);
    for (const message of r.handoff.errors) add('errors', file, 'handoff', message, 'failed');
    for (const message of r.handoff.pending) add('pending', file, 'handoff', message, 'pending');
  }
  const selected = o.require?.length ? o.require : ['fullGate', 'gate', 'checks.fullGate', 'checks.gateFull'].filter((k: any) => get(d, k) !== undefined);
  const tracked = object(d.tracking?.gates) ? Object.keys(d.tracking.gates).filter((k: any) => !['installation', 'deviceAcceptance', 'modelAcceptance'].includes(k)) : [];
  const required = [...new Set([...selected, ...tracked])];
  if (!required.length) add('pending', file, 'gates', '没有识别到必要门禁；请用 --require 指定已有字段', 'unknown');
  function check(field: any) {
    const v = get(d, field), declared = state(v), validity = inspectGate(root, d, freshness, field), s = validity.effectiveStatus;
    add(['failed', 'stale'].includes(s) ? 'errors' : s === 'passed' ? 'passed' : 'pending', file, field,
      `记录状态: ${declared}${s !== declared ? `；有效状态: ${s}；${validity.message || '需复验'}` : ''}`, s);
    if (validity.status === 'invalid') add('errors', file, `${field}.tracking`, validity.message, 'invalid');
    if (s === 'passed' && ![v.log, v.transcript, v.report, v.sha256].some(text)) add('pending', file, field, '缺少日志/报告索引，结果尚不可追溯', 'unknown');
    if (object(v) && v.commit !== undefined && v.commit !== commit && !isReboundGate(d, field, freshness.finalization)) add('errors', file, `${field}.commit`, '此项结果属于另一提交', undefined);
    if (object(v?.build)) for (const [key, value] of Object.entries(v.build)) {
      if (/Sha256$/.test(key) && build[key] !== value) add('errors', file, `${field}.build.${key}`, '此项结果构建与交付构建不匹配或无法关联', undefined);
    }
    if (delivery && get(delivery.d, field) !== undefined && state(get(delivery.d, field)) !== declared) add('errors', delivery.file, field, '回执与证据状态冲突', undefined);
  }
  required.forEach(check);
  for (const field of ['installation', 'deviceAcceptance', 'modelAcceptance']) check(field);
  for (const key of ['limitations', 'implementationLimits', 'deferred']) {
    if (Array.isArray(d[key])) d[key].forEach((v: any) => add('limitations', file, key, v, undefined));
  }
  r.limitations.push({ message: '显式文件及 tracking 中选定的文件集合/报告哈希只读复算；旧记录无追踪则新鲜度 unknown，不补签通过。不执行日志命令、不证明结果声明真实性或远端一致性；handoff 与 --check-head 分别核对当前 HEAD，均不代替机器验收。' });
  r.limitations.push({ message: '输入影响范围由明确选择项与门禁依赖决定，未选择的路径不受监测；.git 和专用 runtime/delivery-evidence 排除，时间/HEAD/环境不进入内容身份。日志语义、构建来源真实性、多阶段自动恢复/回滚、真实安装/模型/设备需另验；deployment 或相同 HEAD 不代替这些验收。' });
  r.recommendations = ['audit:delivery', 'check:workflows'].map((name: any) => ({ name, command: WORKFLOWS[name].cmd, nature: WORKFLOWS[name].run.nature, executed: false }));
  return finish();
  function finish() {
    r.status = r.errors.length ? 'failed' : r.pending.length ? 'pending' : 'passed';
    r.exitCode = r.errors.length ? 1 : r.pending.length ? 3 : 0;
    return r;
  }
}
function main(args: any) {
  let o;
  try { o = parse(args); } catch (e) { console.error(runtimeErrorMessage(e)); return 2; }
  if (o.help) console.log('带 tracking 的 schemaVersion 1 证据自动复算 source/build 文件集合与已绑定日志哈希，stale/缺失/不安全退出 1；旧无追踪通过声明降为 unknown，退出 3。handoff 分开 commit/source/build/environment/install 与主力机待验；新记录用 scripts/maintenance/capture-delivery.js。');
  if (o.help) console.log('--check-head：在 root 对应仓库只读执行 git rev-parse --verify HEAD^{commit}，独立 repositoryHead 比较证据最终 commit；缺失/不匹配/仓库不可用退出 1。只比较 HEAD commit，不覆盖 dirty working tree，不查询远端。--help/--plan 不执行 git。');
  if (o.help) console.log('--compare-evidence <root内相对JSON路径> 可重复；独立 comparisons 比较最终 commit 与共有构建 SHA，解析一层关联；缺失/不支持/越界/不匹配退出 1。不合并状态和机器验收；help/plan 不读取文件。');
  if (o.help) console.log('--check-worktree：只读执行 git status --porcelain=v1 --untracked-files=all，独立 repositoryWorktree 报告 clean/dirty/unavailable、changedFiles 和原因；dirty/命令失败/不可解析退出 1。与 --check-head 独立，不查询远端，不写索引；--help/--plan 不执行 Git。');
  if (o.help) { console.log(help + '\n--verify-file <相对root路径> 可重复，仅检查普通文件存在；--expect-file-sha256 <相对root路径=64位SHA256> 可重复，检查文件并复算哈希。真实路径必须在 root 内，结果单列 verifiedFiles；缺失/不匹配退出 1。不自动扫描 log/report。--help/--plan 不读取目标文件。'); return 0; }
  if (o.plan) { console.log(JSON.stringify({ action: 'audit:delivery', ...o, executed: false })); return 0; }
  let r: any;
  try { r = report(o); } catch (e) { r = { status: 'failed', errors: [{ message: runtimeErrorMessage(e) }], exitCode: 1 }; }
  console.log(o.json ? JSON.stringify(r, null, 2) : formatReport(r));
  return r.exitCode;
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
export = { parse, report, state };
