import type { Ref } from 'vue'
import { createVideoTransfer, checkVideoTransfer, readShotsCount, type VideoTransferOwner } from '@/composables/useVideoBridge'
import { tagsToVideoProse } from '@/utils/videoPromptProse'
import { flushProfileWrites } from '@/platform/web/profileStorage'
import type { PromptVideoBridgeDeps, PromptVideoSnapshot, HistoryVideoSnapshot } from './usePromptVideoBridge'

// Only loaded when a finished image is sent to a video or shot list.
export function createPromptVideoActions(flash: PromptVideoBridgeDeps['flash'], shotsPending: Ref<number>) {
  const transfer = createVideoTransfer()
  async function resumePending(owner: VideoTransferOwner) {
    const destination = await transfer.resumePending(owner)
    if (!destination) return false
    checkVideoTransfer(owner)
    shotsPending.value = readShotsCount()
    flash('原' + (destination === 'video' ? '视频首帧' : '分镜') + '交接已确认；本次新要求尚未执行，请再次操作')
    return true
  }
  async function goToVideo(snapshot: PromptVideoSnapshot, push: (path: string) => Promise<unknown> | void, owner: VideoTransferOwner) {
    const result = await transfer.publish({ ...snapshot, prompt: tagsToVideoProse(snapshot.prompt) }, 'video', owner)
    checkVideoTransfer(owner)
    if (result.reused) flash('已接回上次待带入的首帧；确认原导入后可继续添加新图片')
    await push('/video-studio')
  }
  async function addToShots(snapshot: PromptVideoSnapshot, owner: VideoTransferOwner) {
    const result = await transfer.publish({ ...snapshot, prompt: tagsToVideoProse(snapshot.prompt) }, 'shots', owner)
    checkVideoTransfer(owner)
    shotsPending.value = result.count
    flash('已加入分镜短片（当前 ' + result.count + ' 个镜头）')
  }
  async function goToShots(push: (path: string) => Promise<unknown> | void, owner: VideoTransferOwner) {
    checkVideoTransfer(owner)
    if (!readShotsCount()) { flash('还没有加入任何镜头：先出图，再点「加入分镜」'); return }
    await flushProfileWrites()
    checkVideoTransfer(owner)
    await push('/video-studio?mode=shots')
  }
  async function historyImage(entry: HistoryVideoSnapshot, owner: VideoTransferOwner): Promise<PromptVideoSnapshot> {
    checkVideoTransfer(owner)
    const blob = await owner.repository.getImage(entry.image_id || '', owner.signal)
    checkVideoTransfer(owner)
    if (!blob?.size) throw new Error('历史图片暂不可读取，未加入分镜')
    return { blob, prompt: tagsToVideoProse(entry.prompt || entry.story || ''), story: entry.story || '', storyOrigin: entry.storyOrigin,
      blueprintId: entry.blueprintId ?? null, characterId: entry.characterId || entry.storyOrigin?.characterId || '',
      outfitId: entry.outfitId ?? null, sceneId: entry.scene ?? null }
  }
  async function handleHistoryToShots(entry: HistoryVideoSnapshot, owner: VideoTransferOwner) {
    const result = await transfer.publish(await historyImage(entry, owner), 'shots', owner)
    checkVideoTransfer(owner)
    shotsPending.value = result.count
    flash('已加入分镜短片（当前 ' + result.count + ' 个镜头）')
  }
  async function handleHistoryToShotsBatch(entries: ReadonlyArray<HistoryVideoSnapshot>, owner: VideoTransferOwner) {
    if (!entries.length) return
    let added = 0, unreadable = 0
    for (const entry of entries) {
      checkVideoTransfer(owner)
      let image: PromptVideoSnapshot
      try { image = await historyImage(entry, owner) }
      catch (error) { checkVideoTransfer(owner); unreadable++; console.warn(error); continue }
      // Unknown publication stops here; already confirmed predecessors stay saved.
      try {
        const result = await transfer.publish(image, 'shots', owner)
        checkVideoTransfer(owner)
        shotsPending.value = result.count
      }
      catch (error) {
        throw new Error('已确认加入 ' + added + ' 张；当前交接待核对或未写入，其余未处理。' + (error instanceof Error ? error.message : ''), { cause: error })
      }
      added++
    }
    checkVideoTransfer(owner)
    shotsPending.value = readShotsCount()
    flash(unreadable ? '已加入分镜 ' + added + ' 张，' + unreadable + ' 张暂不可读取' : '已加入分镜 ' + added + ' 张（当前共 ' + shotsPending.value + ' 镜）')
  }
  return { resumePending, goToVideo, addToShots, goToShots, handleHistoryToShots, handleHistoryToShotsBatch }
}
