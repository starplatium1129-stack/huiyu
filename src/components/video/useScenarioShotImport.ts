import { computed, type Ref } from 'vue'
import { useVideoStore } from '@/stores/videoStore'
import type { ShotDraft } from './shotListTypes'
import type { ReferenceCard } from './useReferenceCards'
import { readStoryOrigin } from '@/types/storyOrigin'
import { VIDEO_SHOTS_DRAFT_KEY, VIDEO_SCENARIO_CONTEXT_KEY } from '@/utils/storageKeys'

/** Persist imported text and receipts before acknowledging the pending script. */
export function useScenarioShotImport(deps: {
  shots: Ref<ShotDraft[]>
  active: Ref<boolean>
  batchError: Ref<string>
  persistShotsDraft: (sourceActIds?: readonly string[]) => boolean
  referenceCards: Ref<ReferenceCard[]>
  selectCharacter: (id: string, index: number, outfit?: string) => Promise<boolean>
  adoptOutfitProse: (index: number, prose: string) => void
}) {
  const videoStore = useVideoStore()
  const pendingError = '分镜草稿已保存，剧本导入待办更新失败；可重试导入确认'
  const remainingActs = computed(() => {
    const savedReceipts = videoStore.shotsDraft?.scenarioImportReceipts
    const receipts = new Set(Array.isArray(savedReceipts) ? savedReceipts : [])
    return videoStore.pendingScenarioActs.filter(act => !act.importId
      || (!receipts.has(act.importId) && !deps.shots.value.some(shot => shot.importSourceActId === act.importId)))
  })
  const scenarioImportBlocked = computed(() => deps.shots.value.length > 0 && remainingActs.value.length > 0)

  let importing = false
  async function importScenarioActs() {
    if (importing) return
    importing = true
    try { await importPending() }
    catch (error) { deps.batchError.value = error instanceof Error ? error.message : '剧本导入未完成，待办已保留' }
    finally { importing = false }
  }
  async function importPending() {
    if (!deps.active.value) return
    const pending = videoStore.pendingScenarioActs
    if (!pending.length) return
    // Saved receipts survive a failed acknowledgement and later user edits.
    const remaining = remainingActs.value
    if (remaining.length !== pending.length) {
      const acknowledged = pending.filter(act => !remaining.includes(act)).flatMap(act => act.importId ? [act.importId] : [])
      if (!deps.persistShotsDraft(acknowledged)) {
        deps.batchError.value = '剧本导入确认保存失败，待办已保留；恢复存储后请重试'
        return
      }
      await videoStore.confirmDrafts([VIDEO_SHOTS_DRAFT_KEY, VIDEO_SCENARIO_CONTEXT_KEY])
      if (!deps.active.value || videoStore.pendingScenarioActs !== pending) return
      if (!videoStore.stageScenarioActs(remaining)) {
        deps.batchError.value = pendingError
        return
      }
      if (!remaining.length) deps.batchError.value = '剧本导入已确认，当前镜头已保留'
    }
    // Existing drawings and drafts keep priority over unimported script acts.
    if (deps.shots.value.length || !remaining.length) return
    if (!remaining.every(act => typeof act.importId === 'string' && act.importId)) {
      if (!videoStore.stageScenarioActs(remaining)) {
        deps.batchError.value = '剧本导入待办保存失败，原剧本已保留；恢复存储后请重试'
        return
      }
    }
    const acts = [...videoStore.pendingScenarioActs]
    const pairs = [...new Map(acts.map(act => [JSON.stringify([act.characterId, act.storyOrigin?.outfitId || '']), act])).values()]
    const slots = new Map<string, string>()
    for (const act of pairs) {
      if (!deps.active.value || deps.shots.value.length) return
      const outfit = act.storyOrigin?.outfitId
      const prose = act.storyOrigin?.outfitProse
      let index = deps.referenceCards.value.findIndex(card => card.characterId === act.characterId && (outfit ? card.outfitId === outfit && !card.outfitProseOverride : card.outfitProseOverride === prose))
      const reuse = index >= 0 && Boolean(deps.referenceCards.value[index].label)
      if (index < 0) index = deps.referenceCards.value.findIndex(card => !card.characterId && !card.label && !card.images.length)
      if (index < 0 && deps.referenceCards.value.length < 4) { index = deps.referenceCards.value.length; deps.referenceCards.value.push({ label: '', images: [] }) }
      if (index < 0) throw new Error('角色卡已满，请先留出对应角色的卡槽，再重试导入剧本。')
      if (!reuse) {
        if (!await deps.selectCharacter(act.characterId, index, outfit)) throw new Error('角色资料尚未读取，剧本待办已保留；请重试导入。')
        if (prose) deps.adoptOutfitProse(index, prose)
      }
      slots.set(JSON.stringify([act.characterId, outfit || '']), String(index + 1))
    }
    if (!deps.active.value || deps.shots.value.length || acts.some((act, index) => videoStore.pendingScenarioActs[index]?.importId !== act.importId)) return
    deps.shots.value = acts.map(act => ({
      storyOrigin: readStoryOrigin(act.storyOrigin),
      prompt: act.prompt,
      dialogue: act.dialogue,
      shotSize: act.shotSize,
      camera: act.camera,
      motion: act.motion,
      duration: act.duration === 5 || act.duration === 10 || act.duration === 15 ? act.duration : 3,
      seedText: '', imageName: '', imageUrl: '', cast: slots.get(JSON.stringify([act.characterId, act.storyOrigin?.outfitId || ''])) || '',
      importSourceActId: act.importId,
    }))
    if (!deps.persistShotsDraft(acts.flatMap(act => act.importId ? [act.importId] : []))) {
      deps.shots.value = []
      deps.batchError.value = '分镜草稿保存失败，剧本导入待办已保留；恢复存储后可重试导入'
      return
    }
    await videoStore.confirmDrafts([VIDEO_SHOTS_DRAFT_KEY, VIDEO_SCENARIO_CONTEXT_KEY])
    if (!deps.active.value || acts.length !== videoStore.pendingScenarioActs.length
      || acts.some((act, index) => videoStore.pendingScenarioActs[index]?.importId !== act.importId)) return
    if (!videoStore.stageScenarioActs([])) {
      deps.batchError.value = pendingError
      return
    }
    await videoStore.confirmDrafts([VIDEO_SHOTS_DRAFT_KEY, VIDEO_SCENARIO_CONTEXT_KEY])
    deps.batchError.value = `已载入剧本 ${acts.length} 幕及对应角色。可按需上传参考图或继续编辑镜头。`
  }

  const pendingScenarioCount = computed(() => videoStore.pendingScenarioActs.length)
  return { importScenarioActs, pendingScenarioCount, scenarioImportBlocked }
}
