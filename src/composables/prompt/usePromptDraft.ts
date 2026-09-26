import { profileLocalStorage as localStorage } from '../../platform/web/profileStorage.ts'
import { onScopeDispose, type Ref, type ComputedRef } from 'vue'
import { sceneLighting, sceneShot, sceneColorMood, sceneComposition, sceneRecommendedSize } from '@/utils/sceneInference'
import { isSDParamKey, parsePromptBuilderDraft, type PromptBuilderDraft, type SDParams } from '@/utils/promptBuilderPersistence'
import { normalizeArtistStyleIds } from '@/config/artistStyles'
import { storageWriteMessage } from '@/utils/storageWriteError'
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
  const { subject, story, visualDescription, char, sceneId, activeScene, selections, colorMood, manualTags, artistStyleIds, sceneBaseStory, directorMode, sdParams, sdParamsTouched, projectId, scenes, lastRecommendedSize, dataReady, flash } = state
  // ── Draft persistence ────────────────────────────────────────────────────
  const DRAFT_KEY = 'aics_pb_last_draft'
  let draftTimer: ReturnType<typeof setTimeout> | null = null

  function snapshotDraft(): PromptBuilderDraft {
    const subjectSnapshot = subject.value.kind === 'popular'
      ? {
          subject: 'popular' as const,
          characterId: subject.value.characterId,
          outfitId: subject.value.outfitId,
          blueprintId: subject.value.blueprintId,
          noLora: true,
        }
      : { subject: 'studio' as const, noLora: false }
    return {
      updatedAt: Date.now(),
      story: story.value,
      visualDescription: visualDescription.value,
      char: char.value,
      sceneId: sceneId.value,
      sceneTitle: activeScene.value?.title ?? null,
      selections: { emotion: [...selections.emotion], shot: selections.shot, lighting: selections.lighting, composition: selections.composition },
      colorMood: colorMood.value,
      manualTags: [...manualTags.value],
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

  function applyDraft(d: PromptBuilderDraft) {
    if (typeof d.story === 'string') story.value = d.story
    if (typeof d.visualDescription === 'string') visualDescription.value = d.visualDescription
    if (d.char) char.value = d.char
    if (d.sceneId !== undefined) {
      sceneId.value = d.sceneId
      const currentScene = scenes.value.find(s => s.id === d.sceneId)
      if (currentScene) {
        lastRecommendedSize.value = sceneRecommendedSize(currentScene)
        // 场景未被用户魔改时，镜头与推荐配置自动跟随最新场景定义更新，避免旧草稿锁死过时机位
        const isUnmodifiedScene = (!d.story || d.story === currentScene.story) && (d.sceneBaseStory === currentScene.story || !d.sceneBaseStory)
        if (isUnmodifiedScene) {
          sceneBaseStory.value = currentScene.story ?? ''
          story.value = currentScene.story ?? story.value
          selections.shot = sceneShot(currentScene)
          selections.lighting = sceneLighting(currentScene)
          selections.composition = sceneComposition(currentScene)
          colorMood.value = sceneColorMood(currentScene)
          applySharedDraft(d)
          return
        }
      }
    }
    if (d.sceneBaseStory !== undefined) sceneBaseStory.value = d.sceneBaseStory
    if (d.selections) {
      selections.emotion = d.selections.emotion ?? []
      selections.shot = d.selections.shot ?? null
      selections.lighting = d.selections.lighting ?? null
      selections.composition = d.selections.composition ?? null
    }
    if (typeof d.colorMood === 'string' || d.colorMood === null) colorMood.value = d.colorMood
    applySharedDraft(d)
  }

  function applySharedDraft(d: PromptBuilderDraft) {
    if (d.manualTags) manualTags.value = new Set(d.manualTags)
    artistStyleIds.value = normalizeArtistStyleIds(d.artistStyleIds)
    if (d.directorMode) directorMode.value = d.directorMode
    if (d.sdParams) Object.assign(sdParams, d.sdParams)
    // 2026-08-16 审计：恢复草稿时同步重建 touched 集合——否则恢复的用户参数会被
    // 后续 applyModelProfile（切底模/引擎等）当默认值静默覆盖。缺省（旧草稿）
    // 保持原行为：不标记任何键。
    if (Array.isArray(d.sdParamsTouched) && d.sdParamsTouched.length) {
      sdParamsTouched.value = new Set(d.sdParamsTouched.filter(isSDParamKey))
    }
    if (typeof d.projectId === 'string') projectId.value = d.projectId
    if (d.subject === 'popular' && d.characterId && d.outfitId) {
      subject.value = { kind: 'popular', characterId: d.characterId, outfitId: d.outfitId, blueprintId: d.blueprintId ?? null }
    } else {
      subject.value = { kind: 'studio' }
    }
  }

  function saveDraft() {
    if (!dataReady.value) return
    if (draftTimer) clearTimeout(draftTimer)
    draftTimer = setTimeout(() => {
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify(snapshotDraft()))
      } catch (e) {
        // 2026-08-30 UX 审计：原先 catch {} 静默吞掉。配额写满时界面一切正常、
        // 用户以为草稿已存，刷新即丢——必须让失败可感知并给出补救动作。
        console.warn('[draft] 草稿写入失败', e)
        flash(storageWriteMessage(e, '草稿'))
      }
    }, 280)
  }

  function restoreDraft(): boolean {
    try {
      const raw = localStorage.getItem(DRAFT_KEY)
      if (!raw) return false
      const d = parsePromptBuilderDraft(JSON.parse(raw))
      if (!d) return false
      applyDraft(d)
      return true
    } catch { return false }
  }


  onScopeDispose(() => { if (draftTimer) clearTimeout(draftTimer) })
  return { snapshotDraft, saveDraft, restoreDraft }
}
