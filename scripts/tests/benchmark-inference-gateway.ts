'use strict';

/** Product-path warm measurements; transport and PNG validation stay in generation-gateway. */
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const crypto: typeof import('node:crypto') = require('node:crypto');
const { performance }: typeof import('node:perf_hooks') = require('node:perf_hooks');
const gateway: typeof import('../lib/generation-gateway') = require('../lib/generation-gateway');
const { statistics }: typeof import('./benchmark-anima-teacache') = require('./benchmark-anima-teacache');

type Options = { payload: string; output: string; gateway: string; provider: 'native' | 'comfy';
  warmups: number; repeats: number; poll: number; timeout: number; run: boolean };
type Run = { phase: 'warmup' | 'measured'; index: number; requestedSeed: number };
const LIMITATIONS = 'Product gateway wall time from submission through polling, download, PNG validation, hashing and local image save. '
  + 'Warm-ups are excluded from statistics; warm residency, process/disk-cold state and exclusive GPU use are not proven. '
  + 'Product conditioning/model/mask caches remain enabled as configured. Fresh seeds and distinct job IDs/image bytes guard against result reuse, but sampler execution/cache misses are not observed. '
  + 'Server-reported seeds are metadata, not captured RNG/noise tensors. Poll intervals add observation latency; HTTP latency is additional, so the interval is not an end-to-end error bound. '
  + 'Known product differences: Comfy plain img2img currently leaves the source-image latent disconnected, and plain txt2img includes RCAS sharpening absent from native. Identical payloads therefore measure different product work, not equivalent inference. '
  + 'Sigma schedules, checkpoint/export/LoRA equivalence, precision, attention, total-device peak VRAM and image quality are unverified. No cross-backend speedup or parity verdict is produced.';
const HELP = 'node scripts/tests/benchmark-inference-gateway.js --payload <actual API payload.json> --expect-provider native|comfy '
  + '--output-dir <new runtime directory> [--gateway http://127.0.0.1:3000] [--warmups 1] [--repeats 6] [--poll-ms 100] [--timeout 600] [--run]\n'
  + 'Default is a zero-network, no-write plan. --run uses an already prepared exclusive local GPU session. '
  + 'Never starts services, switches engines, clears caches, retries submissions or interrupts jobs. Run the engines separately and warm up again after switching.\n' + LIMITATIONS;
const hash = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const write = (file: string, value: any) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

function options(argv: string[]): Options {
  const values: Record<string, string> = {};
  const flags = new Set(['--payload', '--output-dir', '--expect-provider', '--gateway', '--warmups', '--repeats', '--poll-ms', '--timeout']);
  let run = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--run') { if (run) throw Error('Duplicate --run'); run = true; continue; }
    if (flag === '--plan') continue;
    if (!flags.has(flag) || !argv[i + 1] || argv[i + 1].startsWith('--') || flag in values) throw Error('Unknown, duplicate or missing option: ' + flag);
    values[flag] = argv[++i];
  }
  if (run && argv.includes('--plan')) throw Error('Choose --plan or --run');
  for (const flag of ['--payload', '--output-dir', '--expect-provider']) if (!values[flag]) throw Error('Required: ' + flag);
  const provider = values['--expect-provider'];
  if (provider !== 'native' && provider !== 'comfy') throw Error('--expect-provider must be native or comfy');
  const url = new URL(gateway.gatewayUrl(values['--gateway'] ?? 'http://127.0.0.1:3000'));
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.pathname !== '/') throw Error('--gateway must be a literal loopback HTTP origin');
  function bounded(flag: string, fallback: number, min: number, max: number) {
    const value = Number(values[flag] ?? fallback);
    if (!Number.isInteger(value) || value < min || value > max) throw Error(`${flag} must be ${min}..${max}`);
    return value;
  }
  return { payload: path.resolve(values['--payload']), output: path.resolve(values['--output-dir']), gateway: url.origin, provider, run,
    warmups: bounded('--warmups', 1, 1, 5), repeats: bounded('--repeats', 6, 2, 50),
    poll: bounded('--poll-ms', 100, 10, 5000), timeout: bounded('--timeout', 600, 1, 3600) };
}

function prepare(opts: Options) {
  if (fs.existsSync(opts.output)) throw Error('--output-dir must be new; evidence is never overwritten');
  const raw = fs.readFileSync(opts.payload);
  if (raw.length > 64 * 1024) throw Error('Payload exceeds the gateway 64 KiB request limit');
  const payload = JSON.parse(raw.toString('utf8'));
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.prompt !== 'string' || !payload.prompt.trim()) throw Error('Supply an actual API payload object with a nonempty prompt');
  for (const field of ['sampler', 'scheduler']) if (Object.hasOwn(payload, field)) throw Error(`${field} is not accepted by /api/anima/jobs; sampler and scheduler are selected by the provider/catalog`);
  if (!Number.isSafeInteger(payload.seed) || payload.seed < 0 || !Number.isSafeInteger(payload.seed + opts.warmups + opts.repeats - 1)) throw Error('Payload needs an explicit nonnegative safe integer seed and a safe seed sequence');
  const runs: Run[] = [];
  for (let i = 0; i < opts.warmups + opts.repeats; i++) runs.push({ phase: i < opts.warmups ? 'warmup' : 'measured',
    index: i < opts.warmups ? i : i - opts.warmups, requestedSeed: payload.seed + i });
  const plan = { mode: 'plan', gateway: opts.gateway, expectProvider: opts.provider, outputDir: opts.output,
    sourcePayloadSha256: hash(raw), payload, submissions: runs.length, runs, pollMilliseconds: opts.poll,
    configurationEvidence: 'not-read-in-plan', scheduleEvidence: 'unverified', qualityEvidence: 'unreviewed', limitations: LIMITATIONS };
  return { payload, runs, plan };
}

async function observation(opts: Options, route: string) {
  try {
    const response = await fetch(opts.gateway + route, { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw Error('HTTP ' + response.status);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body as any) {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) throw Error('Observation exceeds 1 MiB');
      chunks.push(chunk);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || value.ok === false) throw Error('Invalid observation');
    return { status: 'observed', route, value };
  } catch (error) {
    return { status: 'unverified', route, reason: error instanceof Error ? error.message : String(error), value: null };
  }
}

function verifyPreflight(opts: Options, settings: any, status: any) {
  // configured is a saved target; active is what this host actually selected.
  const active = settings.value?.active?.engine;
  if (typeof active === 'string' && active !== opts.provider) throw Error(`Active engine ${active} does not match expected ${opts.provider}; saved configured engine is not active until restart`);
  const provider = status.value?.provider;
  if (typeof provider === 'string' && provider !== opts.provider) throw Error(`Status provider ${provider} does not match expected ${opts.provider}`);
  if (typeof status.value?.pending === 'number' && status.value.pending !== 0) throw Error('Gateway has pending jobs; use the device exclusively');
  return { activeEngine: active ?? null, configuredEngine: settings.value?.configured?.engine ?? null,
    restartRequired: settings.value?.restartRequired ?? null,
    engineEvidence: active === opts.provider ? 'active-settings-match' : provider === opts.provider ? 'status-provider-match' : 'unverified-until-job-completion',
    queueEvidence: status.value?.pending === 0 ? 'gateway-pending-zero-snapshot' : 'unverified',
    settingsRead: settings.status, statusRead: status.status };
}

async function measure(opts: Options, payload: any, run: Run, seenIds: Set<string>, seenImages: Set<string>) {
  const label = `${run.phase}-${run.index}`, folder = path.join(opts.output, label);
  fs.mkdirSync(folder);
  const request = { ...payload, seed: run.requestedSeed };
  write(path.join(folder, 'request.json'), request);
  // No record.seed fallback: an absent server seed must stay unverified and fail.
  const record: Record<string, any> = { ...run, gateway: opts.gateway, payload: request, requestSha256: hash(JSON.stringify(request)), status: 'preflight' };
  const save = () => fs.writeFileSync(path.join(folder, 'status.json'), JSON.stringify(record, null, 2) + '\n');
  save();
  try {
    const settings = await observation(opts, '/api/inference/settings');
    const status = await observation(opts, '/api/anima/status');
    write(path.join(folder, 'preflight.json'), { settings, status });
    record.preflight = verifyPreflight(opts, settings, status);
    const started = performance.now();
    const image = await gateway.generate(record, () => {
      save();
      if (record.status === 'submitted') {
        if (seenIds.has(record.jobId)) throw Error('Gateway reused a job ID; fresh inference is unverified');
        seenIds.add(record.jobId);
      }
      if (record.status === 'downloading') {
        if (record.provider !== opts.provider) throw Error(`Completed provider ${record.provider || '(missing)'} does not match expected ${opts.provider}`);
        if (!Number.isSafeInteger(record.actualSeed) || record.actualSeed !== run.requestedSeed) throw Error('Server-reported seed is missing or differs from the requested fresh seed');
      }
    }, { pollMs: opts.poll, timeoutMs: opts.timeout * 1000, signal: AbortSignal.timeout(opts.timeout * 1000),
      fetchImpl: (input: any, init: any) => fetch(input, { ...init, cache: 'no-store' }) });
    const outputSha256 = hash(image.buffer);
    fs.writeFileSync(path.join(folder, 'output.png'), image.buffer, { flag: 'wx' });
    Object.assign(record, { wallSeconds: (performance.now() - started) / 1000, outputSha256,
      image: `${label}/output.png`, width: image.width, height: image.height, bytes: image.buffer.length });
    if (seenImages.has(outputSha256)) throw Error('Identical image bytes returned for different seeds; result reuse or degenerate output must be investigated');
    seenImages.add(outputSha256);
    record.status = 'succeeded'; save();
    return record;
  } catch (error) {
    record.failure = error instanceof Error ? error.message : String(error);
    record.status = record.status === 'submitting' && !record.jobId ? 'submission-unknown' : 'stopped';
    save();
    throw Error(`${record.failure}; evidence: ${folder}; job ${record.jobId ?? 'not identified'}. No retry or interrupt was sent; inspect the gateway before another run.`);
  }
}

function review(report: any) {
  const escape = (value: any) => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
  const rows = report.runs.map((run: any) => `<figure><figcaption>${escape(run.phase)} ${run.index} · ${escape(run.provider)} · seed ${run.actualSeed} · ${run.wallSeconds.toFixed(3)}s · ${run.width}×${run.height}</figcaption><img src="${escape(run.image)}" width="384"><details><summary>Server parameters and native observations, if available</summary><pre>${escape(JSON.stringify(run.serverMetadata ?? null, null, 2))}</pre></details></figure>`).join('');
  return '<!doctype html><meta charset="utf-8"><title>Product gateway benchmark</title><style>body{font:16px system-ui;max-width:1100px;margin:2em auto;padding:1em;background:#f8fafc;color:#17202a}main{display:flex;flex-wrap:wrap}figure{margin:12px}img{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>'
    + `<h1>${escape(report.expectProvider)} product gateway: measured, quality unreviewed</h1><p>${escape(LIMITATIONS)}</p><p>Run each engine alone on the GPU. After switching engines, release the previous engine and warm up again. No speedup verdict.</p><pre>${escape(JSON.stringify(report.summary, null, 2))}</pre><main>${rows}</main>`;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) { console.log(HELP); return { mode: 'help' }; }
  const opts = options(argv), prepared = prepare(opts);
  if (!opts.run) { console.log(JSON.stringify(prepared.plan, null, 2)); return prepared.plan; }
  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.mkdirSync(opts.output);
  write(path.join(opts.output, 'plan.json'), prepared.plan);
  const runs = [], seenIds = new Set<string>(), seenImages = new Set<string>();
  for (const run of prepared.runs) runs.push(await measure(opts, prepared.payload, run, seenIds, seenImages));
  const report = { schemaVersion: 1, status: 'measured-quality-unreviewed', expectProvider: opts.provider,
    gateway: opts.gateway, sourcePayloadSha256: prepared.plan.sourcePayloadSha256, pollMilliseconds: opts.poll,
    scheduleEvidence: 'unverified', precisionParity: 'unverified', qualityEvidence: 'unreviewed', peakVram: null,
    summary: { wallSeconds: statistics(runs.filter(run => run.phase === 'measured').map(run => run.wallSeconds)),
      preflight: { engineUnverifiedRuns: runs.filter(run => run.preflight.engineEvidence === 'unverified-until-job-completion').length,
        queueUnverifiedRuns: runs.filter(run => run.preflight.queueEvidence === 'unverified').length,
        restartRequiredRuns: runs.filter(run => run.preflight.restartRequired === true).length,
        note: 'Missing settings/status evidence is not proof of engine selection or GPU exclusivity. Completed provider and server seed are checked for every job.' } },
    limitations: LIMITATIONS, runs };
  write(path.join(opts.output, 'report.json'), report);
  fs.writeFileSync(path.join(opts.output, 'review.html'), review(report), { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, provider: opts.provider, summary: report.summary, review: path.join(opts.output, 'review.html') }, null, 2));
  return report;
}

if (require.main === module) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
export = { options, prepare, verifyPreflight, main };
