import { readStoryOrigin } from '@/types/storyOrigin'
import { withArtworkStaging } from '@/storage/artworkSession'
import { useVideoStore, type VideoCtxPayload } from '@/stores/videoStore'
import type { ArtworkRepository } from '@/storage/artworkRepository'
import { flushProfileWrites } from '@/platform/web/profileStorage'
import { sameTempResultOwner, type TempResultOwner } from '@/utils/tempResult'

export type VideoTransferImage = Readonly<Omit<VideoCtxPayload, 'imageId'> & { blob: Blob }>
export interface VideoTransferOwner {
  repository: ArtworkRepository
  logicalOwner: TempResultOwner
  signal: AbortSignal
  current(): boolean
}
export function checkVideoTransfer(owner: VideoTransferOwner) {
  owner.signal.throwIfAborted()
  if (!owner.current()) throw new Error('图片来源或页面已变化，请在原工作区重新确认')
}
export function readShotsCount(): number { return useVideoStore().pendingShotCtxs.length }

/** Media I/O and acknowledgement belong to this lazy bridge, never the Store.
 * A published ctx is already a recovery source; unknown flushes retain its alias. */
export function createVideoTransfer() {
  type Destination = 'video' | 'shots'
  let pending: { ctx: VideoCtxPayload; destination: Destination; logicalOwner: TempResultOwner } | null = null

  async function confirm(owner: VideoTransferOwner) {
    checkVideoTransfer(owner)
    try { await flushProfileWrites() }
    catch (error) { throw new Error('图片交接尚未写稳，原待办与图片已保留；重试只确认原交接。', { cause: error }) }
    checkVideoTransfer(owner)
  }
  async function resumePending(owner: VideoTransferOwner) {
    if (!pending) return null
    checkVideoTransfer(owner)
    if (!sameTempResultOwner(pending.logicalOwner)) throw new Error('原图片交接属于另一资料来源，请回到原工作区核对')
    const store = useVideoStore(), imageId = pending.ctx.imageId
    const retained = pending.destination === 'video'
      ? store.pendingImageCtx?.imageId === imageId || store.videoDraft?.importSourceImageId === imageId
      : store.pendingShotCtxs.some(ctx => ctx.imageId === imageId) || store.shotsDraft?.shots.some(shot => shot.importSourceImageId === imageId)
    if (!retained) throw new Error('原图片交接尚无法核对，图片已保留；请在原故事短片页核对待办和草稿')
    const destination = pending.destination
    await confirm(owner)
    pending = null
    return destination
  }
  async function publish(image: VideoTransferImage, destination: Destination, owner: VideoTransferOwner) {
    checkVideoTransfer(owner)
    if (pending) throw new Error('请先确认原图片交接')
    const store = useVideoStore()
    // A failed navigation must not overwrite the sole, unconsumed video inbox.
    if (destination === 'video' && store.pendingImageCtx) {
      await confirm(owner)
      return { count: readShotsCount(), reused: true }
    }
    return withArtworkStaging(async () => {
      let imageId = '', published = false
      try {
        checkVideoTransfer(owner)
        if (!image.blob.size) throw new Error('成片数据暂不可读取，请恢复原图片后重试')
        imageId = await owner.repository.putImage(image.blob)
        checkVideoTransfer(owner)
        const ctx: VideoCtxPayload = { imageId, storyOrigin: readStoryOrigin(image.storyOrigin), prompt: image.prompt, story: image.story,
          blueprintId: image.blueprintId, characterId: image.characterId,
          outfitId: image.outfitId ?? null, sceneId: image.sceneId }
        published = destination === 'video' ? store.stageImageCtx(ctx) : store.appendShotCtx(ctx).ok
        if (!published) throw new Error('图片待带入列表写入失败，请保留原图并检查存储空间')
        pending = { ctx, destination, logicalOwner: owner.logicalOwner }
        await confirm(owner)
        pending = null
        return { count: readShotsCount(), reused: false }
      } finally {
        // Only this fresh, unpublished alias can be released through its owner.
        if (imageId && !published && owner.current()) await owner.repository.deleteImage(imageId)
          .catch(error => console.warn('[video-bridge] unpublished image cleanup failed', error))
      }
    })
  }
  return { publish, resumePending }
}
