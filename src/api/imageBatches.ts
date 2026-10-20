import { apiClient } from './client'
import { getDesktopRuntime } from '@/platform/desktop/runtime'
import { animaRequestPayload } from '@/composables/generation/animaSessionContract'
import { readPreparedBatch } from '@/composables/prompt/batchGenerationPlan'
import type { BatchDrawPlan } from '@/composables/generation/batchDrawPlan'

export type RuntimeImageBatch = BatchDrawPlan & { id: string; state: 'running' | 'paused' | 'failed' | 'succeeded'; revision: number; error?: string }
export async function imageBatchRequest(id: string, action?: 'create' | 'pause' | 'resume' | 'retry', plan?: BatchDrawPlan, signal?: AbortSignal): Promise<RuntimeImageBatch | null> {
  const epoch = getDesktopRuntime().bootstrap?.runtime?.workspace?.runtimeEpoch
  if (!epoch) throw new Error('私人工作区尚未连接')
  const body = action === 'create' && plan ? { ...plan, jobs: plan.jobs.map(job => {
    const prepared = readPreparedBatch(job.snapshot)
    if (!prepared || prepared.engine === 'sd' || job.status !== 'pending') throw new Error('批次中有不可执行的配方，请调整后重新开始')
    return { ...job, taskInput: animaRequestPayload(prepared.request) }
  }) } : undefined
  const reply = await apiClient.request<{ result: RuntimeImageBatch | null; runtimeEpoch: string }>(
    `/api/tasks/v1/image-batches/${encodeURIComponent(id)}${action && action !== 'create' ? `/${action}` : ''}`,
    { method: action ? 'POST' : 'GET', body, signal, timeoutMs: 30_000, cachePolicy: 'bypass' })
  if (epoch !== reply.runtimeEpoch || epoch !== getDesktopRuntime().bootstrap?.runtime?.workspace?.runtimeEpoch) throw new Error('批次工作区已变化，请回到原连接')
  if (reply.result && (reply.result.id !== id || !Array.isArray(reply.result.jobs) || !['running','paused','failed','succeeded'].includes(reply.result.state))) throw new Error('批次回执无效，请核对原批次')
  return reply.result
}
