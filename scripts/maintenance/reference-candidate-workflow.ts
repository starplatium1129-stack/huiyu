#!/usr/bin/env node
'use strict';

const path: typeof import('node:path') = require('node:path');
const { CODE_ROOT, hash, runCli }: typeof import('../lib/generation-candidates') = require('../lib/generation-candidates');
const R: typeof import('../lib/reference-candidate-review') = require('../lib/reference-candidate-review');
const { publishReferenceCandidates }: typeof import('../lib/reference-candidate-publish') = require('../lib/reference-candidate-publish');

function parse(args: string|string[]|[any,...any[]], env: any) {
  if (args.includes('--help') || args.includes('-h') || args.includes('--plan')) return { help: true };
  const [action, ...rest]: any = args;
  if (!['inspect', 'review', 'publish', 'full'].includes(action)) throw new Error('Choose inspect, review, publish or full');
  const allowed = {
    inspect: ['root', 'from'], review: ['root', 'from', 'decisions', 'out'],
    publish: ['root', 'from', 'review', 'source', 'target', 'apply'],
    full: ['root', 'output', 'source', 'target', 'gateway', 'ids', 'keys', 'concurrency', 'review', 'decisions', 'out', 'dry-run', 'retry-unknown'],
  }[action];
  const flags = ['apply', 'dry-run', 'retry-unknown'];
  const options: any = { action };
  for (let i = 0; i < rest.length; i++) {
    const match: any = /^--([a-z-]+)(?:=(.*))?$/.exec(rest[i]);
    const name: any = match?.[1];
    if (!allowed.includes(name) || Object.hasOwn(options, name)) throw new Error('Invalid or duplicate option: ' + rest[i]);
    if (flags.includes(name)) {
      if (match[2] !== undefined) throw new Error('Flag does not take a value: --' + name);
      options[name] = true;
    } else {
      const value = match[2] ?? rest[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing value for --' + name);
      options[name] = value;
    }
  }
  const required = action === 'full' ? ['output', 'source', 'target']
    : action === 'publish' ? ['from', 'review', 'source', 'target'] : action === 'review' ? ['from', 'decisions', 'out'] : ['from'];
  for (const name of required) if (!options[name]) throw new Error('--' + name + ' is required');
  if (options.review && options.decisions) throw new Error('Choose an existing review or a new decisions file');
  if (action === 'full' && options.out && !options.decisions) throw new Error('--out requires --decisions');
  options.root = path.resolve(options.root || env.AICS_DATA_ROOT || env.AICS_APP_ROOT || CODE_ROOT);
  return options;
}

function inspectedSummary(inspection: any) {
  return { kind: inspection.kind, runId: inspection.runId, manifestSha256: inspection.manifestSha256,
    items: inspection.items, review: 'pending', explanation: 'Integrity checks do not assess image quality or constitute human approval.' };
}

function reviewCandidates(options: any, inspection: any) {
  const decisionsFile = path.resolve(options.decisions);
  if (!R.within(inspection.directory, decisionsFile)) throw new Error('Keep the explicit decisions file in the candidate directory');
  const input: any = R.bytes(decisionsFile);
  const review = R.collectReview(inspection, JSON.parse(input), { file: path.basename(decisionsFile), sha256: hash(input) });
  const out = R.saveReview(inspection, options.out || path.join(inspection.directory, 'manual-review.json'), review);
  return { out, review };
}

async function main(args: any = process.argv.slice(2), deps: any = {}) {
  const env = deps.env || process.env;
  const options: any = parse(args, env);
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
    for (const key of ['gateway', 'ids', 'keys', 'concurrency']) if (options[key]) generationArgs.push('--' + key, options[key]);
    for (const key of ['dry-run', 'retry-unknown']) if (options[key]) generationArgs.push('--' + key);
    const generated = await generator.main(generationArgs, { ...deps, env });
    if (generated.exitCode || options['dry-run']) return generated;
    options.from = path.join(path.resolve(options.output), 'reference-generation-manifest.json');
    const inspection = R.inspectCandidates(options);
    if (!options.review && !options.decisions) {
      const result = { ...inspectedSummary(inspection), exitCode: 3, publication: 'pending-human-review' };
      console.log(JSON.stringify(result, null, 2));
      return result;
    }
    if (options.decisions) options.review = reviewCandidates(options, inspection).out;
    const result = await publishReferenceCandidates(options, deps);
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  if (options.action === 'publish') {
    const result = await publishReferenceCandidates(options, deps);
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const inspection = R.inspectCandidates(options);
  if (options.action === 'inspect') {
    const result = { ...inspectedSummary(inspection), exitCode: inspection.items.every((item: any) => item.integrity === 'pass') ? 0 : 1 };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const result = reviewCandidates(options, inspection);
  const output = { out: result.out, reviewed: Object.keys(result.review.records).length,
    pending: result.review.pending.length, exitCode: result.review.pending.length ? 3 : 0 };
  console.log(JSON.stringify(output, null, 2));
  return output;
}

export = { main, parse, reviewCandidates };
if (require.main === module) runCli(main);
