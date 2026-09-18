import { withArtworkStaging } from '@/storage/artworkSession'
import type { Ref } from 'vue'
import type { HistoryEntry } from '@/stores/promptBuilderStore'
import { imgGet } from '@/composables/useImageStore'
import type { PromptVideoBridgeDeps } from './usePromptVideoBridge'

// Only loaded when a finished image is sent to a video or shot list.
export function createPromptVideoActions(deps: PromptVideoBridgeDeps, shotsPending: Ref<number>) {
  const { flash } = deps

  /**
   * 组装跨页上下文（useVideoBridge 独立 chunk，动态 import 不膨胀本路由块）。
   * prompt 取该图实际生成时的提示词（Anima 取结果 metadata、SD 取提交时记录），
   * 不随面板后续修改漂移。
   */
  async function videoTargetData() {
    const url = deps.displayResultUrl.value
    if (!url) { flash('暂无可转视频的成片'); return null }
    if (deps.drawEngine.value !== 'sd' && !deps.animaState.value.result) {
      flash('成片数据已失效，请重新生成')
      return null
    }
    const subject = deps.subject()
    // 按图取词：优先该图实际生成时使用的提示词，面板实时组装值只作兜底。
    let usedPrompt = deps.livePrompt.value || ''
    if (deps.drawEngine.value !== 'sd') {
      usedPrompt = deps.animaState.value.result?.metadata?.prompt || usedPrompt
    } else {
      usedPrompt = deps.sdResultPrompt.value || usedPrompt
    }
    // 词条流 → 自然语言（H3 是自然语言模型；已像自然语言的提示词原样保留）。
    // 转换器只有「出视频/加入分镜」点击时才需要，随 useVideoBridge 一起按需拉取。
    const { tagsToVideoProse } = await import('@/utils/videoPromptProse')
    // F3：归属信息以生成时冻结快照为准；无快照（本功能前的会话内结果）才回退表单。
    const frozen = deps.resultContext()
    return {
      displayUrl: url,
      animaBlob: deps.drawEngine.value !== 'sd' ? deps.animaState.value.result?.blob ?? null : null,
      prompt: tagsToVideoProse(usedPrompt),
      story: frozen?.story ?? (deps.story() || ''),
      blueprintId: frozen
        ? (frozen.blueprintId ?? null)
        : (subject.kind === 'popular' ? (subject.blueprintId ?? null) : deps.sceneId()),
      characterId: frozen
        ? (frozen.characterId ?? '')
        : (subject.kind === 'popular' ? subject.characterId ?? '' : ''),
      outfitId: frozen
        ? (frozen.outfitId ?? null)
        : (subject.kind === 'popular' ? (subject.outfitId ?? null) : null),
      sceneId: frozen ? (frozen.sceneId ?? null) : deps.sceneId(),
    }
  }

  async function goToVideo(push: (path: string) => Promise<unknown> | void) {
    const data = await videoTargetData()
    if (!data) return
    const { bridgeToVideo } = await import('@/composables/useVideoBridge')
    await bridgeToVideo({
      ...data,
      flash,
      push,
    })
  }

  /** 已「加入分镜」的镜头数（videoStore 持久，刷新不丢）。 */

  async function refreshShotsPending() {
    try {
      const { readShotsCtx } = await import('@/composables/useVideoBridge')
      shotsPending.value = readShotsCtx().length
    } catch { /* 保持 0 */ }
  }

  function flashAdded(count: number) {
    flash(`已加入分镜短片（当前 ${count} 个镜头）`)
  }

  /** 「加入分镜」：把当前成片入 IndexedDB + 上下文追加到分镜待带入列表。 */
  async function addToShots() {
    return withArtworkStaging(async () => {
      const data = await videoTargetData()
      if (!data) return
      const { prepareVideoCtx, appendShotsCtx } = await import('@/composables/useVideoBridge')
      const ctx = await prepareVideoCtx({
        ...data,
        flash,
        push: async () => {},
      })
      if (!ctx) return
      // F4：存储失败如实回报并回滚（旧语义静默挤掉最旧镜头）。
      const appended = appendShotsCtx(ctx)
      if (!appended.ok) {
        flash('分镜待带入列表写入失败（存储空间不足）：请先到视频页消费或清理已加入的镜头')
        return
      }
      shotsPending.value = appended.count
      flashAdded(shotsPending.value)
    })
  }

  /** 「去分镜短片」：跳转视频页分镜模式，一次性消费已加入的镜头。 */
  async function goToShots(push: (path: string) => Promise<unknown> | void) {
    const { readShotsCtx } = await import('@/composables/useVideoBridge')
    if (!readShotsCtx().length) {
      flash('还没有加入任何镜头：先出图，再点「加入分镜」')
      return
    }
    await push('/video-studio?mode=shots')
  }

  /**
   * 历史图 → 加入分镜：从历史条目重建跨页上下文（图片走 IndexedDB、
   * prompt 用该图实际生成时保存的词），追加到分镜待带入列表。
   */
  async function handleHistoryToShots(entry: HistoryEntry) {
    return withArtworkStaging(async () => {
      try {
        const blob = await imgGet(entry.image_id)
        if (!blob || !blob.size) { flash('历史图片已失效，无法加入分镜'); return }
        const { prepareVideoCtx, appendShotsCtx } = await import('@/composables/useVideoBridge')
        const { tagsToVideoProse } = await import('@/utils/videoPromptProse')
        const ctx = await prepareVideoCtx({
          displayUrl: '',
          animaBlob: blob,
          prompt: tagsToVideoProse(entry.prompt || entry.story || ''),
          story: entry.story || '',
          blueprintId: entry.blueprintId ?? null,
          characterId: entry.characterId ?? '',
          // F3：历史条目自带生成时的服装归属，参考卡按同一套服装装配。
          outfitId: entry.outfitId ?? null,
          sceneId: entry.scene ?? null,
          flash,
          push: async () => {},
        })
        if (!ctx) return
        const appended = appendShotsCtx(ctx)
        if (!appended.ok) {
          flash('分镜待带入列表写入失败（存储空间不足）：请先到视频页消费或清理已加入的镜头')
          return
        }
        shotsPending.value = appended.count
        flashAdded(shotsPending.value)
      } catch (error) {
        flash('加入分镜失败')
        console.warn(error)
      }
    })
  }

  /** 历史多选批量加入分镜：逐张重建上下文，成功/失败计数汇总。 */
  async function handleHistoryToShotsBatch(entries: HistoryEntry[]) {
    return withArtworkStaging(async () => {
      if (!entries.length) return
      const { prepareVideoCtx, appendShotsCtx, readShotsCtx } = await import('@/composables/useVideoBridge')
      const { tagsToVideoProse } = await import('@/utils/videoPromptProse')
      let added = 0
      let failed = 0
      for (const entry of entries) {
        try {
          const blob = await imgGet(entry.image_id)
          if (!blob || !blob.size) { failed += 1; continue }
          const ctx = await prepareVideoCtx({
            displayUrl: '',
            animaBlob: blob,
            prompt: tagsToVideoProse(entry.prompt || entry.story || ''),
            story: entry.story || '',
            blueprintId: entry.blueprintId ?? null,
            characterId: entry.characterId ?? '',
            outfitId: entry.outfitId ?? null,
            sceneId: entry.scene ?? null,
            flash: () => {},
            push: async () => {},
          })
          if (!ctx) { failed += 1; continue }
          const appended = appendShotsCtx(ctx)
          if (!appended.ok) {
            // 存储写失败：不再追加后续，已加入的保留，如实汇报
            flash(`存储空间不足：已加入 ${added} 张，其余未能加入`)
            shotsPending.value = readShotsCtx().length
            return
          }
          added += 1
        } catch (error) {
          failed += 1
          console.warn(error)
        }
      }
      shotsPending.value = readShotsCtx().length
      flash(failed
        ? `已加入分镜 ${added} 张，${failed} 张失败（图片失效）`
        : `已加入分镜 ${added} 张（当前共 ${shotsPending.value} 镜）`)
    })
  }

  return {
    videoTargetData,
    goToVideo,
    shotsPending,
    refreshShotsPending,
    addToShots,
    goToShots,
    handleHistoryToShots,
    handleHistoryToShotsBatch,
  }
}
