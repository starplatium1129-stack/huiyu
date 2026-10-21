import { readStoryOrigin, type StoryOrigin } from '@/types/storyOrigin'
import { DIRECTOR_CONTROL_KEYS, normalizeDirectorSources } from '@/utils/promptDirector'
import type { DirectorControlSources, DirectorControlValues } from '@/types/promptDirector'
import type { SceneBlueprint } from '@/types/sceneBlueprint'
import { profileLocalStorage as localStorage, writeProfileLocal } from '../../platform/web/profileStorage.ts'
import type { ProfileWriteReceipt } from '@/platform/web/profileWriteReceipt'
import { onScopeDispose, ref, watch, type Ref, type ComputedRef } from 'vue'
import { cloneReferenceInput, type DraftOutfitOverride, type DraftReferenceInput, type DraftRandomVariation, type PromptBuilderDraft, type SDParams } from '@/utils/promptBuilderPersistence'
import { tempResultOwner, sameTempResultOwner, type TempResultOwner } from '@/utils/tempResult'
import { storageWriteMessage } from '@/utils/storageWriteError'
import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'
import type { DrawSubject } from '@/utils/popularContent'
import type { CharKey, Selections } from '@/types/promptHistory'
import type { Scene } from '@/types/scene'

export interface PromptDraftState {
  storyOrigin: Ref<StoryOrigin | undefined>
  subject: Ref<DrawSubject>
  story: Ref<string>
  visualDescription: Ref<string>
  char: Ref<CharKey>
  sceneId: Ref<string | null>
  activeScene: ComputedRef<Scene | null>
  selections: Selections
  colorMood: Ref<string | null>
  directorSources: Ref<DirectorControlSources>
  inheritedDirectorValues: ComputedRef<DirectorControlValues>
  sceneBlueprints: ComputedRef<SceneBlueprint[]>
  loadPopularCharacter: (id: string) => Promise<void>
  manualTags: Ref<Set<string>>
  outfitOverride: Ref<DraftOutfitOverride | null>
  referenceInput: Ref<DraftReferenceInput | null>
  randomVariation: Ref<DraftRandomVariation | null>
  artistStyleIds: Ref<string[]>
  sceneBaseStory: Ref<string>
  directorMode: Ref<'basic' | 'pro'>
  sdParams: SDParams
  sdParamsTouched: Ref<Set<keyof SDParams>>
  projectId: Ref<string>
  scenes: ComputedRef<Scene[]>
  lastRecommendedSize: Ref<string>
  dataReady: Ref<boolean>
  flash: (message: string) => void
}

/** Owns the draft persistence timer; never owns generation or artwork storage. */
export function usePromptDraft(state: PromptDraftState) {
  const { subject, story, visualDescription, char, sceneId, activeScene, selections, colorMood, manualTags, outfitOverride, referenceInput, randomVariation, artistStyleIds, sceneBaseStory, directorMode, sdParams, sdParamsTouched, projectId, dataReady, flash } = state
  // ── Draft persistence ────────────────────────────────────────────────────
  const DRAFT_KEY = 'aics_pb_last_draft'
  let draftTimer: ReturnType<typeof setTimeout> | null = null
  let restoreRevision = 0, disposed = false
  let restoreFailed = false
  let editRevision = 0
  let draftOwner: TempResultOwner | undefined
  let latestWrite: { revision: number; receipt: ProfileWriteReceipt } | undefined
  const restoreParticipants = new Set<() => void>()
  const draftSaveState = ref<'idle' | 'pending' | 'saved' | 'failed'>('idle')
  const draftSaveError = ref('')
  function failed(error: unknown) {
    draftSaveState.value = 'failed'; draftSaveError.value = storageWriteMessage(error, '草稿')
    if (!disposed) flash(draftSaveError.value)
  }
  function persistDraft(): Promise<void> {
    if (draftTimer) clearTimeout(draftTimer)
    draftTimer = null
    try {
      if (restoreFailed) throw new Error('原草稿尚未恢复，请先重新打开页面，或明确重试保存当前输入')
      draftOwner ??= tempResultOwner()
      if (!sameTempResultOwner(draftOwner)) throw new Error('草稿资料来源已变化，请回到原工作区保存或导出当前输入')
      // A failed/unknown write keeps its original operation. New edits alone
      // admit a successor; an older acknowledgement cannot mark them saved.
      if (!latestWrite || latestWrite.revision !== editRevision) {
        latestWrite = { revision: editRevision, receipt: writeProfileLocal(DRAFT_KEY, JSON.stringify(snapshotDraft())) }
      }
      const write = latestWrite, owner = draftOwner
      const current = () => !disposed && latestWrite === write && editRevision === write.revision && !draftTimer && sameTempResultOwner(owner)
      draftSaveState.value = write.receipt.state === 'confirmed' ? 'saved' : 'pending'
      draftSaveError.value = ''
      return write.receipt.confirm().then(() => {
        if (current()) { draftSaveState.value = 'saved'; draftSaveError.value = '' }
      }, error => { if (current()) failed(error); throw error })
    } catch (error) {
      failed(error)
      return Promise.reject(error)
    }
  }
  const releaseMaintenance = registerMaintenanceParticipant(() => {
    if (draftTimer || draftSaveState.value === 'failed' || draftSaveState.value === 'pending') return persistDraft()
  })
  async function retryDraftSave() {
    if (!dataReady.value) return false
    if (restoreFailed) { editRevision++; latestWrite = undefined }
    restoreFailed = false
    try { await persistDraft(); return true } catch { return false }
  }
  function beforeUnload(event: BeforeUnloadEvent) {
    if (!draftTimer && draftSaveState.value !== 'failed' && draftSaveState.value !== 'pending') return
    // Admit the debounce before the global outbox guard. Native storage can
    // finish synchronously; a desktop receipt must settle before closing.
    if (!restoreFailed) void persistDraft().catch(() => {})
    if (restoreFailed || draftSaveState.value !== 'saved') { event.preventDefault(); event.returnValue = '' }
  }
  window.addEventListener('beforeunload', beforeUnload)
  function refreshConfirmedDraft() {
    if (!restoreFailed && !draftTimer && latestWrite?.revision === editRevision && latestWrite.receipt.state === 'confirmed')
      void persistDraft().catch(() => {})
  }
  window.addEventListener('huiyu:profile-sync-complete', refreshConfirmedDraft)

  function snapshotDraft(): PromptBuilderDraft {
    const subjectSnapshot = subject.value.kind === 'popular'
      ? {
          subject: 'popular' as const,
          characterId: subject.value.characterId,
          outfitId: subject.value.outfitId,
          outfitExplicit: subject.value.outfitExplicit,
          blueprintId: subject.value.blueprintId,
          noLora: true,
        }
      : { subject: 'studio' as const, noLora: char.value === 'none' }
    return {
      updatedAt: Date.now(),
      randomVariation: randomVariation.value ? JSON.parse(JSON.stringify(randomVariation.value)) : null,
      sceneStyleBaseline: { ...state.inheritedDirectorValues.value },
      directorSources: normalizeDirectorSources(state.directorSources.value),
      story: story.value,
      storyOrigin: readStoryOrigin(state.storyOrigin.value),
      visualDescription: visualDescription.value,
      char: char.value,
      sceneId: sceneId.value,
      sceneTitle: activeScene.value?.title ?? null,
      selections: { emotion: [...selections.emotion], shot: selections.shot, lighting: selections.lighting, composition: selections.composition },
      colorMood: colorMood.value,
      manualTags: [...manualTags.value],
      outfitOverride: subject.value.kind === 'popular' && outfitOverride.value
        ? { tokens: [...outfitOverride.value.tokens], replaced: outfitOverride.value.replaced }
        : null,
      referenceInput: cloneReferenceInput(referenceInput.value),
      artistStyleIds: [...artistStyleIds.value],
      sceneBaseStory: sceneBaseStory.value,
      directorMode: directorMode.value,
      sdParams: { ...sdParams },
      // 2026-08-16 审计：把用户已确认的参数键一并入草稿，恢复后不被 profile 覆盖。
      sdParamsTouched: [...sdParamsTouched.value],
      projectId: projectId.value,
      ...subjectSnapshot,
    }
  }

  function saveDraft() {
    if (!dataReady.value || restoreFailed) return
    editRevision++
    try { draftOwner ??= tempResultOwner() } catch (error) { failed(error); return }
    if (draftSaveState.value !== 'failed') draftSaveState.value = 'pending'
    if (draftTimer) clearTimeout(draftTimer)
    draftTimer = setTimeout(() => { void persistDraft().catch(() => {}) }, 280)
  }

  async function restoreDraft(isCurrent = () => true): Promise<boolean> {
    const revision = ++restoreRevision
    let release: (() => void) | undefined
    let raw: string | null = null
    try {
      if (disposed || !isCurrent()) return false
      const owner = tempResultOwner()
      if (draftOwner && !sameTempResultOwner(draftOwner) && (draftTimer || draftSaveState.value === 'pending' || draftSaveState.value === 'failed')) return false
      raw = localStorage.getItem(DRAFT_KEY)
      if (!raw) { draftOwner = owner; restoreFailed = false; return false }
      const fingerprint = () => {
        const { updatedAt: _updatedAt, ...draft } = snapshotDraft()
        return JSON.stringify({ ...draft, lastRecommendedSize: state.lastRecommendedSize.value })
      }
      // Freeze the pointer and editable inputs before loading the recovery action.
      const before = fingerprint()
      release = registerMaintenanceParticipant(() => { throw new Error('DRAFT_RESTORE_BUSY') })
      restoreParticipants.add(release)
      const { parsePromptBuilderDraft, restorePromptDraft } = await import('./promptBlueprintActions')
      const draft = parsePromptBuilderDraft(JSON.parse(raw))
      // Old popular drafts have no saved baseline. Read it before inferring ownership once.
      if (draft?.subject === 'popular' && draft.characterId && draft.blueprintId && !draft.sceneStyleBaseline
        && DIRECTOR_CONTROL_KEYS.some(key => !draft.directorSources?.[key])) {
        await state.loadPopularCharacter(draft.characterId)
      }
      if (disposed || revision !== restoreRevision || !isCurrent() || !sameTempResultOwner(owner)
        || localStorage.getItem(DRAFT_KEY) !== raw || fingerprint() !== before) return false
      const restored = restorePromptDraft(state, raw)
      if (!restored) throw new Error('已有草稿的结构无法恢复')
      draftOwner = owner; editRevision++; latestWrite = undefined
      restoreFailed = false; draftSaveState.value = 'idle'; draftSaveError.value = ''
      return true
    } catch {
      if (raw && !disposed && revision === restoreRevision && isCurrent()) {
        restoreFailed = true; draftSaveState.value = 'failed'
        draftSaveError.value = '草稿恢复未成功，原记录已保留。请重新打开页面；重试保存会用当前输入替换旧草稿。'
      }
      return false
    }
    finally { if (release) { release(); restoreParticipants.delete(release) } }
  }

  // Clearing or editing only the reference outfit does not touch manualTags.
  watch([outfitOverride, referenceInput, state.directorSources, state.storyOrigin], saveDraft, { deep: true })

  onScopeDispose(() => {
    if (draftTimer) void persistDraft().catch(() => {})
    disposed = true; restoreRevision++; releaseMaintenance()
    for (const release of restoreParticipants) release()
    restoreParticipants.clear()
    if (draftTimer) clearTimeout(draftTimer)
    window.removeEventListener('beforeunload', beforeUnload)
    window.removeEventListener('huiyu:profile-sync-complete', refreshConfirmedDraft)
  })
  return { snapshotDraft, saveDraft, restoreDraft, draftSaveState, draftSaveError, retryDraftSave }
}
