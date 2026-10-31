import { apiClient, ApiClientError } from './client'
import type { ImageTask } from '@/composables/tasks/useImageTaskSession'
import manifest from '../../tools/inference/manga-screen.json'

export const mangaManifest = manifest
export type MangaOperation = Exclude<keyof typeof manifest.operations, 'lineart'>
export type MangaParameters = Record<'levels' | 'finish' | 'panel', Record<string, string | number>>
export interface MangaRewrite { modelId: string; prompt: string; width: number; height: number; seed: number }
export type MangaLinePolarity = 'white-on-black' | 'black-on-white'
export interface MangaRequest { operation: MangaOperation | 'lineart'; initImage: string; levels?: MangaParameters['levels']; finish?: MangaParameters['finish']; panel?: MangaParameters['panel']; rewrite?: MangaRewrite; autoLines?: boolean
  penLines?: string; penLinesPolarity?: MangaLinePolarity; penLinesFit?: 'stretch' | 'exact' }
export interface MangaModelStatus { id: string; available: boolean; unavailableReason: string | null; licenseUrl: string; steps: number }
export interface MangaStatus { available: boolean; unavailableReason: string | null; pending: number
  rewrite: MangaModelStatus[]; lineart: { available: boolean; unavailableReason: string | null }; memoryPolicy: string }
export interface MangaJob {
  task: ImageTask
  id: string; operation: MangaRequest['operation']; status: string; progress: number | null; progressText: string | null
  resultAvailable: boolean; metadata: Record<string, unknown>; error: string | null
  lineart: { width: number; height: number } | null
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const invalid = () => new ApiClientError('漫画处理服务版本不匹配，请更新并重启原生后端', { kind: 'invalid-response' })
export function defaultMangaParameters(): MangaParameters {
  return Object.fromEntries(Object.entries(manifest.parameters).map(([name, fields]) =>
    [name, Object.fromEntries(Object.entries(fields).map(([key, rule]) => [key, rule.default]))])) as MangaParameters
}
export async function mangaStatus(signal?: AbortSignal): Promise<MangaStatus> {
  const value = await apiClient.request<Record<string, unknown>>('/api/manga/status', { signal, timeoutMs: 15_000, cachePolicy: 'bypass' })
  if (value.ok !== true || value.provider !== 'native' || !object(value.processor)
    || value.processor.revision !== manifest.revision || value.processor.schemaVersion !== manifest.schemaVersion || typeof value.available !== 'boolean'
    || !(value.unavailableReason === null || typeof value.unavailableReason === 'string')
    || typeof value.pending !== 'number') throw invalid()
  const capabilities = value.capabilities
  if (!object(capabilities) || !Array.isArray(capabilities.rewrite) || !object(capabilities.lineart)
    || typeof capabilities.lineart.available !== 'boolean' || !['resident', 'offload'].includes(String(capabilities.memoryPolicy))
    || !(capabilities.lineart.unavailableReason === null || typeof capabilities.lineart.unavailableReason === 'string')) throw invalid()
  const rewrite = capabilities.rewrite.map((model: unknown): MangaModelStatus => {
    if (!object(model) || typeof model.id !== 'string' || !manifest.rewrite.models.includes(model.id)
      || typeof model.available !== 'boolean' || !(model.unavailableReason === null || typeof model.unavailableReason === 'string')
      || typeof model.licenseUrl !== 'string' || !model.licenseUrl.startsWith('https://huggingface.co/Qwen/')
      || !object(model.defaults) || typeof model.defaults.steps !== 'number') throw invalid()
    return { id: model.id, available: model.available, unavailableReason: model.unavailableReason, licenseUrl: model.licenseUrl, steps: model.defaults.steps }
  })
  if (rewrite.length !== manifest.rewrite.models.length || new Set(rewrite.map(m => m.id)).size !== rewrite.length) throw invalid()
  return { available: value.available, unavailableReason: value.unavailableReason, pending: value.pending, rewrite,
    lineart: {available: capabilities.lineart.available, unavailableReason: capabilities.lineart.unavailableReason}, memoryPolicy: String(capabilities.memoryPolicy) }
}
export async function uploadMangaImage(blob: Blob, signal: AbortSignal): Promise<string> {
  const value = await apiClient.request<{ ok: boolean; name: string }>('/api/manga/images/raw', {
    method: 'POST', body: blob, signal, headers: { 'Content-Type': 'application/octet-stream' }, timeoutMs: 60_000,
    validate: v => v.ok === true && typeof v.name === 'string' && !!v.name,
  })
  return value.name
}
