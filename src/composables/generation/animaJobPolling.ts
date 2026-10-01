import type { Ref } from 'vue'
import { ApiClientError, type ApiClient } from '@/api/client'
import type { AnimaGenerationState, AnimaJobMetadata, AnimaResult, AnimaResultContext } from '@/types/anima'
import { jobPath, animaRequestPayload, type AnimaRequest, type AnimaPublicJob } from './animaSessionContract'
import { fetchResultImage } from './fetchResultImage'

/** Direct transport loads before POST; the session retains request and result ownership. */
interface DirectOwner {
  client: ApiClient; family: 'anima' | 'krea2'; signal: AbortSignal
  current(): boolean; state: Readonly<Ref<AnimaGenerationState>>; context: AnimaResultContext | null
  patch(patch: Partial<AnimaGenerationState>): void
  discardStashed(): void; onResult(result: AnimaResult): void
}

function metadataFromJob(job: AnimaPublicJob, request: AnimaRequest, family: 'anima' | 'krea2'): AnimaJobMetadata {
  const supplied = job.metadata
  if (supplied && supplied.id !== job.id) throw new Error('成片元数据与当前任务编号不一致，请核对任务')
  const metadata = supplied
    ? supplied
    : {
        engine: family,
        id: job.id,
        prompt: request.prompt,
        negative: request.negative,
        profileId: request.profileId,
        modelId: request.modelId,
        loraId: request.loraId,
        loraStrength: request.loraStrength,
        styleLoraId: request.styleLoraId ?? null,
        width: request.width,
        height: request.height,
        steps: request.steps,
        cfg: request.cfg,
        sampler: '',
        scheduler: '',
        seed: job.seed,
        character: request.character,
        preview: false,
        hiresFix: Boolean(request.hiresFix),
        hiresScale: request.hiresScale,
        hiresDenoise: request.hiresDenoise,
        createdAt: Date.now(),
        resultUrl: job.resultUrl,
      }
  return Object.freeze({ ...JSON.parse(JSON.stringify(metadata)), resultUrl: job.resultUrl || metadata.resultUrl || null }) as AnimaJobMetadata
}

export async function runDirectAnima(options: DirectOwner & { request: AnimaRequest }): Promise<void> {
  const { client, request, family, signal, current, patch } = options
  if (!current()) return
  const data = await client.request<{ ok?: boolean; job?: AnimaPublicJob; error?: string }>(jobPath(family), {
    method: 'POST', body: animaRequestPayload(request), signal, timeoutMs: 30_000,
  })
  if (data.ok !== true || !data.job?.id) throw new Error(data.error || 'Anima 任务创建失败')
  if (!current()) {
    // Even an aborted POST may have been accepted. Clean up that exact old job,
    // using its captured family, without touching a newer session's state.
    void client.request(jobPath(family, data.job.id), { method: 'DELETE', timeoutMs: 10_000 }).catch(() => {})
    return
  }
  patch({ phase: 'running', backendStatus: data.job.status, statusText: '生成中…', job: metadataFromJob(data.job, request, family) })
  await pollAnimaJob({ ...options, id: data.job.id, deadline: Date.now() + 10 * 60 * 1000,
    metadata: job => metadataFromJob(job, request, family) })
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

/** Observe the accepted job without a second chunk-loading gap. */
export async function pollAnimaJob(options: {
  client: ApiClient; id: string; family: 'anima' | 'krea2'; signal: AbortSignal; deadline: number
  current(): boolean; state: Readonly<Ref<AnimaGenerationState>>; context: AnimaResultContext | null
  patch(patch: Partial<AnimaGenerationState>): void
  metadata(job: AnimaPublicJob): AnimaJobMetadata
  discardStashed(): void; onResult(result: AnimaResult): void
}): Promise<void> {
  const { client, id, family, signal, current, state, context, patch, metadata, discardStashed, onResult, deadline } = options
  while (Date.now() < deadline && current()) {
    await new Promise(resolve => setTimeout(resolve, 1000))
    if (!current()) return
    let data: { ok?: boolean; job?: AnimaPublicJob; error?: string }
    try {
      data = await client.request<{ ok?: boolean; job?: AnimaPublicJob; error?: string }>(jobPath(family, id), {
        cache: 'no-store', signal, timeoutMs: 15_000,
      })
    } catch (error) {
      if (!current()) return
      if (error instanceof ApiClientError && (error.kind === 'network' || error.kind === 'timeout' || (error.kind === 'http' && error.status >= 500))) {
        patch({ progressText: '连接暂时中断，正在重新读取任务进度…' })
        continue
      }
      throw error
    }
    if (!current()) return
    const job = data.job
    if (data.ok !== true || !job) throw new Error(data.error || 'Anima 状态无效')
    if (job.id !== id) throw new Error('成片响应与当前任务编号不一致，请核对任务')
    if (job.metadata) patch({ job: metadata(job) })
    patch({
      backendStatus: job.status,
      progress: typeof job.progress === 'number' ? Math.max(0, Math.min(1, job.progress)) : null,
      elapsedSeconds: typeof job.elapsedSeconds === 'number' ? Math.max(0, job.elapsedSeconds) : state.value.elapsedSeconds,
      progressText: typeof job.progressText === 'string' ? job.progressText : state.value.progressText,
      currentNode: typeof job.currentNode === 'string' ? job.currentNode : state.value.currentNode,
    })
    if (job.status === 'cancelling') { patch({ phase: 'cancelling', statusText: '取消中…' }); continue }
    if (job.status === 'cancelled') { patch({ phase: 'cancelled', statusText: '任务已取消', errorMsg: '' }); return }
    if (job.status === 'failed') throw new Error(job.error || 'Anima 生成失败')
    if (job.status !== 'succeeded' || !job.resultAvailable || !job.resultUrl) continue
    const blob = await fetchResultImage(job.resultUrl, signal)
    if (!current()) return
    const facts = metadata(job)
    const result: AnimaResult = { url: URL.createObjectURL(blob), blob, metadata: facts }
    const previous = state.value.result
    if (previous && previous.url !== result.url) URL.revokeObjectURL(previous.url)
    discardStashed()
    patch({ result, job: facts, resultContext: context, phase: 'succeeded', progress: 1, progressText: '生成完成', currentNode: null, statusText: '生成完成', errorMsg: '', errorReport: null })
    onResult(result)
    return
  }
  if (current()) {
    void client.request(jobPath(family, id), { method: 'DELETE', timeoutMs: 10_000 }).catch(() => {})
    throw new Error('Anima 生成超时，已请求取消上游任务')
  }
}
