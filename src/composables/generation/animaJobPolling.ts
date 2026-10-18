import type { Ref } from 'vue'
import type { ApiClient } from '@/api/client'
import type { AnimaGenerationState, AnimaResult, AnimaResultContext } from '@/types/anima'
import { animaRequestPayload, type AnimaRequest } from './animaSessionContract'
import { waitForDirectImageJob, fetchResultImage } from '@/api/directImageJobs'
import { acceptDirectImageRequest } from '@/api/directImageRequests'
import { metadataFromJob } from './animaJobMetadata'

/** Direct transport loads before POST; the session retains request and result ownership. */
interface DirectOwner {
  client: ApiClient; family: 'anima' | 'krea2'; signal: AbortSignal
  current(): boolean; state: Readonly<Ref<AnimaGenerationState>>; context: AnimaResultContext | null
  patch(patch: Partial<AnimaGenerationState>): void
  discardStashed(): void; onResult(result: AnimaResult): void
}

export async function runDirectAnima(options: DirectOwner & { request: AnimaRequest; requestKey: string; resume: boolean }): Promise<void> {
  const { client, request, family, signal, current, patch } = options
  if (!current()) return
  const accepted = await acceptDirectImageRequest(family, animaRequestPayload(request), options.requestKey, { client, signal, resume: options.resume })
  if (!current()) return
  patch({ phase: 'running', backendStatus: accepted.status, statusText: '生成中…', progressText: accepted.progressText || (accepted.status === 'queued' ? '正在排队…' : '正在绘制…'), job: metadataFromJob(accepted, request, family) })
  const job = await waitForDirectImageJob(family, accepted.id, signal, {
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
}
