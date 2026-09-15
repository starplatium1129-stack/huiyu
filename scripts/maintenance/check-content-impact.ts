#!/usr/bin/env node
import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';
const path: typeof import('node:path') = require('node:path');
const { parse: parseImpact }: typeof import('./report-content-impact') = require('./report-content-impact');
const { historyImpact }: typeof import('./content-impact-history') = require('./content-impact-history');
const { selectExecution, executePredicates }: typeof import('../lib/content-impact-checks') = require('../lib/content-impact-checks');

const HELP = `check-content-impact --base <local-commit/ref> [--execute] [--full] [--root <directory>] [--json]
Explicit --execute runs only in-process read-only predicates. Default is preview; --help/--plan read nothing.
--full also works without --base. Existing character/outfit/scene/path selectors may accompany --base.
0=preview, 1=failed check, 2=invalid arguments, 3=unknown or remaining full gate required.
Passed-scoped is not a full-library PASS. No builder, model, download, install or publish command is run.`;

function parse(argv: string|string[]) {
  if (argv.includes('--help') || argv.includes('--plan')) return { help: true };
  const flags: Record<string, any> = {};
  const forwarded: any[] = [];
  for (const arg of argv) {
    if (['--execute', '--full'].includes(arg)) {
      if (flags[arg]) throw new Error(`Duplicate option ${arg}`);
      flags[arg] = true;
    } else forwarded.push(arg);
  }
  const hasBase = forwarded.includes('--base');
  if (!flags['--full'] && !hasBase) throw new Error('Use --base for historical proof, or --full for complete supported structure checks');
  const opts = parseImpact(hasBase ? forwarded : [...forwarded, '--path', 'data/scenes.json']);
  if (!hasBase && (opts.character || opts.outfit || opts.scene || opts.paths.length !== 1)) throw new Error('Selectors require --base; --full never restricts validation');
  if (opts.gitDiff || opts.showcaseManifests.length) throw new Error('Use --base for changes; candidate evidence has its own explicit audit CLI');
  return { ...opts, full: !!flags['--full'], execute: !!flags['--execute'], root: path.resolve(opts.root) };
}

function checkContentImpact(opts: { help: boolean; }|{ full: boolean; execute: boolean; root: string; paths: never[]; showcaseManifests: never[]; help?: any; }) {
  let context: any;
  const history: any = opts.base ? historyImpact(opts, (value: any) => { context = value; }) : null;
  const selection = selectExecution(history, opts.full, context);
  const report: any = { schemaVersion: 1, kind: 'content-impact-check', readOnly: true, history,
    selection, execution: { executed: false, status: 'not-run', checks: [] }, exitCode: 0 };
  if (opts.execute) {
    report.execution = executePredicates(selection, context, opts.root);
    report.exitCode = history?.gitHistory.status === 'error' ? 1 : report.execution.exitCode;
  }
  return report;
}

function main(args: any = process.argv.slice(2)) {
  let opts;
  try { opts = parse(args); } catch (error) { console.log(JSON.stringify({ error: runtimeErrorMessage(error), exitCode: 2 })); return 2; }
  if (opts.help) { console.log(HELP); return 0; }
  try {
    const result = checkContentImpact(opts);
    console.log(opts.json ? JSON.stringify(result, null, 2) : [
      `Content checks: ${result.selection.mode}; ${result.execution.status}; full gate: required-not-run`,
      ...result.execution.checks.map((check: any) => `${check.id}: ${check.status} (executed=${check.executed})`),
      'Whole library: not-validated. Details and unknown fields: --json.',
    ].join('\n'));
    return result.exitCode;
  } catch (error) { console.log(JSON.stringify({ error: runtimeErrorMessage(error), executed: false, status: 'error', exitCode: 1 })); return 1; }
}
if (require.main === module) process.exitCode = main();
export = { parse, checkContentImpact, main };
