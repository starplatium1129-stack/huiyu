import { fetchRuntimeResult, runtimeResultPath, taskMessage, type TaskRecord } from './runtimeTasks'
import { mangaManifest, type MangaJob, type MangaRequest } from './mangaApi'

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** The panel is a view of the durable task, including after a reconnect. */
export function mangaTaskView(task: TaskRecord): MangaJob {
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
    metadata:structuredClone(source), lineart, resultAvailable:task.resultState === 'available',
    progress:typeof source.progress === 'number' && Number.isFinite(source.progress) ? Math.max(0, Math.min(1, source.progress)) : null,
    progressText:typeof source.progressText === 'string' && task.recoveryState === 'normal' ? source.progressText : taskMessage(task),
    error:task.status === 'failed' || task.recoveryState !== 'normal' ? taskMessage(task) : null}
}
export const mangaLineIndex = (job: MangaJob) => job.operation === 'lineart' ? 0 : 1
export async function fetchMangaTaskResult(job: MangaJob, signal: AbortSignal, kind: 'result' | 'lineart' = 'result'): Promise<Blob> {
  const index = kind === 'lineart' ? mangaLineIndex(job) : 0
  const output = job.task.resultRefs.find(value => value.index === index)
  if (!output || output.mime !== 'image/png') throw new Error('任务中尚无这张 PNG，请在任务中心核对结果')
  const blob = await fetchRuntimeResult(runtimeResultPath(job.task, index), signal, job.task)
  if (!blob.size || blob.type.split(';')[0] !== 'image/png') throw new Error('漫画结果格式无效')
  return blob
}
