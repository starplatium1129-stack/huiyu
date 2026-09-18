import { withArtworkStaging } from '@/storage/artworkSession'
import { useVideoStore, prepareVideoCtx } from '@/stores/videoStore'
import type { VideoBridgeTarget, VideoCtxPayload } from '@/stores/videoStore'

export type { VideoBridgeTarget, VideoCtxPayload } from '@/stores/videoStore'
export { prepareVideoCtx }

/**
 * 绘图页 → 视频页「出视频」桥接（动态 import，独立 chunk，不进 PromptBuilder 路由块）。
 * 图片本体不跨页传（sessionStorage 容量限制），先入 IndexedDB 再只传 imageId；
 * 场景/角色上下文随行，视频页据此自动组装视频提示词。
 * 2026-08-16 扩展：多图「加入分镜」→ 分镜短片（VIDEO_SHOTS_CTX_KEY 数组载荷）。
 * 2026-08-22 收敛：载荷读写全部委托 videoStore（类型化响应式 + sessionStorage 持久），
 * 本文件退化为纯门面。
 * 2026-08-28 清理：VIDEO_CTX_KEY / VIDEO_SHOTS_CTX_KEY 兼容导出的消费端已全部
 * 迁移至 videoStore，零引用故移除；key 本体仍由 storageKeys 单点管理。
 */

/** 把一张出图追加到「分镜短片」待带入列表（videoStore 持久化）。
 *  返回 { ok, count }（F4）：存储写失败 ok=false 且内存回滚，调用方必须如实提示。 */
export function appendShotsCtx(ctx: VideoCtxPayload): { ok: boolean; count: number } {
  return useVideoStore().appendShotCtx(ctx)
}

export function readShotsCtx(): VideoCtxPayload[] {
  return useVideoStore().pendingShotCtxs
}

export function clearShotsCtx(): void {
  useVideoStore().consumeShotCtxs()
}

export async function bridgeToVideo(target: VideoBridgeTarget): Promise<boolean> {
  return withArtworkStaging(async () => {
    const store = useVideoStore()
    const ctx = await prepareVideoCtx(target)
    if (!ctx) return false
    if (!store.stageImageCtx(ctx)) {
      target.flash('跨页上下文写入失败')
      return false
    }
    await target.push('/video-studio')
    return true
  })
}

/** 多图带入分镜短片：全部准备完成后一次性跳转（失败单图跳过，不阻塞其余）。 */
export async function bridgeShotsToVideo(targets: VideoBridgeTarget[]): Promise<boolean> {
  return withArtworkStaging(async () => {
    const store = useVideoStore()
    const prepared: VideoCtxPayload[] = []
    for (const target of targets) {
      const ctx = await prepareVideoCtx(target)
      if (ctx) prepared.push(ctx)
    }
    if (!prepared.length) return false
    store.consumeShotCtxs()
    if (!store.stageShotCtxs(prepared)) return false
    await targets[0].push('/video-studio?mode=shots')
    return true
  })
}
