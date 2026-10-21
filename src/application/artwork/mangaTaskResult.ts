import type { TaskRecord } from '../../../types/tasks'
import type { ArtworkRecord } from '@/types/artwork'
import { taskArtworkId } from './taskResultIdentity'

/** Freeze only source attribution; do not inherit the source's diffusion recipe. */
export function mangaTaskContext(source?: ArtworkRecord): Record<string, unknown> {
  if (!source) return {}
  const fields = ['id', 'sceneTitle', 'character', 'characterId', 'subject', 'outfitId', 'blueprintId', 'project'] as const
  return {mangaSource:Object.fromEntries(fields.filter(key => source[key] !== undefined).map(key => [key, structuredClone(source[key])]))}
}
export function mangaTaskArtwork(task: TaskRecord, index: number): ArtworkRecord {
  const output = task.resultRefs.find(value => value.index === index)
  const lineart = task.kind === 'lineart' || index === 1
  const metadata = {...task.input, ...task.metadata}
  const dimensions = lineart ? metadata.lineartResult as Record<string, unknown> | undefined : metadata
  const width = dimensions?.width, height = dimensions?.height
  if (!output || ![0, 1].includes(index) || task.kind === 'lineart' && index !== 0
    || typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
    throw new Error('漫画结果尺寸或编号缺失，请在任务中心核对')
  const context = task.metadata.context as {mangaSource?: Partial<ArtworkRecord>} | undefined
  const source = context?.mangaSource
  delete metadata.context
  return {
    id:taskArtworkId(task.taskId, index), taskId:task.taskId, outputIndex:index, timestamp:task.createdAt,
    image_id:output.alias, image_url:'', engine:'manga-screen', provider:'native', artifactKind:lineart ? 'lineart' : 'manga',
    sceneTitle:`${typeof source?.sceneTitle === 'string' ? source.sceneTitle : '图片'} · ${lineart ? '线稿' : '漫画版'}`,
    parent_id:typeof source?.id === 'string' || typeof source?.id === 'number' && Number.isFinite(source.id) ? source.id : null, character:typeof source?.character === 'string' ? source.character : '',
    characterId:source?.characterId, subject:source?.subject, outfitId:source?.outfitId, blueprintId:source?.blueprintId,
    project:typeof source?.project === 'string' ? source.project : '', width, height, size:`${width} × ${height}`,
    favorite:false, version:1, prompt:'', manual_tags:[lineart ? '线稿' : '漫画'],
    postprocess:structuredClone(metadata), validation:'待主力机验证',
  }
}
