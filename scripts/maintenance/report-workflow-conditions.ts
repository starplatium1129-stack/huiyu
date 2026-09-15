import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const { validateRun, PASSIVE_EFFECTS }: typeof import('../lib/workflow-runner') = require('../lib/workflow-runner');
import type { RegisteredWorkflows } from '../lib/workflow-types';

type ReportOptions = {
  root?: string;
  domain?: string;
  registry?: RegisteredWorkflows;
};
type EffectList = string[];

function reportConditions({ root = path.resolve(__dirname, '../..'), domain, registry = (require('../workflow') as typeof import('../workflow')).WORKFLOWS }: ReportOptions = {}) {
  const base = fs.realpathSync(root);
  const exists = (file: string) => {
    try {
      const target = fs.realpathSync(path.resolve(base, file.split('#')[0].replace(/:\d+$/, '')));
      const rel = path.relative(base, target);
      return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep) && fs.statSync(target).isFile();
    } catch { return false; }
  };
  let scripts: Record<string, any> = {};
  try { scripts = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8')).scripts || {}; } catch { /* npm entries remain missing */ }
  const names = Object.keys(registry).filter((name: any) => !domain || name.split(':')[0] === domain);
  if (!names.length) throw new Error('Unknown domain: ' + domain);
  function effects(name: string, parents: string[] = []): EffectList {
    if (parents.includes(name)) throw new Error('Composite cycle: ' + name);
    const def = registry[name];
    if (!def) throw new Error('Missing step: ' + name);
    return [...(Array.isArray(def.run?.nature) ? def.run.nature : []), ...(def.steps || []).flatMap((step: any) => effects(step, [...parents, name]))];
  }
  const commands = names.map((name: any) => {
    const def = registry[name] || {}, errors = validateRun(name, def);
    const cmd = Array.isArray(def.cmd) ? def.cmd : [];
    let entryExists = Boolean(def.builtin === 'audit' || Array.isArray(def.steps) && def.steps.length);
    if (cmd.length) {
      const files = cmd.filter((arg: any) => typeof arg === 'string' && /^(scripts\/|deploy-desktop\.bat)/.test(arg));
      entryExists = cmd[0] === 'npm' ? typeof scripts[cmd[1] === 'run' ? cmd[2] : cmd[1]] === 'string' : files.length > 0 && files.every(exists);
    }
    if (!entryExists) errors.push('Missing entry');
    const docsExist = typeof def.docs === 'string' && exists(def.docs);
    if (!docsExist) errors.push('Missing documentation');
    let childEffects: EffectList = [], missingEffects: EffectList = [];
    try {
      childEffects = [...new Set((def.steps || []).flatMap((step: any) => effects(step, [name])))];
      missingEffects = childEffects.filter((effect: any) => !PASSIVE_EFFECTS.includes(effect) && !(Array.isArray(def.run?.nature) && def.run.nature.includes(effect)));
      if (missingEffects.length) errors.push('Composite omitted effects: ' + missingEffects.join(', '));
    } catch (error) { errors.push(runtimeErrorMessage(error)); }
    // G2：原样复制已声明的条件元数据，不从文本推断行为；缺省给稳定的空集合/null。
    const run = def.run || {};
    const switches = run.switches == null ? {} : typeof run.switches === 'object' && !Array.isArray(run.switches)
      ? Object.fromEntries(Object.entries(run.switches).map(([flag, value]: any) => [flag, Array.isArray(value) ? [...value] : value]))
      : run.switches;
    const notes = Array.isArray(run.notes) ? [...run.notes] : run.notes == null ? [] : run.notes;
    return { name, nature: def.run?.nature ?? null, machine: def.run?.machine ?? null, switches, resume: def.run?.resume ?? null,
      evidence: def.run?.evidence ?? null, unknown: def.run?.unknown ?? ['未声明'], notes, needs: def.needs ?? null, entry: cmd, entryExists, docs: def.docs ?? null, docsExist,
      composite: { steps: def.steps || [], childEffects, missingEffects }, errors, executionStatus: 'not-run' };
  });
  return { schemaVersion: 1, ok: commands.every((row: any) => !row.errors.length), commands, executionStatus: 'not-run' };
}
function formatConditionRow(row: { name: unknown; errors: unknown[]; nature: unknown[]; switches: unknown; needs: string|null; notes: unknown[]|null; unknown: unknown[]; }) {
  const lines = [`${row.name}: ${row.errors.length ? row.errors.join('; ') : 'metadata valid'}; not-run`];
  lines.push(`  默认: ${Array.isArray(row.nature) ? row.nature.join(', ') : '未声明'}`);
  const switches = row.switches;
  const switchText = switches != null && typeof switches === 'object' && !Array.isArray(switches)
    ? Object.entries(switches).map(([flag, effects]: any) => `${flag} → ${Array.isArray(effects) ? effects.join(', ') : String(effects)}`).join('；')
    : String(switches ?? '');
  if (switchText) lines.push(`  开关: ${switchText}`);
  if (row.needs != null && row.needs !== '') lines.push(`  前置: ${row.needs}`);
  const notesText = Array.isArray(row.notes) ? row.notes.join('；') : row.notes == null ? '' : String(row.notes);
  if (notesText) lines.push(`  说明: ${notesText}`);
  if (Array.isArray(row.unknown) && row.unknown.length) lines.push(`  未知: ${row.unknown.join('；')}`);
  return lines.join('\n');
}
function formatConditions(result: { schemaVersion?: number; ok?: boolean; commands: Array<Parameters<typeof formatConditionRow>[0]>; executionStatus?: string; }) { return result.commands.map(formatConditionRow).join('\n'); }
function main(argv: any = process.argv.slice(2)) {
  const options: ReportOptions = {}; let json = false, preview = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (['--help', '-h', '--plan'].includes(arg)) preview = true;
    else if (arg === '--json') json = true;
    else if (['--root', '--domain'].includes(arg) && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      if (arg === '--root') options.root = argv[++i];
      else options.domain = argv[++i];
    }
    else throw new Error('Invalid argument: ' + arg);
  }
  if (preview) { console.log('audit:workflow-conditions [--json] [--root <directory>] [--domain <workflow group>]：只读注册条件；不执行命令。'); return 0; }
  const result = reportConditions(options);
  console.log(json ? JSON.stringify(result, null, 2) : formatConditions(result));
  return result.ok ? 0 : 1;
}
export = { reportConditions, formatConditions, formatConditionRow, main };
if (require.main === module) { try { process.exitCode = main(); } catch (error) { console.error(runtimeErrorMessage(error)); process.exitCode = 1; } }
