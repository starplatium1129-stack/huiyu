'use strict';

/** Existing ComfyUI benchmark: explicit local workflow, warm repetitions, no implicit model calls. */
const fs: typeof import('node:fs') = require('node:fs');
const path: typeof import('node:path') = require('node:path');
const crypto: typeof import('node:crypto') = require('node:crypto');
const { performance }: typeof import('node:perf_hooks') = require('node:perf_hooks');
const { setTimeout: delay }: typeof import('node:timers/promises') = require('node:timers/promises');
const { validatePng }: typeof import('../lib/generation-gateway') = require('../lib/generation-gateway');

type Node = { class_type: string; inputs: Record<string, any> };
type Graph = Record<string, Node>;
type Variant = 'baseline' | 'cached';
type Options = { workflow: string; output: string; sampler: string; teaCache?: string;
  endpoint: string; repeats: number; warmups: number; timeout: number; poll: number; run: boolean };
type Run = { phase: 'warmup' | 'measured'; variant: Variant; index: number; seed: number };
const LIMITATIONS = 'Warmed workflow measurements, not verified GPU residency or a disk-cold start. '
  + 'Completion includes submission, queue, graph execution, PNG saving and history polling; delivered time also includes downloading and verifying PNGs. '
  + 'Server event time is graph time, not synchronized sampler-only GPU time. Poll interval bounds extra observation latency only, not HTTP latency. '
  + 'Output SHA-256 covers complete PNG files, including metadata; differing hashes do not establish differing decoded pixels or fresh sampling. '
  + 'System stats are snapshots, not peak VRAM. Checkpoint bytes, actual sigma schedules, precision, attention and native/ComfyUI numerical equivalence are not verified. '
  + 'The same sampler/scheduler names or seeds do not establish parity. No cross-backend speedup or image-quality verdict is produced.';
const HELP = 'node scripts/tests/benchmark-anima-teacache.js --workflow <Comfy API JSON> --sampler-node <KSampler id> '
  + '--output-dir <new runtime directory> [--teacache-node <AnimaTeaCache id>] [--repeats 6] [--warmups 1] '
  + '[--endpoint http://127.0.0.1:8188] [--timeout 600] [--poll-ms 100] [--run]\n'
  + 'Default is a read-only, zero-network plan. Only --run submits the displayed jobs to an already prepared local ComfyUI. '
  + 'No installation, server start, cache flush, interrupt or automatic retry.\n' + LIMITATIONS;
const sha = (value: string | Buffer) => crypto.createHash('sha256').update(value).digest('hex');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const record = (value: any): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const link = (value: any): value is [string, number] => Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1]);
const write = (file: string, value: any) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });

function options(argv: string[]): Options {
  const values: Record<string, string> = {};
  const flags = new Set(['--workflow', '--output-dir', '--sampler-node', '--teacache-node', '--endpoint', '--repeats', '--warmups', '--timeout', '--poll-ms']);
  let run = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--run') { if (run) throw Error('Duplicate --run'); run = true; continue; }
    if (flag === '--plan') continue;
    if (!flags.has(flag) || !argv[i + 1] || argv[i + 1].startsWith('--') || flag in values) throw Error('Unknown, duplicate or missing option: ' + flag);
    values[flag] = argv[++i];
  }
  if (run && argv.includes('--plan')) throw Error('Choose --plan or --run');
  for (const name of ['--workflow', '--sampler-node', '--output-dir']) if (!values[name]) throw Error('Required: ' + name);
  function bounded(flag: string, fallback: number, min: number, max: number) {
    const n = Number(values[flag] ?? fallback);
    if (!Number.isInteger(n) || n < min || n > max) throw Error(`${flag} must be ${min}..${max}`);
    return n;
  }
  const url = new URL(values['--endpoint'] ?? 'http://127.0.0.1:8188');
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw Error('--endpoint must be a literal loopback HTTP origin without credentials');
  }
  return { workflow: path.resolve(values['--workflow']), output: path.resolve(values['--output-dir']), sampler: values['--sampler-node'],
    teaCache: values['--teacache-node'], endpoint: url.origin, repeats: bounded('--repeats', 6, 2, 50),
    warmups: bounded('--warmups', 1, 1, 5), timeout: bounded('--timeout', 600, 1, 3600), poll: bounded('--poll-ms', 100, 10, 5000), run };
}

function prepare(opts: Options) {
  const raw = fs.readFileSync(opts.workflow);
  if (raw.length > 4 * 1024 * 1024) throw Error('Workflow exceeds 4 MiB');
  const input = JSON.parse(raw.toString('utf8'));
  const graph: Graph = input.prompt ?? input;
  if (!record(graph) || !Object.keys(graph).length || !Object.values(graph).every(node => record(node) && typeof node.class_type === 'string' && record(node.inputs))) {
    throw Error('Supply an exported ComfyUI API prompt graph, not a UI workflow');
  }
  if (fs.existsSync(opts.output)) throw Error('--output-dir must be new; existing evidence is never overwritten');
  const sampler = graph[opts.sampler];
  if (sampler?.class_type !== 'KSampler') throw Error('--sampler-node must identify a KSampler');
  if (Object.values(graph).filter(node => node.class_type === 'KSampler').length !== 1) throw Error('Use one KSampler per benchmark workflow');
  const seed = sampler.inputs.seed;
  if (!Number.isSafeInteger(seed) || seed < 0 || !Number.isSafeInteger(seed + opts.warmups * 2 + opts.repeats)) throw Error('Seed sequence must use nonnegative safe integers');
  const saves = Object.keys(graph).filter(id => graph[id].class_type === 'SaveImage');
  if (saves.length !== 1) throw Error('Use one SaveImage output per benchmark workflow');
  const visited = new Set<string>();
  function visit(id: string) {
    if (visited.has(id)) return;
    if (!graph[id]) throw Error('Workflow references a missing node: ' + id);
    visited.add(id);
    for (const value of Object.values(graph[id].inputs)) if (link(value)) visit(value[0]);
  }
  visit(saves[0]);
  if (!visited.has(opts.sampler)) throw Error('SaveImage must depend on the selected sampler');
  if (visited.size !== Object.keys(graph).length) throw Error('Remove unrelated nodes/outputs from the benchmark workflow');
  if (opts.teaCache) {
    if (Object.entries(graph).some(([id, node]) => /teacache/i.test(node.class_type) && id !== opts.teaCache)) throw Error('Use only the selected TeaCache node');
    const tea = graph[opts.teaCache];
    if (tea?.class_type !== 'AnimaTeaCache' || !link(tea.inputs.model) || JSON.stringify(sampler.inputs.model) !== JSON.stringify([opts.teaCache, 0])) {
      throw Error('--teacache-node must be an AnimaTeaCache directly feeding the KSampler model');
    }
    if (Object.entries(graph).some(([id, node]) => id !== opts.sampler && Object.values(node.inputs).some(value => link(value) && value[0] === opts.teaCache))) {
      throw Error('TeaCache may only feed the selected sampler');
    }
  } else if (Object.values(graph).some(node => /teacache/i.test(node.class_type))) throw Error('Select --teacache-node explicitly; a cached baseline is not valid');
  const variants: Variant[] = opts.teaCache ? ['baseline', 'cached'] : ['baseline'];
  const runs: Run[] = [];
  let nextSeed = seed;
  for (let i = 0; i < opts.warmups; i++) for (const variant of variants) runs.push({ phase: 'warmup', variant, index: i, seed: nextSeed++ });
  for (let i = 0; i < opts.repeats; i++) {
    const order = i % 2 ? [...variants].reverse() : variants;
    for (const variant of order) runs.push({ phase: 'measured', variant, index: i, seed: nextSeed });
    nextSeed++;
  }
  return { graph, saves, runs, workflowSha256: sha(raw), plan: { mode: 'plan', workflowSubmissions: runs.length, runs,
    endpoint: opts.endpoint, outputDir: opts.output, workflowSha256: sha(raw), samplerInputs: sampler.inputs,
    teaCacheInputs: opts.teaCache ? graph[opts.teaCache].inputs : null, scope: 'ComfyUI workflow only',
    nativeSigmaParity: 'not-established', limitations: LIMITATIONS } };
}

function workflowFor(graph: Graph, opts: Options, run: Run, prefix: string): Graph {
  const prompt = clone(graph);
  if (opts.teaCache && run.variant === 'baseline') {
    prompt[opts.sampler].inputs.model = prompt[opts.teaCache].inputs.model;
    delete prompt[opts.teaCache];
  }
  prompt[opts.sampler].inputs.seed = run.seed;
  for (const node of Object.values(prompt)) if (node.class_type === 'SaveImage') node.inputs.filename_prefix = prefix;
  return prompt;
}

async function request(opts: Options, route: string, deadline: number, payload?: any, binary = false) {
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw Error('ComfyUI deadline exceeded');
  const response = await fetch(opts.endpoint + route, { redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(30000, remaining)))),
    ...(payload === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }) });
  if (!response.ok) throw Error(`ComfyUI HTTP ${response.status} at ${route.split('?')[0]}`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body as any) {
    size += chunk.length;
    if (size > (binary ? 64 : 16) * 1024 * 1024) throw Error('ComfyUI response exceeds size limit');
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  return binary ? buffer : JSON.parse(buffer.toString('utf8'));
}

function completed(history: any, id: string, sampler: string, save: string) {
  if (!record(history) || !record(history[id])) return null;
  const entry = history[id], status = entry.status;
  if (!record(status) || status.completed !== true || status.status_str !== 'success') throw Error('ComfyUI execution did not succeed: ' + id);
  if (!Array.isArray(entry.prompt) || entry.prompt[1] !== id) throw Error('ComfyUI history identity mismatch');
  const messages: any[] = status.messages;
  if (!Array.isArray(messages)) throw Error('ComfyUI history lacks execution evidence');
  const event = (name: string) => messages.find(message => message[0] === name && message[1]?.prompt_id === id)?.[1];
  if (event('execution_error') || event('execution_interrupted') || !event('execution_start') || !event('execution_success')) throw Error('ComfyUI history lacks successful execution events');
  const cacheEvents = messages.filter(message => message[0] === 'execution_cached' && message[1]?.prompt_id === id);
  if (!cacheEvents.length || cacheEvents.some(message => !Array.isArray(message[1].nodes))) throw Error('ComfyUI history lacks cache evidence');
  const cachedNodes = cacheEvents.flatMap(message => message[1].nodes.map(String));
  if (cachedNodes.includes(sampler) || cachedNodes.includes(save)) throw Error('Sampler/output was served from node cache; not an inference measurement');
  const images = entry.outputs?.[save]?.images;
  if (!Array.isArray(images) || images.length !== 1 || images[0]?.type !== 'output' || typeof images[0].filename !== 'string' || typeof images[0].subfolder !== 'string') {
    throw Error('Require exactly one saved image in the selected output');
  }
  const start = event('execution_start').timestamp, end = event('execution_success').timestamp;
  const graphSeconds = Number.isFinite(start) && Number.isFinite(end) && end >= start ? (end - start) / 1000 : null;
  return { graphSeconds, cachedNodes, image: images[0], raw: entry };
}

async function measure(opts: Options, prepared: ReturnType<typeof prepare>, run: Run, runId: string) {
  const label = `${run.phase}-${run.index}-${run.variant}`;
  const folder = path.join(opts.output, label);
  fs.mkdirSync(folder);
  const prompt = workflowFor(prepared.graph, opts, run, `huiyu_benchmark/${runId}/${label}`);
  write(path.join(folder, 'prompt.json'), prompt);
  const state: Record<string, any> = { ...run, status: 'preflight', promptSha256: sha(JSON.stringify(prompt)) };
  const saveState = () => fs.writeFileSync(path.join(folder, 'status.json'), JSON.stringify(state, null, 2));
  const deadline = performance.now() + opts.timeout * 1000;
  try {
    const queue = await request(opts, '/queue', deadline);
    if (!Array.isArray(queue.queue_running) || !Array.isArray(queue.queue_pending) || queue.queue_running.length || queue.queue_pending.length) throw Error('ComfyUI queue must be empty; use the device exclusively');
    const started = performance.now();
    state.status = 'submission-unknown'; saveState();
    const accepted = await request(opts, '/prompt', deadline, { prompt, client_id: runId });
    if (typeof accepted.prompt_id !== 'string' || !accepted.prompt_id || (accepted.node_errors && Object.keys(accepted.node_errors).length)) throw Error('ComfyUI rejected or did not identify the submitted prompt');
    const id = accepted.prompt_id;
    state.promptId = id; state.status = 'submitted'; saveState();
    let result;
    while (!result) {
      result = completed(await request(opts, '/history/' + encodeURIComponent(id), deadline), id, opts.sampler, prepared.saves[0]);
      if (!result) await delay(Math.min(opts.poll, Math.max(0, deadline - performance.now())));
    }
    const completionSeconds = (performance.now() - started) / 1000;
    state.status = 'downloading'; saveState();
    write(path.join(folder, 'history.json'), result.raw);
    const query = new URLSearchParams({ filename: result.image.filename, subfolder: result.image.subfolder, type: 'output' });
    const buffer: Buffer = await request(opts, '/view?' + query, deadline, undefined, true);
    const imageInfo = validatePng(buffer);
    fs.writeFileSync(path.join(folder, 'output.png'), buffer, { flag: 'wx' });
    const deliveredSeconds = (performance.now() - started) / 1000;
    Object.assign(state, { status: 'succeeded', completionSeconds, deliveredSeconds, graphSeconds: result.graphSeconds,
      cachedNodes: result.cachedNodes, image: `${label}/output.png`, imageInfo, outputSha256: sha(buffer) });
    saveState();
    return state;
  } catch (error) {
    state.failure = error instanceof Error ? error.message : String(error); saveState();
    throw Error(`${state.failure}; evidence: ${folder}; prompt ${state.promptId ?? 'submission unknown'}. No retry or global interrupt was sent.`);
  }
}

function statistics(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b), n = sorted.length;
  return { count: n, min: sorted[0], median: (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2,
    max: sorted[n - 1], p95: n >= 20 ? sorted[Math.ceil(n * .95) - 1] : null,
    p95Note: n >= 20 ? 'nearest-rank observed percentile' : 'not reported for fewer than 20 samples' };
}

function review(report: any) {
  const escape = (value: any) => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
  const images = report.runs.filter((run: any) => run.phase === 'measured').map((run: any) => `<figure><figcaption>${escape(run.variant)} · seed ${run.seed} · completion ${run.completionSeconds.toFixed(3)}s</figcaption><img src="${escape(run.image)}" width="384"></figure>`).join('');
  return '<!doctype html><meta charset="utf-8"><title>ComfyUI Anima benchmark</title><style>body{font:16px system-ui;max-width:1100px;margin:2em auto;padding:1em;background:#f8fafc;color:#17202a}main{display:flex;flex-wrap:wrap}figure{margin:12px}img{max-width:100%;height:auto}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style>'
    + `<h1>ComfyUI Anima: measured workflow, quality unreviewed</h1><p>${escape(LIMITATIONS)}</p><pre>${escape(JSON.stringify(report.summary, null, 2))}</pre><main>${images}</main>`;
}

async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help')) { console.log(HELP); return { mode: 'help' }; }
  const opts = options(argv), prepared = prepare(opts);
  if (!opts.run) { console.log(JSON.stringify(prepared.plan, null, 2)); return prepared.plan; }
  fs.mkdirSync(path.dirname(opts.output), { recursive: true });
  fs.mkdirSync(opts.output);
  write(path.join(opts.output, 'plan.json'), prepared.plan);
  const environment = await request(opts, '/system_stats', performance.now() + 30000);
  write(path.join(opts.output, 'environment.json'), environment);
  const runs = [], runId = crypto.randomUUID();
  for (const run of prepared.runs) runs.push(await measure(opts, prepared, run, runId));
  const summary: Record<string, any> = {};
  for (const variant of opts.teaCache ? ['baseline', 'cached'] : ['baseline']) {
    const measured = runs.filter(run => run.phase === 'measured' && run.variant === variant);
    summary[variant] = { completionSeconds: statistics(measured.map(run => run.completionSeconds)),
      deliveredSeconds: statistics(measured.map(run => run.deliveredSeconds)),
      graphSeconds: measured.every(run => run.graphSeconds !== null) ? statistics(measured.map(run => run.graphSeconds)) : null };
  }
  const report = { schemaVersion: 2, status: 'measured-quality-unreviewed', workflowSha256: prepared.workflowSha256,
    environment, pollMilliseconds: opts.poll, nativeSigmaParity: 'not-established', peakVram: null, limitations: LIMITATIONS, summary, runs };
  write(path.join(opts.output, 'report.json'), report);
  fs.writeFileSync(path.join(opts.output, 'review.html'), review(report), { flag: 'wx' });
  console.log(JSON.stringify({ status: report.status, summary, review: path.join(opts.output, 'review.html') }, null, 2));
  return report;
}

if (require.main === module) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
export = { options, prepare, workflowFor, completed, statistics, main };
