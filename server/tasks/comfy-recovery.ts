import type { ComfyConfig } from '../comfy-types';
import comfy = require('../comfy-client');
import type { TaskRecord } from '../../types/tasks';
import type { TaskObservation, TaskOutput } from './provider';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const cancellationAcks = new Map<string, number>();
const cancellationKey = (config: ComfyConfig, task: TaskRecord) => `${String(config.COMFY_HOST)}:${task.upstreamId}`;
function has(items: unknown, id: string): boolean {
  return Array.isArray(items) && items.some(item => Array.isArray(item) ? item[1] === id : record(item).prompt_id === id);
}
export async function queryComfy(config: ComfyConfig, task: TaskRecord, outputNode: string,
  materialize: (reference: unknown) => Promise<TaskOutput>): Promise<TaskObservation> {
  if (!task.upstreamId) return { status: task.status, settled: false, unknown: true, errorCode: 'UPSTREAM_ID_UNKNOWN' };
  const history = await comfy.requestComfyJson<Record<string, unknown>>(config, 'GET', '/history/' + encodeURIComponent(task.upstreamId), null, 10000);
  const entry = record(history?.[task.upstreamId]); const state = record(entry.status).status_str;
  if (state === 'error' || state === 'failed') return { status: 'failed', settled: true, errorCode: 'COMFY_EXECUTION_FAILED' };
  if (state === 'success') {
    if (task.resultState === 'available') return { status: 'succeeded', settled: true };
    const output = record(record(entry.outputs)[outputNode]); const list = output.images || output.videos;
    if (!Array.isArray(list) || !list.length) return { status: 'succeeded', settled: true, errorCode: 'RESULT_UNAVAILABLE' };
    return { status: 'succeeded', settled: true, outputs: [await materialize(list[0])] };
  }
  const queue = await comfy.requestComfyJson<Record<string, unknown>>(config, 'GET', '/queue', null, 10000);
  if (has(queue?.queue_running || queue?.running, task.upstreamId) || has(queue?.queue_pending || queue?.pending, task.upstreamId))
    return { status: task.cancelRequestedAt ? 'cancelling' : 'running', settled: false };
  const key = cancellationKey(config, task);
  if (task.cancelRequestedAt && cancellationAcks.has(key)) {
    const observations = (cancellationAcks.get(key) || 0) + 1;
    cancellationAcks.set(key, observations);
    if (observations >= 2) { cancellationAcks.delete(key); return { status: 'cancelled', settled: true }; }
    return { status: 'cancelling', settled: false };
  }
  // A truncated/replaced history cannot prove a missing prompt never ran or settled.
  return { status: task.status, settled: false, unknown: true, errorCode: 'COMFY_HISTORY_MISSING' };
}
export async function cancelComfy(config: ComfyConfig, task: TaskRecord): Promise<void> {
  if (!task.upstreamId) return;
  const key = cancellationKey(config, task);
  if (cancellationAcks.has(key)) return;
  try { await comfy.requestComfyJson(config, 'POST', '/api/jobs/' + encodeURIComponent(task.upstreamId) + '/cancel', null, 10000); cancellationAcks.set(key, 0); }
  catch (error) {
    const detail = record(record(error).detail); const status = Number(detail.upstreamStatus);
    if (status !== 404 && status !== 405) throw error;
    const queue = await comfy.requestComfyJson<Record<string, unknown>>(config, 'GET', '/queue', null, 10000);
    if (has(queue?.queue_pending || queue?.pending, task.upstreamId)) {
      await comfy.requestComfyJson(config, 'POST', '/queue', { delete: [task.upstreamId] }, 10000);
      cancellationAcks.set(key, 0);
    }
    // Never use global interrupt to guess at a running or unknown recovered job.
  }
}
