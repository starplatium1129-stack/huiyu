import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage } from './runtime-errors';
import type { CandidateOptions, CandidateRecord, CandidateSource, CandidateTask, GenerationOptions } from './generation-types';
'use strict';

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const os: typeof import('node:os') = require('node:os');
const crypto: typeof import('node:crypto') = require('node:crypto');
const gateway: typeof import('./generation-gateway') = require('./generation-gateway');
const { object }: typeof import('./content-history-reader') = require('./content-history-reader');

const CODE_ROOT = path.resolve(__dirname, '..', '..');
const hash = (value: string | NodeJS.ArrayBufferView) => crypto.createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();

type OptionSpec = Record<string, 'flag' | 'value'>;
type ParsedExtra<S extends OptionSpec> = { [K in keyof S]?: S[K] extends 'flag' ? boolean : string };
type Help = { help: true; plan: boolean };
function parseArgs(args: string[], extra?: undefined, env?: NodeJS.ProcessEnv): Help | CandidateOptions;
function parseArgs<const S extends OptionSpec>(args: string[], extra: S, env?: NodeJS.ProcessEnv): Help | (CandidateOptions & ParsedExtra<S>);
function parseArgs(args: string[], extra: OptionSpec = {}, env: NodeJS.ProcessEnv = process.env): Help | CandidateOptions {
  if (args.includes('--help') || args.includes('-h') || args.includes('--plan')) {
    return { help: true as const, plan: args.includes('--plan') };
  }
  const spec: OptionSpec = { root: 'value', output: 'value', gateway: 'value', 'dry-run': 'flag',
    concurrency: 'value', 'retry-unknown': 'flag', ...extra };
  const parsed: Record<string, string | boolean | undefined> = {};
  for (let i = 0; i < args.length; i++) {
    const match = /^(--[a-z-]+)(?:=(.*))?$/.exec(args[i]);
    const name = match?.[1].slice(2);
    if (!name || !Object.hasOwn(spec, name)) throw new Error(`unknown option: ${args[i]}`);
    if (Object.hasOwn(parsed, name)) throw new Error(`duplicate option: --${name}`);
    if (spec[name] === 'flag') {
      if (match![2] !== undefined) throw new Error(`--${name} does not take a value`);
      parsed[name] = true;
    } else {
      const value = match![2] ?? args[++i];
      if (!value || value.startsWith('--')) throw new Error(`--${name} requires a value`);
      parsed[name] = value;
    }
  }
  const value = (name: string) => {
    const item = parsed[name];
    if (item !== undefined && typeof item !== 'string') throw new Error(`--${name} requires a value`);
    return item;
  };
  const output = value('output');
  const opts = { ...parsed, help: false as const, env, root: path.resolve(value('root') || env.AICS_DATA_ROOT || env.AICS_APP_ROOT || CODE_ROOT),
    gateway: gateway.gatewayUrl(value('gateway'), env), dryRun: !!parsed['dry-run'],
    retryUnknown: !!parsed['retry-unknown'], output: output ? path.resolve(output) : null,
    concurrency: Number(parsed.concurrency ?? env.CONCURRENCY ?? 3) };
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1 || opts.concurrency > 32) throw new Error('concurrency must be an integer from 1 to 32');
  if (!opts.dryRun && !opts.output) throw new Error('--output <isolated candidate directory> is required');
  return opts;
}

function help(script: string, extra = '') {
  console.log(`${path.basename(script)} --output <candidate directory> ${extra}\n` +
    '[--root <data root>] [--gateway <url>] [--concurrency <1-32>] [--dry-run] [--retry-unknown]\n' +
    '--help/--plan: usage only, no target reads. --dry-run: read inputs and print plan; no writes or requests.\n' +
    'Gateway precedence: --gateway > GATEWAY_URL > BASE > AICS_COMMS_BASE > http://127.0.0.1:3000.\n' +
    'Outputs are pending PNG candidates, never published. Reuse --output to resume saved jobs.\n' +
    '--retry-unknown: explicitly resubmit an uncertain submission only after checking the gateway.\n' +
    'Inside a project, use scripts/archive/generation-candidates/<round>; public data/assets are refused.');
  return { exitCode: 0 };
}

function inside(file: string, root: string) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function noLinks(file: string) {
  let current = path.resolve(file);
  for (;;) {
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) { if (runtimeErrorCode(error) !== 'ENOENT') throw error; }
    if (stat?.isSymbolicLink()) throw new Error(`symlink/junction refused: ${current}`);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.resolve(file);
}

function assertOutput(opts: CandidateOptions, protectedPaths: Array<string | undefined> = []) {
  if (!opts.output) throw new Error('--output <isolated candidate directory> is required');
  const output = noLinks(opts.output);
  for (const root of new Set([CODE_ROOT, opts.root])) {
    const archive = path.join(root, 'scripts', 'archive', 'generation-candidates');
    if (inside(root, output) || (inside(output, root) && !inside(output, archive))) {
      throw new Error(`candidate output overlaps project files: ${output}`);
    }
    const ai = path.resolve(root, '..', 'AI');
    protectedPaths = [...protectedPaths, path.join(ai, 'SceneShowcase'), path.join(ai, 'CharacterReferences')];
  }
  const workspace = opts.env.AI_WORKSPACE_ROOT;
  if (workspace) protectedPaths.push(...['SceneShowcase', 'CharacterReferences'].map(p => path.join(workspace, p)));
  protectedPaths.push(opts.env.SCENE_SHOWCASE_DIR, opts.env.AICS_CHARACTER_REF_ROOT);
  for (const protectedPath of protectedPaths.filter((value): value is string => Boolean(value))) {
    const paths = [path.resolve(protectedPath)];
    if (fs.existsSync(protectedPath)) paths.push(fs.realpathSync(protectedPath));
    if (paths.some(p => inside(output, p) || inside(p, output))) throw new Error(`candidate output overlaps published assets: ${output}`);
  }
  return output;
}

function snapshot(root: string, names: readonly string[]) {
  const data: Record<string, unknown> = {}, sources: CandidateSource[] = [];
  for (const name of names) {
    const file = noLinks(path.resolve(root, name));
    if (!inside(file, root)) throw new Error('input outside selected root');
    const bytes = fs.readFileSync(file);
    data[name] = JSON.parse(bytes.toString('utf8'));
    sources.push({ path: file, bytes: bytes.length, sha256: hash(bytes) });
  }
  return { data, sources };
}

function atomic(file: string, value: unknown) {
  noLinks(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
}

function lockDirectory(output: string) {
  const file = noLinks(path.join(output, '.generation.lock'));
  if (fs.existsSync(file)) {
    const owner: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!object(owner) || owner.host !== os.hostname() || typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid < 1) throw new Error('unrecognized candidate lock; inspect before recovery');
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (error) { if (runtimeErrorCode(error) === 'ESRCH') alive = false; else throw error; }
    if (alive) throw new Error('candidate directory is in use');
    fs.unlinkSync(file);
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname() }), { flag: 'wx', mode: 0o600 });
  return () => fs.unlinkSync(file);
}

function openStore(opts: CandidateOptions, script: string, protectedPaths: string[]) {
  const output = assertOutput(opts, protectedPaths);
  const markerFile = path.join(output, 'candidate-run.json');
  noLinks(markerFile);
  if (fs.existsSync(output) && !fs.existsSync(markerFile) && fs.readdirSync(output).length) {
    throw new Error('output is not an empty or recognized candidate directory');
  }
  fs.mkdirSync(output, { recursive: true });
  const unlock = lockDirectory(output);
  try {
    const generator = path.basename(script);
    let marker: { kind: string; schemaVersion: number; generator: string; runId: string; createdAt?: unknown };
    if (fs.existsSync(markerFile)) {
      const value: unknown = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
      if (!object(value) || value.kind !== 'generation-candidates' || value.schemaVersion !== 1 || value.generator !== generator || typeof value.runId !== 'string' || !value.runId) {
        throw new Error('candidate directory belongs to a different or invalid run');
      }
      marker = { ...value, kind: value.kind, schemaVersion: value.schemaVersion, generator: value.generator, runId: value.runId };
    } else {
      marker = { kind: 'generation-candidates', schemaVersion: 1, generator, runId: crypto.randomUUID(), createdAt: now() };
      atomic(markerFile, marker);
    }
    const directory = noLinks(path.join(output, 'records'));
    const records: CandidateRecord[] = [];
    if (fs.existsSync(directory)) for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith('.json')) continue; // Interrupted atomic writes remain available for inspection.
      const record: unknown = JSON.parse(fs.readFileSync(noLinks(path.join(directory, name)), 'utf8'));
      if (!object(record) || record.schemaVersion !== 1 || record.runId !== marker.runId || record.generator !== generator ||
          typeof record.candidateId !== 'string' || !/^[0-9a-f-]{36}$/.test(record.candidateId) || name !== `${record.candidateId}.json` ||
          typeof record.attempt !== 'number' || !Number.isInteger(record.attempt) || record.attempt < 1 || typeof record.key !== 'string' || !record.key ||
          typeof record.createdAt !== 'string' || typeof record.gateway !== 'string' || typeof record.status !== 'string' ||
          (record.jobId !== undefined && record.jobId !== null && typeof record.jobId !== 'string') || !object(record.payload) ||
          record.recordId !== `${record.key}@attempt-${record.attempt}-${record.candidateId}` ||
          record.payloadSha256 !== hash(JSON.stringify(record.payload)) || !object(record.review) || record.review.verdict !== 'pending' ||
          record.review.recordId !== record.recordId || record.review.reviewedAt || record.publishedAt ||
          record.image !== `images/${record.candidateId}.png`) throw new Error(`invalid or forged candidate record: ${name}`);
      records.push(record as CandidateRecord); // Persisted identity, request and recovery fields were checked above.
    }
    records.sort((a, b) => a.attempt - b.attempt || a.createdAt.localeCompare(b.createdAt));
    const manifestFile = noLinks(path.join(output, 'generation-manifest.json'));
    const flush = () => {
      atomic(manifestFile, records);
      // Existing audit/publish tools accept explicit manifests but expect one batch type.
      // Keep these beside the full ledger so image paths remain relative to the same root.
      for (const batch of ['reference', 'popular', 'scene']) {
        const selected = records.filter(record => record.batch === batch);
        if (selected.length) atomic(path.join(output, `${batch}-generation-manifest.json`), selected);
      }
    };
    const save = (record: CandidateRecord) => {
      record.updatedAt = now();
      atomic(path.join(directory, `${record.candidateId}.json`), record);
      flush();
    };
    flush(); // Per-record files are authoritative, including after a torn export.
    return { output, marker, records, save, close: unlock };
  } catch (error) { unlock(); throw error; }
}

function validAsset(store: ReturnType<typeof openStore>, record: CandidateRecord) {
  try {
    const file = noLinks(path.join(store.output, record.image));
    const bytes = fs.readFileSync(file);
    gateway.validatePng(bytes);
    return object(record.asset) && record.asset.sha256 === hash(bytes) && record.asset.bytes === bytes.length;
  } catch { return false; }
}

function writeImage(store: ReturnType<typeof openStore>, record: CandidateRecord, image: Awaited<ReturnType<typeof gateway.generate>>) {
  const file = noLinks(path.join(store.output, record.image));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    if (hash(fs.readFileSync(file)) !== hash(image.buffer)) throw new Error('existing candidate image differs; refusing overwrite');
  } else {
    // A killed or failed write may leave this unreferenced staging file; the saved
    // job can supply the same image again without exposing a truncated candidate.
    const temporary = `${file}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, image.buffer, { flag: 'wx' });
    fs.renameSync(temporary, file);
  }
  const asset = { path: record.image, sha256: hash(image.buffer), bytes: image.buffer.length,
    mime: image.mime, width: image.width, height: image.height };
  record.asset = asset;
  record.sha256 = asset.sha256;
  record.bytes = asset.bytes;
  record.mime = asset.mime;
  record.status = 'succeeded';
  record.generatedAt = now();
  record.error = null;
  store.save(record);
}

async function runCandidates({ opts, script, tasks, sources, maxAttempts = 1, pollMs = 2000, timeoutMs = 600000, protectedPaths = [] }: {
  opts: CandidateOptions; script: string; tasks: CandidateTask[]; sources: CandidateSource[];
  maxAttempts?: number; pollMs?: number; timeoutMs?: number; protectedPaths?: string[];
}, deps: GenerationOptions = {}) {
  const recipeSource = { path: script, sha256: hash(fs.readFileSync(script)) };
  const seen = new Set<string>();
  const plans = tasks.map(task => {
    if (!task.key || seen.has(task.key)) throw new Error(`missing or duplicate task key: ${task.key}`);
    seen.add(task.key);
    const firstPayload = task.payload(1);
    const { seed: _seed, ...recipe } = firstPayload;
    const inputVersion = hash(JSON.stringify({ sources, recipeSource, key: task.key, metadata: task.metadata, recipe }));
    return { task, firstPayload, inputVersion };
  });
  if (opts.dryRun) {
    const result = { mode: 'preview', gateway: opts.gateway, output: opts.output, count: plans.length,
      tasks: plans.map(p => ({ key: p.task.key, inputVersion: p.inputVersion, payload: p.firstPayload })), exitCode: 0 };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const store = openStore(opts, script, protectedPaths);
  const result = { succeeded: 0, reused: 0, failed: 0, interrupted: false, output: store.output, exitCode: 0 };
  let cursor = 0;
  try {
    async function work(plan: typeof plans[number]) {
      const { task, inputVersion } = plan;
      let record: CandidateRecord | null | undefined = [...store.records].reverse().find(r => r.key === task.key && r.inputVersion === inputVersion && r.gateway === opts.gateway);
      if (record?.status === 'succeeded' && !validAsset(store, record)) {
        record.status = 'invalid-asset';
        record.error = 'candidate image missing, damaged or changed';
        store.save(record);
      }
      if (record?.status === 'succeeded' && !opts.force) { result.reused++; return; }
      if (record && !['succeeded', 'failed', 'invalid-asset'].includes(record.status)) {
        if (!record.jobId && record.status !== 'planned') {
          if (!opts.retryUnknown) {
            console.error(`${task.key}: uncertain submission; inspect saved record and gateway, then use --retry-unknown explicitly`);
            result.failed++;
            return;
          }
          record = null;
        }
      } else record = null;
      for (let retry = 1; retry <= maxAttempts; retry++) {
        if (deps.signal?.aborted) { result.interrupted = true; return; }
        if (!record) {
          const attempt = Math.max(0, ...store.records.filter(r => r.key === task.key).map(r => r.attempt)) + 1;
          const candidateId = crypto.randomUUID();
          const recordId = `${task.key}@attempt-${attempt}-${candidateId}`;
          const payload = retry === 1 ? plan.firstPayload : task.payload(retry);
          record = { ...task.metadata, ...payload, schemaVersion: 1, generator: store.marker.generator,
            runId: store.marker.runId, candidateId, key: task.key, recordId, attempt,
            status: 'planned', review: { verdict: 'pending', recordId }, createdAt: now(),
            inputVersion, sources, recipeSource, gateway: opts.gateway, payload, payloadSha256: hash(JSON.stringify(payload)),
            image: `images/${candidateId}.png` };
          store.records.push(record);
          store.save(record);
        }
        try {
          const image = await gateway.generate(record, store.save, { pollMs, timeoutMs, ...deps });
          writeImage(store, record, image);
          result.succeeded++;
          return;
        } catch (error) {
          const definitive = object(error) && error.definitive === true;
          record.status = deps.signal?.aborted ? (record.jobId ? 'interrupted' : 'submission-unknown')
            : definitive ? 'failed' : record.jobId ? 'recoverable' : 'submission-unknown';
          record.error = String(runtimeErrorMessage(error) || error);
          store.save(record);
          if (deps.signal?.aborted) { result.interrupted = true; return; }
          if (!definitive || retry === maxAttempts) {
            result.failed++;
            console.error(`${task.key}: ${record.error}`);
            return;
          }
          record = null;
        }
      }
    }
    const workers = Array.from({ length: opts.concurrency }, async () => {
      while (cursor < plans.length && !deps.signal?.aborted) await work(plans[cursor++]);
    });
    const settled = await Promise.allSettled(workers);
    const failure = settled.find(item => item.status === 'rejected');
    if (failure) throw failure.reason;
    result.interrupted ||= !!deps.signal?.aborted;
    result.exitCode = result.interrupted ? 130 : result.failed ? 1 : 0;
    console.log(JSON.stringify({ ...result, review: 'pending', manifest: path.join(store.output, 'generation-manifest.json') }));
    return result;
  } finally { store.close(); }
}

function runCli(main: (args: string[], deps: GenerationOptions) => Promise<{ exitCode?: number } | void>) {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('generation interrupted'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return main(process.argv.slice(2), { signal: controller.signal }).then(result => {
    process.exitCode = result?.exitCode || 0;
  }).catch((error: unknown) => {
    console.error(runtimeErrorMessage(error) || error);
    process.exitCode = 1;
  }).finally(() => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  });
}

export = { CODE_ROOT, hash, parseArgs, help, snapshot, noLinks, runCandidates, runCli };
