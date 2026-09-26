import { apiClient, ApiClientError } from '@/api/client'
import { runtimeFetch } from '@/platform/runtimeUrl'
import { hasRuntimeTasks, runtimeRequestKey } from '../../api/runtimeTaskAuthority'
import type { TaskRecord } from '../../../types/tasks'
import { animaRequestPayload, type AnimaPublicJob, type AnimaRequest } from '@/composables/generation/useAnimaSession'

/** Transport only: the caller has already frozen and compiled the exact engine input. */
export function createBatchAnimaTransport(family: () => string) {
  let observer: AbortController | null = null
  let disposed = false
  const accepted = new Map<string, TaskRecord>()
  async function run(request: AnimaRequest, context: Record<string, unknown>, cancelled: () => boolean,
    report?: (message: string) => void): Promise<{ blob: Blob; seed?: number; taskId?: string }> {
    if (disposed) throw new DOMException('工作台已关闭', 'AbortError')
    const payload = animaRequestPayload(request)
    if (hasRuntimeTasks()) {
      observer = new AbortController()
      const signal = observer.signal, kind = family() === 'krea2' ? 'creative' : 'anima'
      const { submitRuntimeTask, waitForRuntimeTask, fetchRuntimeResult, runtimeResultPath, taskMessage } = await import('../../api/runtimeTasks')
      signal.throwIfAborted()
      const signature = JSON.stringify({ kind, payload, context })
      const previous = accepted.get(signature)
      const task = previous || await submitRuntimeTask(kind, payload, runtimeRequestKey(kind, payload), context)
      accepted.set(signature, task)
      signal.throwIfAborted()
      try {
        const done = await waitForRuntimeTask(task.taskId, signal, value => {
          accepted.set(signature, value); report?.(taskMessage(value))
        })
        const blob = await fetchRuntimeResult(runtimeResultPath(done), signal)
        accepted.delete(signature)
        const seed = Number(done.metadata.seed ?? done.input.seed)
        return { blob, seed: Number.isFinite(seed) ? seed : undefined, taskId: done.taskId }
      } catch (error) {
        // Retry an unknown accepted task by identity; do not create another one.
        if (accepted.get(signature)?.upstreamSettled && accepted.get(signature)?.status !== 'succeeded') accepted.delete(signature)
        throw error
      } finally { observer = null }
    }
    const route = family() === 'krea2' ? '/api/creative/jobs' : '/api/anima/jobs'
    let data: { ok?: boolean; job?: AnimaPublicJob; error?: string } | undefined
    const admissionDeadline = Date.now() + 120_000
    while (!data && Date.now() < admissionDeadline) {
      if (cancelled()) throw new DOMException('批量已停止', 'AbortError')
      try { data = await apiClient.request(route, { method: 'POST', body: payload, timeoutMs: 30_000 }) }
      catch (error) {
        if (!(error instanceof ApiClientError) || error.status !== 429) throw error
        report?.('队列暂满，等待空位…可点停止结束等待')
        await new Promise(resolve => setTimeout(resolve, 5000))
      }
    }
    if (!data) throw new Error('队列持续繁忙，请稍后重试本项')
    if (data.ok !== true || !data.job?.id) throw new Error(data.error || 'Anima 任务创建失败')
    const jobId = data.job.id, deadline = Date.now() + 10 * 60 * 1000
    let job = data.job
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      const state = await apiClient.request<{ ok?: boolean; job?: AnimaPublicJob; error?: string }>(`${route}/${encodeURIComponent(jobId)}`,
        { cache: 'no-store', timeoutMs: 15_000 }).catch(error => {
        if (error instanceof ApiClientError && ['network', 'timeout'].includes(error.kind)) return null
        throw error
      })
      if (!state) { report?.('连接暂时中断，正在重连同一任务…'); continue }
      if (state.ok !== true || !state.job) throw new Error(state.error || 'Anima 状态无效')
      job = state.job; report?.(job.status === 'queued' ? '已接收，等待生成…' : '正在生成…')
      if (job.status === 'failed') throw new Error(job.error || 'Anima 生成失败')
      if (job.status === 'cancelled') throw new DOMException('任务已取消', 'AbortError')
      if (job.status === 'succeeded' && job.resultAvailable && job.resultUrl) break
    }
    if (job.status !== 'succeeded' || !job.resultUrl) {
      await apiClient.request(`${route}/${encodeURIComponent(jobId)}`, { method: 'DELETE', timeoutMs: 15_000 }).catch(() => undefined)
      throw new Error('Anima 等待超时，已尝试停止该任务；请核对任务状态后重试')
    }
    const response = await runtimeFetch(job.resultUrl, { cache: 'no-store' })
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new Error('网关返回的结果不是图片')
    const blob = await response.blob()
    if (!blob.size) throw new Error('生成结果为空')
    return { blob, seed: job.seed }
  }
  return { run, dispose() { disposed = true; observer?.abort() } }
}
