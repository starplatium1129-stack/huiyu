'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { WORKFLOWS } = require('../workflow');
const { formatReport } = require('../lib/delivery-report-format');
const ROOT = path.resolve(__dirname, '../..');
const text = (v) => typeof v === 'string' && v.trim().length > 0;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const get = (v, key) => key.split('.').reduce((a, k) => object(a) && Object.hasOwn(a, k) ? a[k] : undefined, v);
const help = 'audit:delivery --evidence <JSON> [--require <gate.path>] [--expect-commit <SHA>] [--expect-build <field=SHA256>] [--root <directory>] [--json] [--help] [--plan]\n--require 可重复；路径相对于证据根对象。未指定时识别 fullGate/gate/checks.fullGate/checks.gateFull。退出 0=记录检查通过，1=错误，2=输入错误，3=仍有未知/未运行/待验。只读，不执行推荐命令。';
function parse(args) {
  const o = { root: ROOT, require: [], builds: [], verifyFiles: [], fileHashes: [], comparisons: [] };
  const values = { '--evidence': 'evidence', '--root': 'root', '--expect-commit': 'commit', '--require': 'require', '--expect-build': 'builds', '--verify-file': 'verifyFiles', '--expect-file-sha256': 'fileHashes' };
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
  if (o.builds.some(v => !/^[\w.]+=[a-f\d]{64}$/i.test(v))) throw Error('--expect-build 需要 field=SHA256');
  if (o.require.some(v => !/^[\w.-]+$/.test(v))) throw Error('--require 需要字段路径');
  if (o.fileHashes.some(v => !/^.+=[a-f\d]{64}$/i.test(v))) throw Error('--expect-file-sha256 需要 相对root路径=64位SHA256');
  return o;
}
// Exact vocabulary only. Numeric success counts and prose are never pass verdicts.
function state(v) {
  if (!object(v)) return 'unknown';
  const raw = v.status ?? v.result;
  const states = { pass: 'passed', passed: 'passed', fail: 'failed', failed: 'failed', unknown: 'unknown', unrun: 'unrun', 'not-run': 'unrun', pending: 'pending', skipped: 'unrun' };
  let s = typeof raw === 'string' ? states[raw.toLowerCase()] || 'unknown' : typeof v.passed === 'boolean' ? (v.passed ? 'passed' : 'failed') : 'unknown';
  if (['failed', 'unexpected', 'runnerErrors'].some(k => typeof v[k] === 'number' && v[k] > 0) || (typeof v.exitCode === 'number' && v.exitCode !== 0)) s = 'failed';
  if (s === 'passed' && (v.skipped > 0 || v.flaky > 0)) s = 'pending';
  if (v.status !== undefined && v.result !== undefined && String(v.status).toLowerCase() !== String(v.result).toLowerCase()) s = 'failed';
  if (s === 'passed' && v.passed === false) s = 'failed';
  return s;
}
function report(o) {
  const root = fs.realpathSync(o.root);
  const r = { schemaVersion: 1, errors: [], passed: [], pending: [], limitations: [], records: [], recommendations: [], verifiedFiles: [] };
  const add = (bucket, file, field, message, status) => r[bucket].push({ file, field, message, ...(status ? { status } : {}) });
  if (o['check-worktree']) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
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
    } catch (e) { worktree.status = 'unavailable'; worktree.message = e.message; }
    add(worktree.status === 'clean' ? 'passed' : 'errors', o.evidence, 'repositoryWorktree', worktree.message, worktree.status);
  }
  if (o['check-head']) {
    // Ignore inherited repository overrides so cwd selects the requested repository.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
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
  const outside = value => { const rel = path.relative(root, value); return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel); };
  const requests = [
    ...(o.verifyFiles || []).map(file => ({ file })),
    ...(o.fileHashes || []).map(value => ({ file: value.slice(0, -65), expectedSha256: value.slice(-64).toLowerCase() })),
  ];
  for (const request of requests) {
    const result = { ...request };
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
      add('passed', request.file, 'verifiedFiles', result.status);
    } catch (e) {
      result.status ||= ['ENOENT', 'ENOTDIR'].includes(e.code) ? 'missing' : 'error';
      result.message = e.message;
      add('errors', request.file, 'verifiedFiles', e.message, result.status);
    }
    r.verifiedFiles.push(result);
  }
  function read(file) {
    const resolved = fs.realpathSync(path.resolve(root, file));
    const relative = path.relative(root, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw Error(`证据路径越过 root: ${file}`);
    const d = JSON.parse(fs.readFileSync(resolved, 'utf8').replace(/^\uFEFF/, ''));
    if (!object(d)) throw Error(`证据必须为 JSON 对象: ${file}`);
    return { file: relative.replaceAll('\\', '/'), d };
  }
  // Comparison resolves at most one link; it never imports acceptance states.
  function comparisonIdentity(input) {
    function boundedRead(name) {
      if (!text(name) || path.isAbsolute(name) || path.win32.isAbsolute(name) || /^[a-z]:/i.test(name) || outside(path.resolve(root, name))) throw Error('比较证据必须为 root 内相对路径');
      return read(name);
    }
    const first = boundedRead(input), docs = [first];
    const isReceipt = value => text(value.evidence) && Object.hasOwn(value, 'commit');
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
    const ids = {};
    function id(key, value, length) {
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
    }
    if (!ids.commit) throw Error('缺少最终 commit，baseline 不能代替');
    if (Object.keys(ids).length < 2) throw Error('缺少可识别构建 SHA，source hash 不能代替');
    return { files: docs.map(v => v.file), ids };
  }
  if (o.comparisons?.length) {
    r.comparisons = o.comparisons.map(input => {
      const result = { file: input, status: 'failed', sharedIds: [] };
      try {
        result.primary = comparisonIdentity(o.evidence);
        result.other = comparisonIdentity(input);
        result.sharedIds = Object.keys(result.primary.ids).filter(key => Object.hasOwn(result.other.ids, key));
        if (!result.sharedIds.some(key => key.startsWith('build.'))) throw Error('两份证据没有共有的构建 SHA 字段');
        const mismatches = result.sharedIds.filter(key => result.primary.ids[key] !== result.other.ids[key]);
        if (mismatches.length) throw Error(`交付标识不匹配: ${mismatches.join(', ')}`);
        result.status = 'matched';
        add('passed', input, 'comparisons', '共有最终提交及构建标识一致');
      } catch (e) { result.message = e.message; add('errors', input, 'comparisons', e.message); }
      return result;
    });
  }
  let primary;
  try { primary = read(o.evidence); } catch (e) { add('errors', o.evidence, '$', e.message); return finish(); }
  const receipt = text(primary.d.evidence) && Object.hasOwn(primary.d, 'commit') ? primary : null;
  let evidence = primary;
  if (receipt) {
    try { evidence = read(receipt.d.evidence); } catch (e) { add('errors', receipt.file, 'evidence', e.message); }
  }
  let delivery = receipt;
  if (!receipt && text(evidence.d.delivery?.receipt)) {
    try { delivery = read(evidence.d.delivery.receipt); } catch (e) { add('pending', evidence.file, 'delivery.receipt', e.message, 'unknown'); }
  }
  const { d, file } = evidence;
  if (d.schemaVersion !== 1) add('errors', file, 'schemaVersion', '仅支持已有 schemaVersion: 1 的证据对象');
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
    if (value !== undefined && !/^[a-f\d]{40}$/i.test(value)) add('errors', file, field, '提交标识需要完整 Git SHA');
  }
  if (!commit) add('pending', file, 'commit', '基线提交不能证明最终交付提交', 'unknown');
  else add('passed', file, 'commit', commit);
  if (o.commit && commit !== o.commit) add('errors', file, 'commit', '与显式预期提交不匹配或缺失');
  if (delivery) {
    const q = delivery.d;
    if (d.commit !== undefined && d.commit !== q.commit) add('errors', delivery.file, 'commit', '回执与证据最终提交不匹配');
    if (q.baseline !== undefined && q.baseline !== baseline) add('errors', delivery.file, 'baseline', '回执与证据基线不匹配');
    if (q.remoteCommit !== undefined && q.remoteCommit !== q.commit) add('errors', delivery.file, 'remoteCommit', '远端记录与交付提交不匹配');
    if (q.pushExitCode !== undefined && q.pushExitCode !== 0) add('errors', delivery.file, 'pushExitCode', '记录的推送失败');
    try {
      if (read(q.evidence).file !== file) add('errors', delivery.file, 'evidence', '回执指向另一份证据');
    } catch (e) { add('errors', delivery.file, 'evidence', e.message); }
  }
  const build = object(d.build) ? d.build : {};
  const ids = Object.entries(build).filter(([k]) => /Sha256$/.test(k) && !/^(before|after)Snapshot/.test(k));
  if (text(d.browser?.distIndexSha256BeforeAndAfter)) ids.push(['browser.distIndexSha256BeforeAndAfter', d.browser.distIndexSha256BeforeAndAfter]);
  if (!ids.length) add('pending', file, 'build', '缺少构建产物哈希；日志或源哈希不能代替构建标识', 'unknown');
  for (const [k, v] of ids) add(/^[a-f\d]{64}$/i.test(v) ? 'passed' : 'errors', file, `build.${k}`, String(v));
  for (const expected of o.builds || []) {
    const [field, hash] = expected.split('=');
    if (get(d, field) !== hash) add('errors', file, field, '构建证据与显式预期哈希不匹配或缺失');
    else add('passed', file, field, '与预期构建一致');
  }
  if (!text(d.scope)) add('pending', file, 'scope', '缺少明确执行范围', 'unknown');
  if (!object(d.environment) || !text(d.environment.platform)) add('pending', file, 'environment', '缺少结构化执行机器/platform；不从文件名或 prose 推断', 'unknown');
  if (!text(d.environment?.node)) add('pending', file, 'environment.node', '运行时版本未知', 'unknown');
  r.records.push({ file, commit: commit ?? null, baseline: baseline ?? null, scope: d.scope ?? null, environment: d.environment ?? null });
  const required = o.require?.length ? o.require : ['fullGate', 'gate', 'checks.fullGate', 'checks.gateFull'].filter(k => get(d, k) !== undefined);
  if (!required.length) add('pending', file, 'gates', '没有识别到必要门禁；请用 --require 指定已有字段', 'unknown');
  function check(field) {
    const v = get(d, field), s = state(v);
    add(s === 'failed' ? 'errors' : s === 'passed' ? 'passed' : 'pending', file, field, `记录状态: ${s}`, s);
    if (s === 'passed' && ![v.log, v.transcript, v.report, v.sha256].some(text)) add('pending', file, field, '缺少日志/报告索引，结果尚不可追溯', 'unknown');
    if (object(v) && v.commit !== undefined && v.commit !== commit) add('errors', file, `${field}.commit`, '此项结果属于另一提交');
    if (object(v?.build)) for (const [key, value] of Object.entries(v.build)) {
      if (/Sha256$/.test(key) && build[key] !== value) add('errors', file, `${field}.build.${key}`, '此项结果构建与交付构建不匹配或无法关联');
    }
    if (delivery && get(delivery.d, field) !== undefined && state(get(delivery.d, field)) !== s) add('errors', delivery.file, field, '回执与证据状态冲突');
  }
  required.forEach(check);
  for (const field of ['installation', 'deviceAcceptance', 'modelAcceptance']) check(field);
  for (const key of ['limitations', 'implementationLimits', 'deferred']) {
    if (Array.isArray(d[key])) d[key].forEach(v => add('limitations', file, key, v));
  }
  r.limitations.push({ message: '核验显式记录及显式选择的 root 内普通文件；仅显式期望文件哈希触发 SHA-256 复算。不扫描 log/report 字符串、不执行日志命令、不证明日志真实性或远端一致性；仅 --check-head 比较当前 HEAD。状态通过只适用于其字段范围。' });
  r.limitations.push({ message: '未覆盖任意历史 JSON、日志语义、自动门禁选择、源码变化失效推导、多阶段续跑与回滚；源哈希、基线、日期和文件名不用于推断产物哈希或自动判新。安装/deviceAcceptance/modelAcceptance 缺失保持 unknown，deployment 文件同步记录不代替设备验收。' });
  r.recommendations = ['audit:delivery', 'check:workflows'].map(name => ({ name, command: WORKFLOWS[name].cmd, nature: WORKFLOWS[name].run.nature, executed: false }));
  return finish();
  function finish() {
    r.status = r.errors.length ? 'failed' : r.pending.length ? 'pending' : 'passed';
    r.exitCode = r.errors.length ? 1 : r.pending.length ? 3 : 0;
    return r;
  }
}
function main(args) {
  let o;
  try { o = parse(args); } catch (e) { console.error(e.message); return 2; }
  if (o.help) console.log('--check-head：在 root 对应仓库只读执行 git rev-parse --verify HEAD^{commit}，独立 repositoryHead 比较证据最终 commit；缺失/不匹配/仓库不可用退出 1。只比较 HEAD commit，不覆盖 dirty working tree，不查询远端。--help/--plan 不执行 git。');
  if (o.help) console.log('--compare-evidence <root内相对JSON路径> 可重复；独立 comparisons 比较最终 commit 与共有构建 SHA，解析一层关联；缺失/不支持/越界/不匹配退出 1。不合并状态和机器验收；help/plan 不读取文件。');
  if (o.help) console.log('--check-worktree：只读执行 git status --porcelain=v1 --untracked-files=all，独立 repositoryWorktree 报告 clean/dirty/unavailable、changedFiles 和原因；dirty/命令失败/不可解析退出 1。与 --check-head 独立，不查询远端，不写索引；--help/--plan 不执行 Git。');
  if (o.help) { console.log(help + '\n--verify-file <相对root路径> 可重复，仅检查普通文件存在；--expect-file-sha256 <相对root路径=64位SHA256> 可重复，检查文件并复算哈希。真实路径必须在 root 内，结果单列 verifiedFiles；缺失/不匹配退出 1。不自动扫描 log/report。--help/--plan 不读取目标文件。'); return 0; }
  if (o.plan) { console.log(JSON.stringify({ action: 'audit:delivery', ...o, executed: false })); return 0; }
  let r;
  try { r = report(o); } catch (e) { r = { status: 'failed', errors: [{ message: e.message }], exitCode: 1 }; }
  console.log(o.json ? JSON.stringify(r, null, 2) : formatReport(r));
  return r.exitCode;
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { parse, report, state };
