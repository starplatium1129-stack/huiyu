import { computed, type Ref } from 'vue'
import { useVideoStore } from '@/stores/videoStore'
import type { ShotDraft } from './shotListTypes'

/** Persist imported text and receipts before acknowledging the pending script. */
export function useScenarioShotImport(deps: {
  shots: Ref<ShotDraft[]>
  active: Ref<boolean>
  batchError: Ref<string>
  persistShotsDraft: (sourceActIds?: readonly string[]) => boolean
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

  function importScenarioActs() {
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
    deps.shots.value = acts.map(act => ({
      prompt: act.prompt,
      dialogue: act.dialogue,
      shotSize: act.shotSize,
      camera: act.camera,
      motion: act.motion,
      duration: act.duration === 5 || act.duration === 10 || act.duration === 15 ? act.duration : 3,
      seedText: '', imageName: '', imageUrl: '', cast: '',
      importSourceActId: act.importId,
    }))
    if (!deps.persistShotsDraft(acts.flatMap(act => act.importId ? [act.importId] : []))) {
      deps.shots.value = []
      deps.batchError.value = '分镜草稿保存失败，剧本导入待办已保留；恢复存储后可重试导入'
      return
    }
    if (!videoStore.stageScenarioActs([])) {
      deps.batchError.value = pendingError
      return
    }
    deps.batchError.value = `已载入剧本 ${acts.length} 幕。可选择角色并按需上传参考图，再点「一键首帧」或批量生成。`
  }

  const pendingScenarioCount = computed(() => videoStore.pendingScenarioActs.length)
  return { importScenarioActs, pendingScenarioCount, scenarioImportBlocked }
}
