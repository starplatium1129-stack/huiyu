#!/usr/bin/env node
import { errorMessage as runtimeErrorMessage } from '../lib/runtime-errors';
'use strict';
const path: typeof import('node:path') = require('node:path');
const { evidencePath, SHA }: typeof import('../lib/content-evidence-io') = require('../lib/content-evidence-io');
const { auditContentEvidence }: typeof import('../lib/content-evidence-audit') = require('../lib/content-evidence-audit');

const HELP = `audit-content-evidence --manifest <candidate-relative generation-manifest.json> [--root <source-root>]
  [--candidate-root <directory>] [--source <root-relative file>]... [--recipe <root-relative file>]
  [--decisions <candidate-relative JSON>] [--publication <candidate-relative JSON>] [--published-root <directory>]
  [--expect-manifest-sha256 <SHA256>] [--json]
Read-only audit of native generation ledger metadata. No model, image rewriting, decisions or publication.
Sources and recipe files are read only when explicitly allowed. Default audits; --help/--plan read nothing.
0=all selected evidence matches, 1=invalid evidence/bytes, 2=arguments, 3=pending/unknown/stale.
File bytes, structure, decision bindings and publication evidence are separate; image quality and reviewer authenticity remain unverified.`;

function parse(args: any) {
  if (args.includes('--help') || args.includes('--plan')) return { help: true };
  const opts: any = { root: path.resolve(__dirname, '../..'), sources: [] };
  const names: any = { '--root': 'root', '--candidate-root': 'candidateRoot', '--manifest': 'manifest', '--source': 'sources',
    '--recipe': 'recipe', '--decisions': 'decisions', '--publication': 'publication', '--published-root': 'publishedRoot', '--expect-manifest-sha256': 'expectManifestSha256' };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === '--json') { opts.json = true; continue; }
    if (!Object.hasOwn(names, flag)) throw new Error(`Unknown option ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing value ${flag}`);
    if (flag !== '--source' && seen.has(flag)) throw new Error(`Duplicate option ${flag}`);
    seen.add(flag);
    if (flag === '--source') opts.sources.push(evidencePath(value));
    else opts[names[flag]] = ['--manifest', '--recipe', '--decisions', '--publication'].includes(flag) ? evidencePath(value) : value;
  }
  if (!opts.manifest) throw new Error('--manifest is required');
  if (new Set(opts.sources).size !== opts.sources.length) throw new Error('Duplicate --source');
  if (opts.expectManifestSha256 && !SHA.test(opts.expectManifestSha256)) throw new Error('Invalid manifest SHA-256');
  if (opts.publishedRoot && !opts.publication) throw new Error('--published-root requires --publication');
  opts.root = path.resolve(opts.root);
  opts.candidateRoot = path.resolve(opts.candidateRoot || opts.root);
  if (opts.publishedRoot) opts.publishedRoot = path.resolve(opts.publishedRoot);
  return opts;
}

function main(args: any = process.argv.slice(2)) {
  let opts: any;
  try { opts = parse(args); } catch (error) { console.log(JSON.stringify({ error: runtimeErrorMessage(error), exitCode: 2 })); return 2; }
  if (opts.help) { console.log(HELP); return 0; }
  const result = auditContentEvidence(opts);
  console.log(opts.json ? JSON.stringify(result, null, 2) : [
    `Candidate evidence: ${result.status}; structure=${result.structure.status}`,
    ...result.items.map((item: any) => `${item.key}: source=${item.source.status}; payload=${item.payload.status}; file=${item.asset.status}; review=${item.review.status}; publication=${item.publication.status}`),
    ...result.errors, ...result.unknown,
    'Image quality/reviewer authenticity: unverified. No publication performed.',
  ].join('\n'));
  return result.exitCode;
}
if (require.main === module) process.exitCode = main();
export = { parse, main };
