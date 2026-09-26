import { generationApi, type GenerationJobPayload } from '@/api/generationApi'
import { mediaStatusApi } from '@/api/mediaStatusApi'
import { parseSDOptionList, parseSDStatus } from '@/utils/sdStatus'
import { runtimeFetch } from '../runtimeUrl'
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
  accepted(id: string, provider: 'comfy' | 'webui'): void;
  progress(state: { status: string; progress?: number | null; text?: string }): void;
}) {
  const { signal } = options
  const accepted = await generationApi.createJob(input, { signal })
  if (signal.aborted) { void cancelWebGeneration(accepted.job.id).catch(() => {}); signal.throwIfAborted() }
  const provider = accepted.job.provider === 'comfy' ? 'comfy' : 'webui'
  options.accepted(accepted.job.id, provider)
  let job = accepted.job
  const started = Date.now(), deadline = started + 20 * 60 * 1000
  // This threshold changes explanatory copy only. It never invents progress or cancels work.
  const estimated = ((Number(options.steps) || 30) + (options.hires ? (Number(options.hiresSteps) || 0) * 2.25 : 0)) * 2000 + 30000
  while (Date.now() < deadline) {
    signal.throwIfAborted()
    options.progress({ status: job.status === 'succeeded' ? 'running' : job.status })
    if (job.status === 'failed') throw new Error(job.error || '生成失败')
    if (job.status === 'cancelled') throw new DOMException('cancelled', 'AbortError')
    if (job.status === 'succeeded' && job.resultUrl) break
    await new Promise(resolve => setTimeout(resolve, 700)); signal.throwIfAborted()
    const state = await generationApi.getJob(job.id, { signal }); signal.throwIfAborted()
    if (!state.job) throw new Error('生成状态无效')
    job = state.job
    const elapsed = Date.now() - started
    options.progress({ status: job.status === 'succeeded' ? 'running' : job.status,
      progress: job.status === 'succeeded' ? 100 : typeof job.progress === 'number' ? Math.round(job.progress * 100) : null,
      text: (job.progressText || (provider === 'comfy' ? 'ComfyUI 生成中' : 'SD WebUI 生成中'))
        + ` · 已等待 ${Math.max(0, Math.round(elapsed / 1000))}s`
        + (elapsed > Math.max(120000, estimated * 2.5) ? ' · 耗时异常，可检查 ComfyUI 是否卡住，必要时取消后重试' : '') })
  }
  if (job.status !== 'succeeded' || !job.resultUrl) { void cancelWebGeneration(job.id).catch(() => {}); throw new Error('生成超时') }
  const response = await runtimeFetch(job.resultUrl, { cache: 'no-store', signal }); signal.throwIfAborted()
  if (!response.ok || !String(response.headers.get('content-type') || '').startsWith('image/')) throw new Error('生成结果不是图片')
  const blob = await response.blob(); signal.throwIfAborted()
  if (!blob.size) throw new Error('生成结果为空')
  return { blob, seed: job.metadata?.seed ?? job.seed ?? null }
}
