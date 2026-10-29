import { invokeHost, hostApi } from './hostApi'

export interface OfflinePreview {
  releaseId: string; packageMode: 'full' | 'delta'; baseReleaseId?: string
  files: number; bytes: number; runtimeRoot: string; trustedSource: string
  sourceType?: 'directory'; directoryRoot?: string
}
export interface OfflineInstallState {
  stage: 'idle' | 'checking' | 'ready' | 'preparing' | 'installing' | 'completed' | 'cancelled' | 'failed'
  phase: string; done: number; total: number; busy: boolean; paused: boolean
  drainFailed: boolean; cancelRequested: boolean; canResume: boolean
  fileName?: string; error: string | null; startedAt?: number
  preview: OfflinePreview | null
  result: { releaseId: string; directoryRoot?: string; catalog?: { included: boolean; changed?: number; preservedNewer?: boolean } } | null
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
export function hasResourceAssistant() { return !!hostApi() }
export function openResourceAssistant() { return invokeHost<void>('open_resource_assistant') }
export async function readResourceAssistant(): Promise<OfflineInstallState> {
  const value = await invokeHost<unknown>('resource_assistant_status')
  if (!object(value) || !['idle', 'checking', 'ready', 'preparing', 'installing', 'completed', 'cancelled', 'failed'].includes(String(value.stage))
    || !['busy', 'paused', 'drainFailed', 'cancelRequested', 'canResume'].every(key => typeof value[key] === 'boolean')
    || typeof value.phase !== 'string' || !count(value.done) || !count(value.total)
    || !(value.error === null || typeof value.error === 'string')) throw new Error('安装状态暂时无法读取，请重新检查。')
  if (value.preview !== null && (!object(value.preview) || typeof value.preview.releaseId !== 'string'
    || !['full', 'delta'].includes(String(value.preview.packageMode)) || !count(value.preview.files) || !count(value.preview.bytes)
    || typeof value.preview.runtimeRoot !== 'string' || typeof value.preview.trustedSource !== 'string'
    || !(value.preview.sourceType === undefined || value.preview.sourceType === 'directory')
    || !(value.preview.directoryRoot === undefined || typeof value.preview.directoryRoot === 'string'))) throw new Error('资源包信息不完整，请重新选择。')
  if (value.result !== null && (!object(value.result) || typeof value.result.releaseId !== 'string'
    || !(value.result.directoryRoot === undefined || typeof value.result.directoryRoot === 'string'))) throw new Error('安装结果尚未确认。')
  return value as unknown as OfflineInstallState
}
export const pickResourceArchive = (directory = false) => invokeHost<void>('resource_assistant_pick', { directory })
export const installResourceArchive = () => invokeHost<void>('resource_assistant_install')
export const cancelResourceInstall = () => invokeHost<void>('resource_assistant_cancel')
export const finishResourceInstall = () => invokeHost<void>('resource_assistant_finish')
