#!/usr/bin/env node
'use strict';

const path: typeof import('node:path') = require('node:path');
const { CODE_ROOT, hash, runCli }: typeof import('../lib/generation-candidates') = require('../lib/generation-candidates');
const R: typeof import('../lib/reference-candidate-review') = require('../lib/reference-candidate-review');
const { publishReferenceCandidates }: typeof import('../lib/reference-candidate-publish') = require('../lib/reference-candidate-publish');
import type { GenerationOptions } from '../lib/generation-types';

function parse(args: string[], env: NodeJS.ProcessEnv) {
  if (args.includes('--help') || args.includes('-h') || args.includes('--plan')) return { help: true as const };
  const [action, ...rest] = args;
  if (action !== 'inspect' && action !== 'review' && action !== 'publish' && action !== 'full') throw new Error('Choose inspect, review, publish or full');
  const allowed = {
    inspect: ['root', 'from'], review: ['root', 'from', 'decisions', 'out'],
    publish: ['root', 'from', 'review', 'source', 'target', 'apply'],
    full: ['root', 'output', 'source', 'target', 'gateway', 'ids', 'keys', 'concurrency', 'review', 'decisions', 'out', 'dry-run', 'retry-unknown'],
  }[action];
  const flags = ['apply', 'dry-run', 'retry-unknown'];
  const options: Record<string, string | boolean | undefined> = {};
  for (let i = 0; i < rest.length; i++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(rest[i]);
    if (!match || !allowed.includes(match[1]) || Object.hasOwn(options, match[1])) throw new Error('Invalid or duplicate option: ' + rest[i]);
    const name = match[1];
    if (flags.includes(name)) {
      if (match[2] !== undefined) throw new Error('Flag does not take a value: --' + name);
      options[name] = true;
    } else {
      const value = match[2] ?? rest[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing value for --' + name);
      options[name] = value;
    }
  }
  const value = (name: string) => typeof options[name] === 'string' ? options[name] : undefined;
  const required = (name: string) => {
    const text = value(name);
    if (!text) throw new Error('--' + name + ' is required');
    return text;
  };
  if (options.review && options.decisions) throw new Error('Choose an existing review or a new decisions file');
  if (action === 'full' && options.out && !options.decisions) throw new Error('--out requires --decisions');
  const common = { help: false as const, root: path.resolve(value('root') || env.AICS_DATA_ROOT || env.AICS_APP_ROOT || CODE_ROOT) };
  if (action === 'full') return { ...common, action: 'full' as const, output: required('output'), source: required('source'), target: required('target'),
    gateway: value('gateway'), ids: value('ids'), keys: value('keys'), concurrency: value('concurrency'),
    review: value('review'), decisions: value('decisions'), out: value('out'),
    'dry-run': options['dry-run'] === true, 'retry-unknown': options['retry-unknown'] === true };
  if (action === 'publish') return { ...common, action: 'publish' as const, from: required('from'), review: required('review'),
    source: required('source'), target: required('target'), apply: options.apply === true };
  if (action === 'review') return { ...common, action: 'review' as const, from: required('from'), decisions: required('decisions'), out: required('out') };
  return { ...common, action: 'inspect' as const, from: required('from') };
}

function inspectedSummary(inspection: ReturnType<typeof R.inspectCandidates>) {
  return { kind: inspection.kind, runId: inspection.runId, manifestSha256: inspection.manifestSha256,
    items: inspection.items, review: 'pending', explanation: 'Integrity checks do not assess image quality or constitute human approval.' };
}

function reviewCandidates(options: { decisions: string; out?: string }, inspection: ReturnType<typeof R.inspectCandidates>) {
  const decisionsFile = path.resolve(options.decisions);
  if (!R.within(inspection.directory, decisionsFile)) throw new Error('Keep the explicit decisions file in the candidate directory');
  const input = R.bytes(decisionsFile);
  const review = R.collectReview(inspection, JSON.parse(input.toString('utf8')), { file: path.basename(decisionsFile), sha256: hash(input) });
  const out = R.saveReview(inspection, options.out || path.join(inspection.directory, 'manual-review.json'), review);
  return { out, review };
}

async function main(args: string[] = process.argv.slice(2), deps: GenerationOptions = {}) {
  const env = process.env;
  const options = parse(args, env);
  if (options.help) {
    console.log('reference-candidate-workflow.js inspect --from <reference-generation-manifest.json> [--root <project>]\n'
      + 'review --from <manifest> --decisions <candidate/decisions.json> --out <candidate/manual-review.json>\n'
      + 'publish --from <manifest> --review <review> --source <current reference directory> --target <new sibling directory> [--apply]\n'
      + 'full --output <candidates> --source <current reference directory> --target <new directory> [--root <project>] [--gateway <url>] [--ids <ids>] [--keys <keys>] [--review <review> | --decisions <decisions> --out <new review>] [--dry-run]\n'
      + 'Decisions: {"reference:character:outfit:view":{"verdict":"pass|fail","recordId":"...","sha256":"image SHA256","inputVersion":"...","reviewedAt":"ISO date","notes":"..."}}.\n'
      + 'Full generates/resumes candidates, checks bytes, records explicit decisions and previews publication. It never publishes automatically.\n'
      + 'Missing human review returns 3 (pending). Help/plan read no target files; full --dry-run writes nothing and invokes no model.\n'
      + 'Only publish --apply creates an immutable version. Configure the gateway reference root explicitly to activate; retain the old directory for rollback.');
    return { exitCode: 0 };
  }
  if (options.action === 'full') {
    const generator: typeof import('./render-all-outfits-references') = require('./render-all-outfits-references');
    const generationArgs = ['--output', options.output, '--root', options.root];
    for (const key of ['gateway', 'ids', 'keys', 'concurrency'] as const) if (options[key]) generationArgs.push('--' + key, options[key]);
    for (const key of ['dry-run', 'retry-unknown'] as const) if (options[key]) generationArgs.push('--' + key);
    const generated = await generator.main(generationArgs, deps);
    if (generated.exitCode || options['dry-run']) return generated;
    const from = path.join(path.resolve(options.output), 'reference-generation-manifest.json');
    const inspection = R.inspectCandidates({ from, root: options.root });
    if (!options.review && !options.decisions) {
      const result = { ...inspectedSummary(inspection), exitCode: 3, publication: 'pending-human-review' };
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    const review = options.decisions ? reviewCandidates({ decisions: options.decisions, out: options.out }, inspection).out : options.review!;
    const result = await publishReferenceCandidates({ ...options, from, review });
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (options.action === 'publish') {
    const result = await publishReferenceCandidates(options);
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const inspection = R.inspectCandidates(options);
  if (options.action === 'inspect') {
    const result = { ...inspectedSummary(inspection), exitCode: inspection.items.every(item => item.integrity === 'pass') ? 0 : 1 };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const result = reviewCandidates(options, inspection);
  const output = { out: result.out, reviewed: Object.keys(result.review.records).length,
    pending: result.review.pending.length, exitCode: result.review.pending.length ? 3 : 0 };
  console.log(JSON.stringify(output, null, 2));
  return output;
}

if (require.main === module) runCli(main);
