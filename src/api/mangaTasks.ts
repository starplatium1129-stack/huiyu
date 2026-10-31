import { mangaManifest, type MangaJob, type MangaRequest } from './mangaApi'
import { fetchImageTaskResult, type ImageTask } from '@/composables/tasks/useImageTaskSession'

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** The panel is a view of the durable task, including after a reconnect. */
export function mangaTaskView(task: ImageTask): MangaJob {
  const source = {...task.input, ...task.metadata}, operation = source.operation
  if (!['manga', 'lineart'].includes(task.kind) || task.provider !== 'native'
    || source.family !== 'manga-screen' || typeof operation !== 'string' || !Object.hasOwn(mangaManifest.operations, operation)
    || (task.kind === 'lineart') !== (operation === 'lineart')) throw new Error('漫画任务格式无效，请更新原生后端')
  const line = source.lineartResult
  let lineart: MangaJob['lineart'] = null
  if (line !== undefined) {
    if (!object(line) || line.polarity !== 'black-on-white' || line.stage !== (operation === 'lineart' ? 'extracted' : 'before-panel')
      || typeof line.width !== 'number' || typeof line.height !== 'number'
      || ![line.width, line.height].every(v => Number.isInteger(v) && v >= 128 && v <= 4096)
      || line.width * line.height > mangaManifest.maxInputPixels) throw new Error('任务线稿信息不完整，请在任务中心核对')
    lineart = {width:line.width, height:line.height}
  }
  return {task:structuredClone(task), id:task.taskId, operation:operation as MangaRequest['operation'], status:task.status,
    metadata:structuredClone(source), lineart, resultAvailable:task.resultAvailable,
    progress:typeof source.progress === 'number' && Number.isFinite(source.progress) ? Math.max(0, Math.min(1, source.progress)) : null,
    progressText:typeof source.progressText === 'string' ? source.progressText : null,
    error:task.status === 'failed' || task.recoveryState !== 'normal' ? String(source.error || '任务状态待核对') : null}
}
export const mangaLineIndex = (job: MangaJob) => job.operation === 'lineart' ? 0 : 1
export async function fetchMangaTaskResult(job: MangaJob, signal: AbortSignal, kind: 'result' | 'lineart' = 'result'): Promise<Blob> {
  const index = kind === 'lineart' ? mangaLineIndex(job) : 0
  const blob = await fetchImageTaskResult(job.task, signal, index)
  if (!blob.size || blob.type.split(';')[0] !== 'image/png') throw new Error('漫画结果格式无效')
  return blob
}
