import type { ArtworkRepository } from './artworkRepository'
import type { TaskRecord } from '../../../types/tasks'
import type { ArtworkRecord } from '@/types/artwork'
import { runtimeTaskResultContext, runtimeTaskRecipe } from '@/utils/runtimeTaskResult'

/** Task outputs already live in the workspace; save adds an artwork reference. */
export async function saveTaskResult(task: TaskRecord, index: number, deps: { repository: ArtworkRepository; markSaved(id: string): Promise<unknown> }): Promise<ArtworkRecord> {
  const artworkRepository = deps.repository
  const output = task.resultRefs.find(value => value.index === index)
  if (!output?.mime.startsWith('image/')) throw new Error('请选择图片结果入册')
  const context = runtimeTaskResultContext(task) as Record<string, unknown>
  const history = context.history as Record<string, unknown>
  const id = `task-${task.taskId}-${index}`
  const existing = await artworkRepository.readArtwork(id)
  if (existing && existing.image_id !== output.alias) throw new Error('作品编号已对应另一张图片，请核对作品册')
  let saved = existing
  if (!existing) {
    const input = task.input
    const recipe = runtimeTaskRecipe(task)
    const record: ArtworkRecord = {
      sceneTitle: null, emotion: [], shot: null, lighting: null,
      composition: null, colorMood: null, manual_tags: [], lora: typeof input.loraId === 'string' ? input.loraId : null, notes: '',
      parent_id: context.parentId ?? null, project: '', image_url: '',
      ...history, ...recipe, id, timestamp: task.createdAt, image_id: output.alias,
      prompt: recipe.prompt ?? '', negative: recipe.negative ?? '',
      character: String(context.char || input.character || history.character || ''),
      characterId: typeof context.characterId === 'string' ? context.characterId : undefined,
      outfitId: typeof context.outfitId === 'string' ? context.outfitId : undefined,
      blueprintId: typeof context.blueprintId === 'string' ? context.blueprintId : undefined,
      scene: context.characterId ? typeof context.blueprintId === 'string' ? context.blueprintId : null : typeof context.sceneId === 'string' ? context.sceneId : null,
      story: String(context.story ?? history.story ?? ''), subject: context.characterId ? 'popular' : 'studio',
      favorite: false, rating: {}, version: 1, taskId: task.taskId, outputIndex: index,
    }
    // Persist the recorded subset. Required history-view defaults must not turn
    // absent model/Seed/size fields into invented generation facts in the library.
    saved = record
    try { await artworkRepository.appendArtwork(saved) }
    catch (error) {
      const confirmed = await artworkRepository.readArtwork(id).catch(() => null)
      if (!confirmed || confirmed.image_id !== output.alias) throw error
      saved = confirmed
    }
  }
  await deps.markSaved(task.taskId)
  return saved!
}
