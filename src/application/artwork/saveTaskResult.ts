import type { ArtworkRepository } from './artworkRepository'
import type { TaskRecord } from '../../../types/tasks'
import type { ArtworkRecord } from '@/types/artwork'
import { runtimeTaskResultContext, runtimeTaskRecipe } from '@/utils/runtimeTaskResult'
import { mangaTaskArtwork } from './mangaTaskResult'
import { qwenTaskArtwork } from './qwenTaskResult'
import { taskArtworkId } from './taskResultIdentity'

/** Task outputs already live in the workspace; save adds an artwork reference. */
export async function saveTaskResult(task: TaskRecord, index: number, deps: {
  repository: ArtworkRepository; assertCurrent(): void; markSaved(id: string): Promise<unknown>
}): Promise<ArtworkRecord> {
  const artworkRepository = deps.repository
  const check = deps.assertCurrent
  async function readArtwork(id: string) {
    check()
    const record = await artworkRepository.readArtwork(id)
    check()
    return record
  }
  check()
  const manga = task.kind === 'manga' || task.kind === 'lineart'
  if (manga && task.resultState !== 'available') throw new Error('漫画结果仍在保存，请稍后入册')
  const output = task.resultRefs.find(value => value.index === index)
  if (!output?.mime.startsWith('image/')) throw new Error('请选择图片结果入册')
  const nativeImage = task.kind === 'qwen' || task.kind === 'moss'
  const context = nativeImage ? {} : runtimeTaskResultContext(task) as Record<string, unknown>
  const history = context.history as Record<string, unknown>
  const id = taskArtworkId(task.taskId, index)
  const existing = await readArtwork(id)
  if (existing && existing.image_id !== output.alias) throw new Error('作品编号已对应另一张图片，请核对作品册')
  let saved = existing
  if (!existing) {
    const input = task.input
    const recipe = nativeImage ? {} : runtimeTaskRecipe(task)
    const record: ArtworkRecord = nativeImage ? qwenTaskArtwork(task, index) : manga ? mangaTaskArtwork(task, index) : {
      sceneTitle: null, emotion: [], shot: null, lighting: null,
      composition: null, colorMood: null, manual_tags: [], lora: typeof input.loraId === 'string' ? input.loraId : null, notes: '',
      parent_id: context.parentId ?? null, project: '', image_url: '',
      ...history, ...recipe, id, timestamp: task.createdAt, image_id: output.alias,
      prompt: recipe.prompt ?? '', negative: recipe.negative ?? '',
      character: typeof context.characterId === 'string' && context.characterId.trim()
        ? context.characterId : String(context.char || input.character || history.character || ''),
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
    try { check(); await artworkRepository.appendArtwork(saved); check() }
    catch (error) {
      check()
      const confirmed = await readArtwork(id).catch(() => null)
      check()
      if (!confirmed || confirmed.image_id !== output.alias) throw error
      saved = confirmed
    }
  }
  // A page and its line sidecar share delivery state, but have separate artwork
  // identities. Keep the inbox until every received image has been archived.
  const complete = !manga || (await Promise.all(task.resultRefs.map(async ref =>
    (await readArtwork(taskArtworkId(task.taskId, ref.index)))?.image_id === ref.alias))).every(Boolean)
  check()
  if (complete) await deps.markSaved(task.taskId)
  check()
  return saved!
}
