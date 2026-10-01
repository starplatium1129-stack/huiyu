import type { Ref } from 'vue'
import { ApiClientError, type ApiClient } from '@/api/client'
import type { AnimaGenerationState, AnimaJobMetadata, AnimaResult, AnimaResultContext } from '@/types/anima'
import { jobPath, type AnimaPublicJob } from './animaSessionContract'
import { fetchResultImage } from './fetchResultImage'

/** Accepted legacy jobs load observation code on demand; the session retains ownership. */
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
