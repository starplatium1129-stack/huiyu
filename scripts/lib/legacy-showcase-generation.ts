import type { GatewayRecord } from './generation-types';
import gateway = require('./generation-gateway');
import fs = require('node:fs');
import path = require('node:path');
import crypto = require('node:crypto');
import { setTimeout as delay } from 'node:timers/promises';
import { errorMessage } from './runtime-errors';
const { object }: typeof import('./content-history-reader') = require('./content-history-reader');
const { noLinks }: typeof import('./generation-candidates') = require('./generation-candidates');

type CandidateSlot = { key: string; attempt: number };
type Candidate = Record<string, unknown> & CandidateSlot & { recordId: string; seed: number };
type SavedCandidate = Record<string, unknown> & GatewayRecord & CandidateSlot & { recordId: string; error?: string };

export function showcaseManifestError(record: SavedCandidate, error: unknown): Error {
  const task = record.jobId ? `；原任务编号 ${JSON.stringify(record.jobId)}，请在原网关核对`
    : record.status === 'planned' ? '' : '；提交状态未知，请先核对原网关';
  return new Error(`候选 ${record.recordId} 的清单保存失败：${errorMessage(error)}${task}`, { cause: error });
}

export const showcaseSlot = (candidate: CandidateSlot) => JSON.stringify([candidate.key, candidate.attempt]);

export function showcaseAttempt(value: string, option: string): number {
  const attempt = Number(value);
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error(`${option} 必须是正整数`);
  return attempt;
}

export function showcaseImagePath(output: string, ...parts: string[]): string {
  if (parts.some(part => !part || part === '.' || part === '..' || /[\\/:*?"<>|\x00-\x1f]/.test(part)
    || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error('候选图片身份不能作为文件路径');
  }
  const file = path.resolve(output, 'images', ...parts), relative = path.relative(output, file);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('候选图片路径超出候选目录');
  }
  return noLinks(file);
}

export function indexShowcaseCandidates<T extends CandidateSlot & { recordId: string }>(records: T[]): Map<string, T> {
  const indexed = new Map<string, T>();
  const identities = new Set<string>();
  for (const record of records) {
    const slot = showcaseSlot(record);
    const prefix = `${record.key}@attempt-${record.attempt}`;
    const suffix = record.recordId.startsWith(prefix) ? record.recordId.slice(prefix.length) : null;
    if (suffix === null || (suffix !== '' && !/^-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(suffix))) {
      throw new Error('候选记录编号与主体或 attempt 不一致');
    }
    if (identities.has(record.recordId) || indexed.has(slot)) throw new Error('候选清单包含重复记录编号或 attempt');
    identities.add(record.recordId);
    indexed.set(slot, record);
  }
  return indexed;
}

export function prepareShowcaseCandidate<T extends Candidate, P extends Record<string, unknown> & CandidateSlot & { recordId: string }>(
  candidate: T, previous: P | undefined, base: string, payload: Record<string, unknown>, force: boolean,
): (T | P) & SavedCandidate {
  const gatewayUrl = gateway.gatewayUrl(base);
  const sameRequest = previous?.gateway === gatewayUrl && object(previous.payload)
    && JSON.stringify(previous.payload) === JSON.stringify(payload);
  if (previous && previous.status !== 'succeeded') {
    if (!sameRequest || typeof previous.status !== 'string' || showcaseSlot(previous) !== showcaseSlot(candidate)
      || !(previous.jobId === undefined || previous.jobId === null || typeof previous.jobId === 'string')) {
      throw new Error('原候选的网关或请求身份无法核对；请先核对旧任务，再使用新的 attempt 或候选目录');
    }
    if (!previous.jobId && previous.status !== 'planned') {
      throw new Error('原候选提交状态未知；请先核对网关，再使用新的 attempt 或候选目录');
    }
    return previous as P & SavedCandidate;
  }
  if (previous) {
    if (!force && sameRequest && typeof previous.jobId === 'string' && previous.jobId
      && typeof previous.sha256 === 'string' && /^[a-f0-9]{64}$/.test(previous.sha256)) {
      return previous as P & SavedCandidate;
    }
    throw new Error('此 attempt 已完成；重画或更改配方请使用新的 attempt 或候选目录');
  }
  return { ...candidate, recordId: `${candidate.recordId}-${crypto.randomUUID()}`, gateway: gatewayUrl, payload, status: 'planned', image: '' };
}

export function matchesShowcaseImage(record: Record<string, unknown> | undefined, file: string): boolean {
  if (!record || typeof record.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(record.sha256)) return false;
  try {
    noLinks(file);
    const info = fs.statSync(file);
    return info.isFile() && info.size > 1000 && record.bytes === info.size
      && crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') === record.sha256;
  } catch { return false; }
}

export function saveShowcaseImage(file: string, buffer: Buffer, expectedHash?: string): string {
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  if (expectedHash && hash !== expectedHash) throw new Error('原任务返回的图片与已登记的候选不一致');
  noLinks(file);
  if (fs.existsSync(file)) {
    const info = fs.statSync(file);
    if (!info.isFile() || info.size !== buffer.length
      || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== hash)
      throw new Error('候选图片路径已有不同内容，请先核对原文件');
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    noLinks(file);
    fs.writeFileSync(file, buffer, { flag: 'wx' });
  }
  return hash;
}

export async function generateShowcaseCandidate<T extends SavedCandidate>(
  record: T, save: (record: T) => void, busyRetries: number, signal?: AbortSignal,
) {
  const saveDurably = (value: T) => {
    try { save(value); }
    catch (error) { throw Object.assign(new Error(`候选清单保存失败：${errorMessage(error)}`), { showcaseManifestError: true }); }
  };
  saveDurably(record);
  for (let retry = 0; ; retry++) {
    try {
      const image = await gateway.generate(record, saveDurably, { timeoutMs: 15 * 60 * 1000, signal });
      return { ...image, jobId: record.jobId!, provider: record.provider || '',
        actualSeed: record.actualSeed ?? record.seed, metadata: object(record.serverMetadata) ? record.serverMetadata : {} };
    } catch (error) {
      if (object(error) && error.showcaseManifestError === true) throw error;
      const busy = !record.jobId && object(error) && error.gatewayHttpStatus === 429;
      record.status = busy ? 'planned' : record.jobId
        ? object(error) && error.definitive === true ? 'failed' : 'recoverable'
        : 'submission-unknown';
      record.error = errorMessage(error);
      saveDurably(record);
      if (!busy || retry >= busyRetries) throw error;
      await delay(5000 * (retry + 1), undefined, { signal });
    }
  }
}
