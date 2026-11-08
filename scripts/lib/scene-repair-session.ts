import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import gateway = require('./generation-gateway');
import safety = require('./generation-candidates');
import { generateShowcaseCandidate, matchesShowcaseImage, saveShowcaseImage } from './legacy-showcase-generation';
import type { GatewayRecord } from './generation-types';
import { hash, object, type Data, type Context, type compile } from './scene-repair-content';
import type { Diagnosis, Visual } from './scene-repair-model';
import type { RepairTags } from './scene-repair-tags';
const { noLinks } = safety;

export type Compiled = ReturnType<typeof compile>;
export type TagScan = Awaited<ReturnType<RepairTags['scan']>>;
export type ImageJob = GatewayRecord & Data & { key: string; attempt: number; recordId: string; image: string; sha256?: string };
export interface Round { data: Data; compiled: Compiled; diagnosis: Diagnosis; tags: TagScan; job?: ImageJob; visual?: Visual }
export interface Item {
  sourceHash: string; original: Context; baseline: Compiled; tags: TagScan; job?: ImageJob;
  rounds: Round[]; status: string; notes: string[]; semantic: boolean; appliedRevision?: number;
  exported?: boolean;
  applying?: { expectedRevision: number; dataHash: string };
}

/** Per-record checkpoints keep writes linear in batch size; large character dossiers are not rewritten for every scene. */
export class RepairSession {
  private lock: number | undefined;
  private readonly id: string;
  private readonly lockFile: string;
  private readonly items = new Map<string, Item>();
  constructor(readonly output: string, runtime: string, identity: unknown) {
    const relative = path.relative(runtime, output);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error('--output 必须在 runtime 内的独立子目录');
    this.id = hash(identity).slice(0, 16);
    noLinks(output); fs.mkdirSync(output, { recursive: true });
    this.lockFile = path.join(output, `session-${this.id}.lock`);
    if (fs.existsSync(this.lockFile)) {
      const pid = Number(fs.readFileSync(noLinks(this.lockFile), 'utf8'));
      let alive = true;
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (error) { if (object(error) && error.code === 'ESRCH') alive = false; }
      } else if (Date.now() - fs.statSync(this.lockFile).mtimeMs > 60000) alive = false;
      if (!alive) fs.unlinkSync(this.lockFile);
    }
    try { this.lock = fs.openSync(this.lockFile, 'wx'); fs.writeFileSync(this.lock, String(process.pid)); }
    catch { throw new Error('同一批次已有进程运行，请等待该进程完成'); }
  }
  private filename(slot: string) { return `item-${this.id}-${hash(slot).slice(0, 24)}.json`; }
  get(slot: string): Item | undefined {
    const cached = this.items.get(slot);
    if (cached) return cached;
    const file = noLinks(path.join(this.output, this.filename(slot)));
    if (!fs.existsSync(file)) return;
    try {
      const saved: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!object(saved) || saved.schema !== 2 || saved.slot !== slot || !object(saved.item)) return;
      const item = saved.item as unknown as Item;
      if (!Array.isArray(item.rounds) || !Array.isArray(item.notes) || typeof item.sourceHash !== 'string') return;
      this.items.set(slot, item); return item;
    } catch { return; }
  }
  set(slot: string, item: Item) { this.items.set(slot, item); this.save(slot); }
  save(slot: string) { this.write(this.filename(slot), { schema: 2, slot, item: this.items.get(slot) }); }
  write(relative: string, value: unknown) {
    if (!/^[a-z0-9][a-z0-9.-]*\.json$/i.test(relative)) throw new Error('运行记录路径无效');
    const target = noLinks(path.join(this.output, relative)), temp = noLinks(`${target}.${randomUUID()}.tmp`);
    fs.writeFileSync(temp, JSON.stringify(value) + '\n', { flag: 'wx' }); fs.renameSync(temp, target);
  }
  raw(label: string, value: unknown) { this.write(`raw-${label.replace(/[^a-z0-9-]/gi, '-')}-${randomUUID()}.json`, value); }
  image(job: ImageJob) {
    const expected = path.join(this.output, `${hash(job.recordId).slice(0, 24)}.png`);
    if (job.image && job.image !== expected) throw new Error('图片路径与任务身份不一致');
    return noLinks(expected);
  }
  async render(owner: Item | Round, compiled: Compiled, slot: string, attempt: number, base: string, signal: AbortSignal) {
    const payload = { ...compiled.payload, seed: parseInt(hash(slot).slice(0, 7), 16) };
    if (!owner.job) {
      owner.job = { key: slot, attempt, recordId: `${slot}@attempt-${attempt}-${randomUUID()}`,
        gateway: gateway.gatewayUrl(base), payload, seed: payload.seed, status: 'planned', image: '' };
      this.save(slot);
    }
    const job = owner.job;
    if (hash(job.payload) !== hash(payload) || job.gateway !== gateway.gatewayUrl(base)) throw new Error('原出图请求已变化');
    const file = this.image(job);
    if (job.status === 'succeeded') {
      if (!matchesShowcaseImage(job, file)) throw new Error('图片已缺失或字节变化');
      return file;
    }
    if (['failed', 'cancelled'].includes(job.status) || !job.jobId && job.status !== 'planned')
      throw new Error(`原任务 ${job.jobId || job.recordId} 为 ${job.status}，保留原任务，不重复提交`);
    try {
      const result = await generateShowcaseCandidate(job, () => this.save(slot), 0, signal);
      if (result.width !== payload.width || result.height !== payload.height || result.actualSeed !== payload.seed)
        throw new Error('实际画幅或种子与请求不一致');
      job.sha256 = saveShowcaseImage(file, result.buffer, job.sha256);
      Object.assign(job, { image: file, status: 'succeeded', bytes: result.buffer.length, actualSeed: result.actualSeed });
      this.save(slot); return file;
    } catch (error) {
      if (signal.aborted && job.jobId && !['failed', 'succeeded', 'cancelled'].includes(job.status)) {
        try {
          const response = await fetch(`${job.gateway}/api/anima/jobs/${encodeURIComponent(job.jobId)}`, {
            method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(5000),
          });
          job.cancelRequested = response.ok;
        } catch { job.cancelRequested = false; }
        this.save(slot);
      }
      throw error;
    }
  }
  close() {
    if (this.lock !== undefined) { fs.closeSync(this.lock); this.lock = undefined; fs.unlinkSync(this.lockFile); }
  }
}
