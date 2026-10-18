import type { Ref } from 'vue'
import { ApiClientError, type ApiClient } from '@/api/client'
import type { AnimaGenerationState, AnimaPublicJob, AnimaResult, AnimaResultContext } from '@/types/anima'
import { animaRequestPayload, type AnimaRequest } from './animaSessionContract'
import { jobPath, waitForDirectImageJob, fetchResultImage, assertDirectImageRuntime } from '@/api/directImageJobs'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { AcceptedTaskTerminalError } from '@/api/acceptedTaskOutcome'
import { metadataFromJob } from './animaJobMetadata'

/** Direct transport loads before POST; the session retains request and result ownership. */
interface DirectOwner {
  client: ApiClient; family: 'anima' | 'krea2'; signal: AbortSignal
  current(): boolean; state: Readonly<Ref<AnimaGenerationState>>; context: AnimaResultContext | null
  patch(patch: Partial<AnimaGenerationState>): void
  discardStashed(): void; onResult(result: AnimaResult): void
}

export async function runDirectAnima(options: DirectOwner & { request: AnimaRequest }): Promise<void> {
  const { client, request, family, signal, current, patch } = options
  if (!current()) return
  const owner = runtimeResourceIdentity()
  const data = await client.request<{ ok?: boolean; job?: AnimaPublicJob; error?: string }>(jobPath(family), {
    method: 'POST', body: animaRequestPayload(request), signal, timeoutMs: 150_000,
  })
  assertDirectImageRuntime(owner)
  if (data.ok !== true || !data.job?.id) throw new Error(data.error || 'Anima 任务创建失败')
  if (!current()) {
    // Even an aborted POST may have been accepted. Clean up that exact old job,
    // using its captured family, without touching a newer session's state.
    void client.request(jobPath(family, data.job.id), { method: 'DELETE', timeoutMs: 10_000 }).catch(() => {})
    return
  }
  patch({ phase: 'running', backendStatus: data.job.status, statusText: '生成中…', progressText: data.job.progressText || (data.job.status === 'queued' ? '正在排队…' : '正在绘制…'), job: metadataFromJob(data.job, request, family) })
  try {
    const job = await waitForDirectImageJob(family, data.job.id, signal, {
      client, timeoutMs: 10 * 60 * 1000,
      reconnecting: () => { if (current()) patch({ progressText: '连接暂时中断，正在重新读取任务进度…' }) },
      update: job => {
        if (!current()) return
        if (job.metadata) patch({ job: metadataFromJob(job, request, family) })
        patch({ backendStatus: job.status,
          progress: typeof job.progress === 'number' && Number.isFinite(job.progress) ? Math.max(0, Math.min(1, job.progress)) : null,
          elapsedSeconds: typeof job.elapsedSeconds === 'number' ? Math.max(0, job.elapsedSeconds) : options.state.value.elapsedSeconds,
          progressText: job.progressText || (job.status === 'queued' ? '正在排队…' : '正在绘制…'),
          currentNode: typeof job.currentNode === 'string' ? job.currentNode : options.state.value.currentNode,
          ...(job.status === 'cancelling' ? { phase: 'cancelling', statusText: '取消中…' } : {}) })
      },
    })
    const blob = await fetchResultImage(job.resultUrl, signal)
    if (!current()) return
    const facts = metadataFromJob(job, request, family)
    const result: AnimaResult = { url: URL.createObjectURL(blob), blob, metadata: facts }
    if (options.state.value.result) URL.revokeObjectURL(options.state.value.result.url)
    options.discardStashed()
    patch({ result, job: facts, resultContext: options.context, phase: 'succeeded', progress: 1, progressText: '生成完成', currentNode: null, statusText: '生成完成', errorMsg: '', errorReport: null })
    options.onResult(result)
  } catch (error) {
    if (!current()) return
    if (error instanceof AcceptedTaskTerminalError && error.status === 'cancelled') {
      patch({ phase: 'cancelled', statusText: '任务已取消', errorMsg: '' }); return
    }
    if (error instanceof ApiClientError && error.code === 'IMAGE_JOB_OBSERVATION_TIMEOUT') {
      void client.request(jobPath(family, data.job.id), { method: 'DELETE', timeoutMs: 10_000 }).catch(() => {})
      throw new Error('Anima 生成超时，已请求取消上游任务')
    }
    throw error
  }
}

export async function cancelDirectAnima(options: {
  client: ApiClient; id: string; family: 'anima' | 'krea2'; current(): boolean
  patch(patch: Partial<AnimaGenerationState>): void; cancelled(): void
}): Promise<void> {
  const { client, id, family, current, patch, cancelled } = options
  try {
    const data = await client.request<{ job?: AnimaPublicJob }>(jobPath(family, id), { method: 'DELETE', timeoutMs: 15_000 })
    if (!current()) return
    if (data.job?.status === 'cancelled') {
      cancelled()
      patch({ phase: 'cancelled', statusText: '任务已取消' })
    }
  } catch (error) {
    if (current()) patch({ statusText: '取消尚未确认，正在继续查询任务', errorMsg: error instanceof Error ? error.message : '取消请求失败' })
  }
}
