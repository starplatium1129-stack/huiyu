import { withArtworkStaging } from '@/storage/artworkSession'
import { useVideoStore, prepareVideoCtx } from '@/stores/videoStore'
import { artworkRepository } from '@/storage/artworkRepository'
import type { VideoBridgeTarget, VideoCtxPayload } from '@/stores/videoStore'

export type { VideoBridgeTarget, VideoCtxPayload } from '@/stores/videoStore'
export { prepareVideoCtx }

/**
 * 绘图页 → 视频页「出视频」桥接（动态 import，独立 chunk，不进 PromptBuilder 路由块）。
 * 图片本体不跨页传（sessionStorage 容量限制），先入 IndexedDB 再只传 imageId；
 * 场景/角色上下文随行，视频页据此自动组装视频提示词。
 * 单图跳转与分镜追加共享 videoStore；分镜页负责消费已完成导入的条目。
 */

/** 把一张出图追加到「分镜短片」待带入列表（videoStore 持久化）。
 *  返回 { ok, count }（F4）：存储写失败 ok=false 且内存回滚，调用方必须如实提示。 */
export function appendShotsCtx(ctx: VideoCtxPayload): { ok: boolean; count: number } {
  return useVideoStore().appendShotCtx(ctx)
}

export function readShotsCtx(): VideoCtxPayload[] {
  return useVideoStore().pendingShotCtxs
}

export async function bridgeToVideo(target: VideoBridgeTarget): Promise<boolean> {
  return withArtworkStaging(async () => {
    const store = useVideoStore()
    const repository = artworkRepository
    const ctx = await prepareVideoCtx(target, repository)
    if (!ctx) return false
    let published = false
    try {
      published = store.stageImageCtx(ctx)
      if (!published) { target.flash('跨页上下文写入失败'); return false }
    } catch (error) {
      target.flash('跨页上下文写入失败')
      console.warn(error)
      return false
    } finally {
      // Only this newly staged, unpublished alias belongs to the failed transfer.
      if (!published) await repository.deleteImage(ctx.imageId)
        .catch(error => console.warn('[video-bridge] unpublished image cleanup failed', error))
    }
    await target.push('/video-studio')
    return true
  })
}
