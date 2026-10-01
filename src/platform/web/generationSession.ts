import { ApiClientError } from '@/api/client'
import { generationApi, type GenerationJobEnvelope, type GenerationJobPayload } from '@/api/generationApi'
import { mediaStatusApi } from '@/api/mediaStatusApi'
import { parseSDOptionList, parseSDStatus } from '@/utils/sdStatus'
import { runtimeFetch } from '../runtimeUrl'
import { AcceptedTaskTerminalError } from '@/api/acceptedTaskOutcome'
export interface WebGenerationStatus {
  online: boolean; checkpoint?: string; models?: string[]; samplers?: string[]; schedulers?: string[]; upscalers?: string[]
}
/** The existing Web gateway capability fallback is loaded when status is requested. */
export async function readWebGenerationStatus(): Promise<WebGenerationStatus> {
  const generation = await generationApi.getStatus().catch(() => null)
  if (generation) return { online: generation.online === true, checkpoint: generation.checkpoint || '',
    models: generation.checkpoint ? [generation.checkpoint] : [], samplers: generation.samplers || [], schedulers: generation.schedulers || [], upscalers: generation.capabilities?.hiresUpscalers || [] }
  let previous: WebGenerationStatus = { online: false }
  try { const value = parseSDStatus(await mediaStatusApi.getSDStatus()); previous = value; if (value.online) return value } catch {}
  try {
    const [models, samplers, schedulers] = await Promise.all([
      runtimeFetch('/sdapi/v1/sd-models', { cache: 'no-store' }),
      runtimeFetch('/sdapi/v1/samplers', { cache: 'no-store' }).catch(() => null),
      runtimeFetch('/sdapi/v1/schedulers', { cache: 'no-store' }).catch(() => null),
    ])
    if (!models.ok) return { ...previous, online: false }
    return { ...previous, online: true, models: parseSDOptionList(await models.json(), ['title', 'model_name', 'name']),
      ...(samplers?.ok ? { samplers: parseSDOptionList(await samplers.json()) } : {}),
      ...(schedulers?.ok ? { schedulers: parseSDOptionList(await schedulers.json(), ['name', 'label']) } : {}) }
  } catch { return { ...previous, online: false } }
}
export function cancelWebGeneration(id: string) { return generationApi.deleteJob(id) }
/** Owns the Web request lifecycle; desktop durable jobs use a different execution owner. */
export async function runWebGeneration(input: GenerationJobPayload, options: {
  signal: AbortSignal; steps?: number; hires?: boolean; hiresSteps?: number;
  resumeId?: string; onSubmitting?: () => void; preserveAccepted?: boolean;
  accepted(id: string, provider: 'comfy' | 'webui'): void | Promise<void>;
  progress(state: { status: string; progress?: number | null; text?: string }): void;
}) {
  const { signal } = options
  signal.throwIfAborted()
  let accepted
  if (options.resumeId) accepted = await generationApi.getJob(options.resumeId, { signal })
  else { options.onSubmitting?.(); signal.throwIfAborted(); accepted = await generationApi.createJob(input, { signal }) }
  if (options.resumeId && accepted.job.id !== options.resumeId) throw new Error('原任务编号与响应不一致，请核对原任务。')
  if (signal.aborted) { if (!options.preserveAccepted) void cancelWebGeneration(accepted.job.id).catch(() => {}); signal.throwIfAborted() }
  const provider = accepted.job.provider === 'comfy' ? 'comfy' : 'webui'
  await options.accepted(accepted.job.id, provider)
  let job = accepted.job
  const started = Date.now(), deadline = started + 20 * 60 * 1000
  // This threshold changes explanatory copy only. It never invents progress or cancels work.
  const estimated = ((Number(options.steps) || 30) + (options.hires ? (Number(options.hiresSteps) || 0) * 2.25 : 0)) * 2000 + 30000
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    options.progress({ status: job.status === 'succeeded' ? 'running' : job.status })
    if (job.status === 'failed') throw new AcceptedTaskTerminalError(job.id, 'failed', job.error || '生成失败')
    if (job.status === 'cancelled') throw new AcceptedTaskTerminalError(job.id, 'cancelled', '任务已取消')
    if (job.status === 'succeeded' && job.resultUrl) break
    await new Promise(resolve => setTimeout(resolve, 700)); signal.throwIfAborted()
    let state: GenerationJobEnvelope
    try { state = await generationApi.getJob(job.id, { signal }) }
    catch (error) {
      signal.throwIfAborted()
      // Acceptance already owns a job. Retry its read, never its submission;
      // a transient disconnect must not expose a new-generation retry as failure.
      if (error instanceof ApiClientError && (error.kind === 'network' || error.kind === 'timeout'
        || error.kind === 'http' && error.status >= 500)) {
        options.progress({ status: job.status, progress: null, text: '连接暂时中断，正在重新读取原任务状态…' })
        continue
      }
      throw error
    }
    signal.throwIfAborted()
    if (!state.job) throw new Error('生成状态无效')
    if (state.job.id !== accepted.job.id) throw new Error('原任务编号与响应不一致，请核对原任务。')
    job = state.job
    const elapsed = Date.now() - started
    options.progress({ status: job.status === 'succeeded' ? 'running' : job.status,
      progress: job.status === 'succeeded' ? 100 : typeof job.progress === 'number' ? Math.round(job.progress * 100) : null,
      text: (job.progressText || (provider === 'comfy' ? 'ComfyUI 生成中' : 'SD WebUI 生成中'))
        + ` · 已等待 ${Math.max(0, Math.round(elapsed / 1000))}s`
        + (elapsed > Math.max(120000, estimated * 2.5) ? ' · 耗时异常，可检查 ComfyUI 是否卡住，必要时取消后重试' : '') })
  }
  if (job.status !== 'succeeded' || !job.resultUrl) { if (!options.preserveAccepted) void cancelWebGeneration(job.id).catch(() => {}); throw new Error('生成超时') }
  const response = await runtimeFetch(job.resultUrl, { cache: 'no-store', signal }); signal.throwIfAborted()
  if (!response.ok || !String(response.headers.get('content-type') || '').startsWith('image/')) throw new Error('生成结果不是图片')
  const blob = await response.blob(); signal.throwIfAborted()
  if (!blob.size) throw new Error('生成结果为空')
  return { blob, seed: job.metadata?.seed ?? job.seed ?? null }
}
