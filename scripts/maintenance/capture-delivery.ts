import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';
const path: typeof import('node:path') = require('node:path');
const { rootPath, evidencePath, saveJson }: typeof import('../lib/delivery-paths') = require('../lib/delivery-paths');
const { selectors }: typeof import('../lib/delivery-identity') = require('../lib/delivery-identity');
const { gatePath }: typeof import('../lib/delivery-state') = require('../lib/delivery-state');
const { capture }: typeof import('../lib/delivery-handoff') = require('../lib/delivery-handoff');
const ROOT = path.resolve(__dirname, '../..');
const HELP = `capture-delivery --scope <说明> --source-file <路径>|--source-tree <目录> --build-file <路径>|--build-tree <目录>
  [--gate <field=source,build>] [--root <目录>] [--save runtime/delivery-evidence/<新文件>.json] [--json]
capture-delivery --baseline runtime/delivery-evidence/<快照>.json [--record runtime/delivery-evidence/<结果>.json]
  [--machine office|main] [--root <目录>] [--save runtime/delivery-evidence/<新文件>.json]
  [--finalize-commit <最终完整SHA>]
文件/目录/--gate 可重复；默认门禁 checks.office 依赖 source,build。目录递归包含未跟踪/忽略文件。
默认只读输出 JSON；--save 显式创建新证据，拒绝覆盖。--help/--plan 不读目标、不运行 Git、不保存。
先捕获快照，再实际运行检查，最后用 --baseline/--record 绑定结果；旧无追踪记录不能补签通过。
结果 JSON 需 schemaVersion:1、baselineSha256（执行前快照文件 SHA-256），字段与快照门禁一致。
通过项须有实际 log/transcript/report 相对文件；不会把未绑定的旧成功记录挂到新快照。
记录不运行门禁、模型、安装或设备检查。office 不得声明 main 验收通过。
--finalize-commit 仅办公机显式关联当前 HEAD；保留 baselineHead/原始结果，要求源码与构建未变、最终提交包含全部所选源码且源码索引一致。
可同时 --record（结果 commit 仍是执行前 HEAD）。不带此参数保持同 HEAD 检查；文档另提交可再次 finalize。
仅 SHA-256 字节身份；.git 与 runtime/delivery-evidence 排除。禁止 symlink/junction/硬链接。
退出 0=记录操作成功（不等于验收通过），1=内容/路径错误，2=参数错误。
校验: node scripts/maintenance/audit-delivery.js --evidence <交接JSON> --json`;
function parse(args) {
  const result = { root: ROOT, machine: 'office', source: [], build: [], gates: {} };
  const values = { '--root': 'root', '--scope': 'scope', '--save': 'save', '--baseline': 'baseline', '--record': 'record', '--machine': 'machine', '--finalize-commit': 'finalizeCommit' };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (['--help', '--plan', '--json'].includes(flag)) { result[flag.slice(2)] = true; continue; }
    const choice = /^--(source|build)-(file|tree)$/.exec(flag);
    if ((!values[flag] && !choice && flag !== '--gate') || !args[i + 1] || args[i + 1].startsWith('--')) throw Error(`参数无效或缺值: ${flag}`);
    const value = args[++i];
    if (choice) result[choice[1]].push({ path: value, kind: choice[2] });
    else if (flag === '--gate') {
      const [field, dependencies, extra] = value.split('=');
      const dependsOn = dependencies?.split(',');
      if (!gatePath(field) || extra !== undefined || !dependsOn?.length || new Set(dependsOn).size !== dependsOn.length
        || dependsOn.some(k => !['source', 'build'].includes(k)) || Object.hasOwn(result.gates, field)) throw Error('--gate 需要唯一 field=source,build');
      result.gates[field] = dependsOn;
    } else {
      if (seen.has(flag)) throw Error(`重复参数: ${flag}`);
      seen.add(flag); result[values[flag]] = value;
    }
  }
  if (!['office', 'main'].includes(result.machine)) throw Error('--machine 需要 office/main');
  for (const key of ['baseline', 'record', 'save']) if (result[key]) evidencePath(result[key]);
  if (result.help) return result;
  if (result.finalizeCommit) {
    if (!/^[a-f\d]{40}$/i.test(result.finalizeCommit) || !result.baseline || result.machine !== 'office') throw Error('--finalize-commit 需要完整 SHA、--baseline 与 office 机器');
    result.finalizeCommit = result.finalizeCommit.toLowerCase();
  }
  if (result.baseline) {
    if (result.scope || result.source.length || result.build.length || Object.keys(result.gates).length) throw Error('不能替换 baseline 的范围/门禁/选择项');
  } else {
    if (result.record || result.machine === 'main' || !result.scope?.trim()) throw Error('初始快照需要 --scope；--record/main 需要 --baseline');
    result.source = selectors(result.source); result.build = selectors(result.build);
    if (!Object.keys(result.gates).length) result.gates = { 'checks.office': ['source', 'build'] };
  }
  return result;
}
function main(args) {
  let options;
  try { options = parse(args); } catch (error) { console.error(runtimeErrorMessage(error)); return 2; }
  if (options.help) { console.log(HELP); return 0; }
  if (options.plan) { console.log(JSON.stringify({ action: 'capture-delivery', ...options, executed: false })); return 0; }
  try {
    const root = rootPath(options.root), document = capture(root, options);
    if (options.save) saveJson(root, options.save, document);
    console.log(JSON.stringify(document, null, 2));
    return [document.tracking.source, document.tracking.build].every(v => v.status === 'complete') ? 0 : 1;
  } catch (error) { console.error(runtimeErrorMessage(error)); return 1; }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
export = { parse, main };
