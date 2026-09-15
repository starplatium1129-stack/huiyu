import { errorCode as runtimeErrorCode, errorMessage as runtimeErrorMessage } from './runtime-errors';
'use strict';

const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const os: typeof import('node:os') = require('node:os');
const crypto: typeof import('node:crypto') = require('node:crypto');
const gateway: typeof import('./generation-gateway') = require('./generation-gateway');

const CODE_ROOT = path.resolve(__dirname, '..', '..');
const hash = (value: any) => crypto.createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();

function parseArgs(args: any, extra: any = {}, env: any = process.env) {
  if (args.includes('--help') || args.includes('-h') || args.includes('--plan')) {
    return { help: true, plan: args.includes('--plan') };
  }
  const spec: any = { root: 'value', output: 'value', gateway: 'value', 'dry-run': 'flag',
    concurrency: 'value', 'retry-unknown': 'flag', ...extra };
  const parsed: any = {};
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
  const opts = { ...parsed, env, root: path.resolve(parsed.root || env.AICS_DATA_ROOT || env.AICS_APP_ROOT || CODE_ROOT),
    gateway: gateway.gatewayUrl(parsed.gateway, env), dryRun: !!parsed['dry-run'],
    retryUnknown: !!parsed['retry-unknown'], output: parsed.output ? path.resolve(parsed.output) : null,
    concurrency: Number(parsed.concurrency ?? env.CONCURRENCY ?? 3) };
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1 || opts.concurrency > 32) throw new Error('concurrency must be an integer from 1 to 32');
  if (!opts.dryRun && !opts.output) throw new Error('--output <isolated candidate directory> is required');
  return opts;
}

function help(script: any, extra: any = '') {
  console.log(`${path.basename(script)} --output <candidate directory> ${extra}\n` +
    '[--root <data root>] [--gateway <url>] [--concurrency <1-32>] [--dry-run] [--retry-unknown]\n' +
    '--help/--plan: usage only, no target reads. --dry-run: read inputs and print plan; no writes or requests.\n' +
    'Gateway precedence: --gateway > GATEWAY_URL > BASE > AICS_COMMS_BASE > http://127.0.0.1:3000.\n' +
    'Outputs are pending PNG candidates, never published. Reuse --output to resume saved jobs.\n' +
    '--retry-unknown: explicitly resubmit an uncertain submission only after checking the gateway.\n' +
    'Inside a project, use scripts/archive/generation-candidates/<round>; public data/assets are refused.');
  return { exitCode: 0 };
}

function inside(file: any, root: any) {
  const relative = path.relative(path.resolve(root), path.resolve(file));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function noLinks(file: any) {
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

function assertOutput(opts: any, protectedPaths: any = []) {
  const output = noLinks(opts.output);
  for (const root of new Set([CODE_ROOT, opts.root])) {
    const archive = path.join(root, 'scripts', 'archive', 'generation-candidates');
    if (inside(root, output) || (inside(output, root) && !inside(output, archive))) {
      throw new Error(`candidate output overlaps project files: ${output}`);
    }
    const ai = path.resolve(root, '..', 'AI');
    protectedPaths = [...protectedPaths, path.join(ai, 'SceneShowcase'), path.join(ai, 'CharacterReferences')];
  }
  if (opts.env.AI_WORKSPACE_ROOT) protectedPaths.push(...['SceneShowcase', 'CharacterReferences'].map(p => path.join(opts.env.AI_WORKSPACE_ROOT, p)));
  protectedPaths.push(opts.env.SCENE_SHOWCASE_DIR, opts.env.AICS_CHARACTER_REF_ROOT);
  for (const protectedPath of protectedPaths.filter(Boolean)) {
    const paths = [path.resolve(protectedPath)];
    if (fs.existsSync(protectedPath)) paths.push(fs.realpathSync(protectedPath));
    if (paths.some(p => inside(output, p) || inside(p, output))) throw new Error(`candidate output overlaps published assets: ${output}`);
  }
  return output;
}

function snapshot(root: any, names: any) {
  const data: any = {}, sources = [];
  for (const name of names) {
    const file = noLinks(path.resolve(root, name));
    if (!inside(file, root)) throw new Error('input outside selected root');
    const bytes = fs.readFileSync(file);
    data[name] = JSON.parse(bytes.toString('utf8'));
    sources.push({ path: file, bytes: bytes.length, sha256: hash(bytes) });
  }
  return { data, sources };
}

function atomic(file: any, value: any) {
  noLinks(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
}

function lockDirectory(output: any) {
  const file = noLinks(path.join(output, '.generation.lock'));
  if (fs.existsSync(file)) {
    const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (owner.host !== os.hostname() || !Number.isInteger(owner.pid) || owner.pid < 1) throw new Error('unrecognized candidate lock; inspect before recovery');
    let alive = true;
    try { process.kill(owner.pid, 0); } catch (error) { if (runtimeErrorCode(error) === 'ESRCH') alive = false; else throw error; }
    if (alive) throw new Error('candidate directory is in use');
    fs.unlinkSync(file);
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, host: os.hostname() }), { flag: 'wx', mode: 0o600 });
  return () => fs.unlinkSync(file);
}

function openStore(opts: any, script: any, protectedPaths: any) {
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
    let marker;
    if (fs.existsSync(markerFile)) {
      marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
      if (marker.kind !== 'generation-candidates' || marker.schemaVersion !== 1 || marker.generator !== generator || !marker.runId) {
        throw new Error('candidate directory belongs to a different or invalid run');
      }
    } else {
      marker = { kind: 'generation-candidates', schemaVersion: 1, generator, runId: crypto.randomUUID(), createdAt: now() };
      atomic(markerFile, marker);
    }
    const directory = noLinks(path.join(output, 'records'));
    const records: any = [];
    if (fs.existsSync(directory)) for (const name of fs.readdirSync(directory)) {
      if (!name.endsWith('.json')) continue; // Interrupted atomic writes remain available for inspection.
      const record = JSON.parse(fs.readFileSync(noLinks(path.join(directory, name)), 'utf8'));
      if (record.schemaVersion !== 1 || record.runId !== marker.runId || record.generator !== generator ||
          !/^[0-9a-f-]{36}$/.test(record.candidateId) || name !== `${record.candidateId}.json` ||
          !Number.isInteger(record.attempt) || record.attempt < 1 || !record.key ||
          record.recordId !== `${record.key}@attempt-${record.attempt}-${record.candidateId}` ||
          record.payloadSha256 !== hash(JSON.stringify(record.payload)) || record.review?.verdict !== 'pending' ||
          record.review.recordId !== record.recordId || record.review.reviewedAt || record.publishedAt ||
          record.image !== `images/${record.candidateId}.png`) throw new Error(`invalid or forged candidate record: ${name}`);
      records.push(record);
    }
    records.sort((a: any, b: any) => a.attempt - b.attempt || a.createdAt.localeCompare(b.createdAt));
    const manifestFile = noLinks(path.join(output, 'generation-manifest.json'));
    const flush = () => {
      atomic(manifestFile, records);
      // Existing audit/publish tools accept explicit manifests but expect one batch type.
      // Keep these beside the full ledger so image paths remain relative to the same root.
      for (const batch of ['reference', 'popular', 'scene']) {
        const selected = records.filter((record: any) => record.batch === batch);
        if (selected.length) atomic(path.join(output, `${batch}-generation-manifest.json`), selected);
      }
    };
    const save = (record: any) => {
      record.updatedAt = now();
      atomic(path.join(directory, `${record.candidateId}.json`), record);
      flush();
    };
    flush(); // Per-record files are authoritative, including after a torn export.
    return { output, marker, records, save, close: unlock };
  } catch (error) { unlock(); throw error; }
}

function validAsset(store: any, record: any) {
  try {
    const file = noLinks(path.join(store.output, record.image));
    const bytes = fs.readFileSync(file);
    gateway.validatePng(bytes);
    return record.asset?.sha256 === hash(bytes) && record.asset.bytes === bytes.length;
  } catch { return false; }
}

function writeImage(store: any, record: any, image: any) {
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
  record.asset = { path: record.image, sha256: hash(image.buffer), bytes: image.buffer.length,
    mime: image.mime, width: image.width, height: image.height };
  record.sha256 = record.asset.sha256;
  record.bytes = record.asset.bytes;
  record.mime = record.asset.mime;
  record.status = 'succeeded';
  record.generatedAt = now();
  record.error = null;
  store.save(record);
}

async function runCandidates({ opts, script, tasks, sources, maxAttempts = 1, pollMs = 2000, timeoutMs = 600000, protectedPaths = [] }: any, deps: any = {}) {
  const recipeSource = { path: script, sha256: hash(fs.readFileSync(script)) };
  const seen = new Set();
  const plans = tasks.map((task: any) => {
    if (!task.key || seen.has(task.key)) throw new Error(`missing or duplicate task key: ${task.key}`);
    seen.add(task.key);
    const firstPayload = task.payload(1);
    const { seed: _seed, ...recipe } = firstPayload;
    const inputVersion = hash(JSON.stringify({ sources, recipeSource, key: task.key, metadata: task.metadata, recipe }));
    return { task, firstPayload, inputVersion };
  });
  if (opts.dryRun) {
    const result = { mode: 'preview', gateway: opts.gateway, output: opts.output, count: plans.length,
      tasks: plans.map((p: any) => ({ key: p.task.key, inputVersion: p.inputVersion, payload: p.firstPayload })), exitCode: 0 };
    console.log(JSON.stringify(result, null, 2));
    return result;
  }
  const store = openStore(opts, script, protectedPaths);
  const result = { succeeded: 0, reused: 0, failed: 0, interrupted: false, output: store.output, exitCode: 0 };
  let cursor = 0;
  try {
    async function work(plan: any) {
      const { task, inputVersion } = plan;
      let record = [...store.records].reverse().find(r => r.key === task.key && r.inputVersion === inputVersion && r.gateway === opts.gateway);
      if (record?.status === 'succeeded' && !validAsset(store, record)) {
        record.status = 'invalid-asset';
        record.error = 'candidate image missing, damaged or changed';
        store.save(record);
      }
      if (record?.status === 'succeeded' && !opts.force) { result.reused++; return; }
      const unsettled = record && !['succeeded', 'failed', 'invalid-asset'].includes(record.status);
      if (unsettled && !record.jobId && record.status !== 'planned' && !opts.retryUnknown) {
        console.error(`${task.key}: uncertain submission; inspect saved record and gateway, then use --retry-unknown explicitly`);
        result.failed++;
        return;
      }
      if (!unsettled || (!record.jobId && record.status !== 'planned')) record = null;
      for (let retry = 1; retry <= maxAttempts; retry++) {
        if (deps.signal?.aborted) { result.interrupted = true; return; }
        if (!record) {
          const attempt = Math.max(0, ...store.records.filter((r: any) => r.key === task.key).map((r: any) => r.attempt)) + 1;
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
        } catch (error: any) {
          record.status = deps.signal?.aborted ? (record.jobId ? 'interrupted' : 'submission-unknown')
            : error.definitive ? 'failed' : record.jobId ? 'recoverable' : 'submission-unknown';
          record.error = String(runtimeErrorMessage(error) || error);
          store.save(record);
          if (deps.signal?.aborted) { result.interrupted = true; return; }
          if (!error.definitive || retry === maxAttempts) {
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

function runCli(main: any) {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('generation interrupted'));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return main(process.argv.slice(2), { signal: controller.signal }).then((result: any) => {
    process.exitCode = result?.exitCode || 0;
  }).catch((error: any) => {
    console.error(error.message || error);
    process.exitCode = 1;
  }).finally(() => {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  });
}

export = { CODE_ROOT, hash, parseArgs, help, snapshot, noLinks, assertOutput, runCandidates, runCli };
