import type { ArtworkRepository } from './artworkRepository'
import type { TaskRecord } from '../../../types/tasks'
import type { ArtworkRecord } from '@/types/artwork'
import type { HistoryEntry } from '@/types/promptHistory'
import { taskResultHistory } from './taskResultHistory'

/** Task outputs already live in the workspace; save adds an artwork reference. */
export async function saveTaskResult(task: TaskRecord, index: number, deps: { repository: ArtworkRepository; markSaved(id: string): Promise<unknown> }): Promise<HistoryEntry & ArtworkRecord> {
  const artworkRepository = deps.repository
  const output = task.resultRefs.find(value => value.index === index)
  if (!output?.mime.startsWith('image/')) throw new Error('请选择图片结果入册')
  const context = task.metadata.context && typeof task.metadata.context === 'object' ? task.metadata.context as Record<string, unknown> : {}
  const history = context.history && typeof context.history === 'object' ? context.history as Record<string, unknown> : {}
  const id = `task-${task.taskId}-${index}`
  const existing = (await artworkRepository.readHistory()).find(value => String(value.id) === id)
  let saved = existing
  if (!existing) {
    const input = task.input
    const record: ArtworkRecord = {
      scene: typeof context.sceneId === 'string' ? context.sceneId : null, sceneTitle: null, emotion: [], shot: null, lighting: null,
      composition: null, colorMood: null, manual_tags: [], lora: typeof input.loraId === 'string' ? input.loraId : null, notes: '',
      parent_id: context.parentId ?? null, project: '', image_url: '',
      ...input, ...history, id, timestamp: task.createdAt, image_id: output.alias,
      engine: task.kind === 'generation' ? 'sd' : task.kind === 'creative' ? 'krea2' : task.kind,
      prompt: String(input.prompt || ''), negative: String(input.negative || ''),
      seed: Number(task.metadata.seed ?? input.seed) || 0,
      character: String(context.char || input.character || history.character || ''),
      characterId: typeof context.characterId === 'string' ? context.characterId : undefined,
      outfitId: typeof context.outfitId === 'string' ? context.outfitId : undefined,
      blueprintId: typeof context.blueprintId === 'string' ? context.blueprintId : undefined,
      story: String(context.story || history.story || ''), checkpoint: String(input.modelId || ''), model: String(input.modelId || ''),
      size: `${input.width || ''}x${input.height || ''}`, subject: context.characterId ? 'popular' : 'studio',
      favorite: false, rating: {}, version: 1, taskId: task.taskId, outputIndex: index,
    }
    saved = taskResultHistory(record)
    await artworkRepository.appendArtwork(saved)
  }
  await deps.markSaved(task.taskId)
  return taskResultHistory(saved!)
}
