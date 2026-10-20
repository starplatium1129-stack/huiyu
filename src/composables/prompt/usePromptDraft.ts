import { sceneStyleBaseline } from '@/utils/randomVariationContext'
import { profileLocalStorage as localStorage, profileRuntimeActive } from '../../platform/web/profileStorage.ts'
import { onScopeDispose, ref, watch, type Ref, type ComputedRef } from 'vue'
import { cloneReferenceInput, type DraftOutfitOverride, type DraftReferenceInput, type DraftRandomVariation, type PromptBuilderDraft, type SDParams } from '@/utils/promptBuilderPersistence'
import { tempResultOwner, sameTempResultOwner } from '@/utils/tempResult'
import { storageWriteMessage } from '@/utils/storageWriteError'
import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'
import type { DrawSubject } from '@/utils/popularContent'
import type { CharKey, Selections } from '@/types/promptHistory'
import type { Scene } from '@/types/scene'

export interface PromptDraftState {
  subject: Ref<DrawSubject>
  story: Ref<string>
  visualDescription: Ref<string>
  char: Ref<CharKey>
  sceneId: Ref<string | null>
  activeScene: ComputedRef<Scene | null>
  selections: Selections
  colorMood: Ref<string | null>
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
  const restoreParticipants = new Set<() => void>()
  const draftSaveState = ref<'idle' | 'pending' | 'saved' | 'failed'>('idle')
  const draftSaveError = ref('')
  function persistDraft() {
    if (draftTimer) clearTimeout(draftTimer)
    draftTimer = null
    try {
      if (restoreFailed) throw new Error('原草稿尚未恢复，请先重新打开页面，或明确重试保存当前输入')
      localStorage.setItem(DRAFT_KEY, JSON.stringify(snapshotDraft()))
      draftSaveState.value = 'saved'; draftSaveError.value = ''
    } catch (error) {
      draftSaveState.value = 'failed'; draftSaveError.value = storageWriteMessage(error, '草稿')
      throw error
    }
  }
  const releaseMaintenance = registerMaintenanceParticipant(() => { if (draftTimer || draftSaveState.value === 'failed') persistDraft() })
  function retryDraftSave() {
    if (!dataReady.value) return false
    restoreFailed = false
    try { persistDraft(); return true } catch { return false }
  }
  function beforeUnload(event: BeforeUnloadEvent) {
    // Desktop profiles own asynchronous write/close protection.
    if (profileRuntimeActive() || (!draftTimer && draftSaveState.value !== 'failed')) return
    if (restoreFailed || !retryDraftSave()) { event.preventDefault(); event.returnValue = '' }
  }
  window.addEventListener('beforeunload', beforeUnload)

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
      sceneStyleBaseline: activeScene.value ? sceneStyleBaseline(activeScene.value) : undefined,
      story: story.value,
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
    if (draftSaveState.value !== 'failed') draftSaveState.value = 'pending'
    if (draftTimer) clearTimeout(draftTimer)
    draftTimer = setTimeout(() => {
      try {
        persistDraft()
      } catch (e) {
        // 2026-08-30 UX 审计：原先 catch {} 静默吞掉。配额写满时界面一切正常、
        // 用户以为草稿已存，刷新即丢——必须让失败可感知并给出补救动作。
        console.warn('[draft] 草稿写入失败', e)
        flash(draftSaveError.value)
      }
    }, 280)
  }

  async function restoreDraft(isCurrent = () => true): Promise<boolean> {
    const revision = ++restoreRevision
    let release: (() => void) | undefined
    let raw: string | null = null
    try {
      if (disposed || !isCurrent()) return false
      raw = localStorage.getItem(DRAFT_KEY)
      if (!raw) { restoreFailed = false; return false }
      const owner = tempResultOwner()
      const fingerprint = () => {
        const { updatedAt: _updatedAt, ...draft } = snapshotDraft()
        return JSON.stringify({ ...draft, lastRecommendedSize: state.lastRecommendedSize.value })
      }
      // Freeze the pointer and editable inputs before loading the recovery action.
      const before = fingerprint()
      release = registerMaintenanceParticipant(() => { throw new Error('DRAFT_RESTORE_BUSY') })
      restoreParticipants.add(release)
      const { restorePromptDraft } = await import('./promptBlueprintActions')
      if (disposed || revision !== restoreRevision || !isCurrent() || !sameTempResultOwner(owner)
        || localStorage.getItem(DRAFT_KEY) !== raw || fingerprint() !== before) return false
      const restored = restorePromptDraft(state, raw)
      if (!restored) throw new Error('已有草稿的结构无法恢复')
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
  watch([outfitOverride, referenceInput], saveDraft, { deep: true })

  onScopeDispose(() => {
    disposed = true; restoreRevision++; releaseMaintenance()
    for (const release of restoreParticipants) release()
    restoreParticipants.clear()
    if (draftTimer) clearTimeout(draftTimer)
    window.removeEventListener('beforeunload', beforeUnload)
  })
  return { snapshotDraft, saveDraft, restoreDraft, draftSaveState, draftSaveError, retryDraftSave }
}
