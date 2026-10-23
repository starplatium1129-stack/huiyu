import type { TaskRecord } from '../../../types/tasks'
import type { ArtworkRecord } from '@/types/artwork'
import { taskArtworkId } from './taskResultIdentity'

export function qwenTaskArtwork(task: TaskRecord, index: number): ArtworkRecord {
  const output = task.resultRefs.find(value => value.index === index)
  const input = { ...task.input, ...task.metadata }
  const moss = task.kind === 'moss'
  if ((!moss && task.kind !== 'qwen') || task.provider !== 'native' || task.resultState !== 'available' || output?.mime !== 'image/png'
    || input.family !== (moss ? 'moss-image' : 'qwen-image')
    || !(moss ? ['moss-miaomiao-base-v1.0'] : ['qwen-image-2.1', 'qwen-image-2.1-turbo']).includes(String(input.modelId))) throw new Error('图像结果信息不完整，请在任务中心核对')
  const context = task.metadata.context as Record<string, unknown> | undefined
  const parent = context?.parentId
  if (parent !== undefined && parent !== null && !(typeof parent === 'string' && parent.length > 0 && parent.length <= 240
    || typeof parent === 'number' && Number.isSafeInteger(parent) && parent >= 0)) throw new Error('Qwen 来源作品身份无效')
  const record: ArtworkRecord = {
    id: taskArtworkId(task.taskId, index), timestamp: task.createdAt, engine: moss ? 'moss-image' : 'qwen-image', provider: 'native',
    taskId: task.taskId, outputIndex: index, image_id: output.alias, image_url: '',
    sceneTitle: moss ? 'MiaoMiao MOSS 图像创作' : Array.isArray(input.referenceImages) && input.referenceImages.length ? 'Qwen 多图编辑' : input.initImage ? 'Qwen 指令编辑' : 'Qwen 图像创作', checkpoint: String(input.modelId),
    parent_id: parent ?? null, favorite: false, rating: {}, version: 1, validation: '待主力机验证',
  }
  for (const key of ['prompt', 'negative', 'sampler', 'scheduler']) if (typeof input[key] === 'string') record[key] = input[key]
  for (const key of ['seed', 'steps', 'cfg', 'width', 'height']) if (typeof input[key] === 'number' && Number.isFinite(input[key])) record[key] = input[key]
  if (moss) record.mossAcceleration = input.mossAcceleration === 'spectrum' ? 'spectrum' : 'off'
  if (record.width && record.height) record.size = `${record.width}x${record.height}`
  return record
}
