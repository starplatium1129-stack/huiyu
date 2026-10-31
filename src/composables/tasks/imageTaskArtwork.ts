import { archiveTaskResult } from './taskArtwork'
import { fetchImageTaskResult, type ImageTask } from './useImageTaskSession'
import { blobArtworkResult } from '@/composables/manga/mangaResult'
import type { ArtworkRecord } from '@/types/artwork'
import { taskArtworkId } from '@/application/artwork/taskResultIdentity'

export const imageTaskArtworkId = (task: ImageTask, index = 0) => task.runtimeTask ? taskArtworkId(task.taskId, index) : `image-job-${task.taskId}-${index}`
export function createImageTaskArchiver(check: () => void, signal: AbortSignal) {
  const results = new Map<string, ReturnType<typeof blobArtworkResult>>()
  return async (task: ImageTask, blob: Blob | null, index = 0, parent?: ArtworkRecord) => {
    check()
    if (task.runtimeTask) return archiveTaskResult(task.taskId, index)
    const id = imageTaskArtworkId(task, index)
    let result = results.get(id)
    if (!result) {
      const image = blob || await fetchImageTaskResult(task, signal, index); check()
      const bitmap = await createImageBitmap(image)
      const width = bitmap.width, height = bitmap.height; bitmap.close(); check()
      const input = { ...task.input, ...task.metadata }, manga = task.kind === 'manga' || task.kind === 'lineart'
      const line = task.kind === 'lineart' || index === 1
      const context = task.metadata.context as Record<string, unknown> | undefined
      const source = parent ?? context?.mangaSource as Partial<ArtworkRecord> | undefined
      const record: ArtworkRecord = { id, timestamp: task.createdAt, image_url: '', favorite: false, version: 1,
        engine: manga ? 'manga-screen' : task.kind === 'moss' ? 'moss-image' : 'qwen-image', provider: 'native',
        artifactKind: manga ? line ? 'lineart' : 'manga' : undefined,
        sceneTitle: manga ? `${source?.sceneTitle || '图片'} · ${line ? '线稿' : '漫画版'}` : String(context?.sceneTitle || (task.kind === 'moss' ? 'MOSS 创作' : 'Qwen 创作')),
        parent_id: source?.id ?? (typeof context?.parentId === 'string' || typeof context?.parentId === 'number' ? context.parentId : null),
        character: source?.character || String(context?.character || ''), characterId: source?.characterId, subject: source?.subject,
        outfitId: source?.outfitId, blueprintId: source?.blueprintId, project: source?.project || '',
        width, height, size: `${width} × ${height}`, manual_tags: manga ? [line ? '线稿' : '漫画'] : [],
        postprocess: { ...structuredClone(input), directJobId: task.taskId }, checkpoint: typeof input.modelId === 'string' ? input.modelId : undefined }
      for (const key of ['prompt', 'negative', 'sampler', 'scheduler']) if (typeof input[key] === 'string') record[key] = input[key]
      for (const key of ['seed', 'steps', 'cfg']) if (typeof input[key] === 'number') record[key] = input[key]
      if (!manga) for (const key of ['character', 'characterId', 'outfitId', 'blueprintId', 'story', 'visualDescription']) {
        if (typeof context?.[key] === 'string') record[key] = context[key]
      }
      if (task.kind === 'moss') record.mossAcceleration = input.mossAcceleration === 'spectrum' ? 'spectrum' : 'off'
      result = blobArtworkResult(image, record, check); results.set(id, result)
    }
    const saved = await result.save()
    results.delete(id)
    return saved
  }
}
