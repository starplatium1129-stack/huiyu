import { onActivated, onBeforeUnmount, onDeactivated, watch, type Ref } from 'vue'
import type { VideoBatch, VideoQuality } from '@/api/videoApi'
import type { ShotDraft } from './shotListTypes'
import type { ReferenceCard, useReferenceCards } from './useReferenceCards'
import { useVideoStore, type ShotSubmissionRecord } from '@/stores/videoStore'
import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'

interface ShotDraftDeps {
  aspectRatio: Ref<VideoBatch['aspectRatio']>
  quality: Ref<VideoQuality>
  steps: Ref<4 | 8>
  linkLastFrame: Ref<boolean>
  identityCard: Ref<string>
  referenceCards: Ref<ReferenceCard[]>
  shots: Ref<ShotDraft[]>
  batchError: Ref<string>
  getShotSubmission: (shot: ShotDraft) => ShotSubmissionRecord | undefined
  restoreShotSubmission: (shot: ShotDraft, submission: ShotSubmissionRecord | undefined) => void
  selectCardCharacter: ReturnType<typeof useReferenceCards>['selectCardCharacter']
  retryPendingFrames: () => Promise<{ fixed: number; remaining: number } | null>
}

export function useShotDraft(deps: ShotDraftDeps) {
  const { aspectRatio, quality, steps, linkLastFrame, identityCard, referenceCards, shots,
    batchError, selectCardCharacter, retryPendingFrames } = deps
  const videoStore = useVideoStore()
let restoringDraft = false
let shotsDraftTimer = 0
let saveFailed = false
let disposed = false
let active = true, framesPending = false
let frameRestore: Promise<void> | null = null
const submissionTokens = new WeakMap<ShotDraft, string>()
let scenarioImportReceipts: string[] = []

function persistShotsDraft(sourceActIds: readonly string[] = []): boolean {
  if (restoringDraft || disposed) return false
  window.clearTimeout(shotsDraftTimer); shotsDraftTimer = 0
  const pendingIds = new Set(videoStore.pendingScenarioActs.map(act => act.importId))
  const receipts = [...new Set([...scenarioImportReceipts, ...sourceActIds])].filter(id => pendingIds.has(id))
  const ok = videoStore.saveShotsDraft({
    ...(receipts.length ? { scenarioImportReceipts: receipts } : {}),
    aspectRatio: aspectRatio.value,
    quality: quality.value,
    steps: steps.value,
    linkLastFrame: linkLastFrame.value,
    identityCard: identityCard.value,
    cards: referenceCards.value.map(card => ({
      label: card.label,
      characterId: card.characterId || '',
      outfitId: card.outfitId || '',
    })),
    shots: shots.value.map(shot => ({
      submission: deps.getShotSubmission(shot),
      submissionToken: submissionTokens.get(shot),
      prompt: shot.prompt,
      dialogue: shot.dialogue,
      shotSize: shot.shotSize,
      camera: shot.camera,
      motion: shot.motion,
      duration: shot.duration,
      seedText: shot.seedText,
      cast: shot.cast,
      firstFramePrompt: shot.firstFramePrompt,
      imageId: shot.imageId || '',
      importSourceImageId: shot.importSourceImageId,
      importSourceActId: shot.importSourceActId,
    })),
    updatedAt: Date.now(),
  })
  if (!ok) batchError.value = '分镜草稿保存失败（存储空间不足）：内容仍在页面中，但刷新后可能丢失'
  saveFailed = !ok
  if (ok) scenarioImportReceipts = receipts
  return ok
}
// Tokens belong to submitted row objects, not editable fields; clones never inherit them.
function beginShotSubmission(targets: ShotDraft[]) {
  targets.forEach(shot => submissionTokens.set(shot, crypto.randomUUID()))
  persistShotsDraft()
}
function finishShotSubmission(targets: ShotDraft[], batchId?: string) {
  const tokens = new Map(targets.map((shot, shotIndex) => [submissionTokens.get(shot), shotIndex]))
  tokens.delete(undefined)
  if (!batchId) targets.forEach(shot => submissionTokens.delete(shot))
  const saved = videoStore.shotsDraft
  if (saved?.shots.some(shot => shot.submissionToken && tokens.has(shot.submissionToken))) {
    const ok = videoStore.saveShotsDraft({ ...saved, updatedAt: Date.now(), shots: saved.shots.map(shot => {
      const shotIndex = shot.submissionToken ? tokens.get(shot.submissionToken) : undefined
      if (shotIndex === undefined) return shot
      return batchId ? { ...shot, submission: { batchId, shotIndex } } : { ...shot, submissionToken: undefined }
    }) })
    if (!ok) batchError.value = '分镜来源保存失败，请在任务中心保留并核对批次。'
  }
  if (!disposed) persistShotsDraft()
}
// A reopened owner must adopt acceptance before its next autosave, even after edits/reorder.
watch(() => videoStore.shotsDraft, (saved, previous) => {
  const retained = new Set(saved?.shots.map(shot => shot.submissionToken))
  const removed = new Set(previous?.shots.map(shot => shot.submissionToken).filter(token => !retained.has(token)))
  const accepted = new Map(saved?.shots.filter(shot => shot.submissionToken && shot.submission)
    .map(shot => [shot.submissionToken, shot.submission]))
  shots.value.forEach(shot => {
    const token = submissionTokens.get(shot)
    if (token && removed.has(token)) submissionTokens.delete(shot)
    if (token && accepted.has(token)) deps.restoreShotSubmission(shot, accepted.get(token))
  })
}, { flush: 'sync' })
const releaseMaintenance = registerMaintenanceParticipant(() => {
  if (restoringDraft) throw new Error('DRAFT_RESTORING')
  if (shotsDraftTimer || saveFailed) persistShotsDraft()
  if (saveFailed) throw new Error('DRAFT_SAVE_FAILED')
})

watch(
  [shots, identityCard, aspectRatio, quality, steps, linkLastFrame, referenceCards],
  () => {
    window.clearTimeout(shotsDraftTimer)
    shotsDraftTimer = window.setTimeout(persistShotsDraft, 350)
  },
  { deep: true },
)

/** 先同步水合可编辑草稿；补读角色资料不覆盖身份描述，再重挂首帧。 */
async function restoreShotsDraft() {
  const draft = videoStore.shotsDraft
  scenarioImportReceipts = Array.isArray(draft?.scenarioImportReceipts)
    ? draft.scenarioImportReceipts.filter(id => typeof id === 'string' && id) : []
  if (!draft || (!draft.shots.length && !draft.identityCard && !draft.cards.length)) return
  restoringDraft = true
  try {
    if (draft.aspectRatio === 'landscape' || draft.aspectRatio === 'portrait' || draft.aspectRatio === 'square') aspectRatio.value = draft.aspectRatio
    if (draft.quality === 'fast' || draft.quality === 'standard' || draft.quality === 'fine') quality.value = draft.quality
    if (draft.steps === 4 || draft.steps === 8) steps.value = draft.steps
    linkLastFrame.value = draft.linkLastFrame !== false
    identityCard.value = draft.identityCard
    if (draft.cards.length) {
      referenceCards.value = draft.cards.map(card => ({
        label: card.label,
        characterId: card.characterId || undefined,
        outfitId: card.outfitId || undefined,
        images: [],
      }))
    }
    shots.value = draft.shots.map(shot => ({
      prompt: shot.prompt,
      dialogue: shot.dialogue,
      shotSize: (shot.shotSize || '') as ShotDraft['shotSize'],
      camera: (shot.camera || 'still') as ShotDraft['camera'],
      motion: (shot.motion || 'subtle') as ShotDraft['motion'],
      duration: ([3, 5, 10, 15].includes(shot.duration) ? shot.duration : 5) as ShotDraft['duration'],
      seedText: shot.seedText || '',
      imageName: '',
      imageUrl: '',
      cast: (shot.cast || '') as ShotDraft['cast'],
      firstFramePrompt: shot.firstFramePrompt,
      imageId: shot.imageId || '',
      importSourceImageId: typeof shot.importSourceImageId === 'string' && shot.importSourceImageId
        ? shot.importSourceImageId : undefined,
      importSourceActId: typeof shot.importSourceActId === 'string' && shot.importSourceActId
        ? shot.importSourceActId : undefined,
    }))
    shots.value.forEach((shot, index) => {
      const saved = draft.shots[index]
      deps.restoreShotSubmission(shot, saved?.submission)
      if (typeof saved?.submissionToken === 'string' && saved.submissionToken) submissionTokens.set(shot, saved.submissionToken)
    })
  } finally {
    restoringDraft = false
  }
  // 从内容目录恢复角色和服装；参考图片不再从固定图库自动装配。
  // 同时启动水合，避免等前一卡读完才重置用户已编辑的后一张卡。
  await Promise.all(referenceCards.value.map((card, index) => card.characterId
    ? selectCardCharacter(card.characterId, index, card.outfitId || undefined, undefined, { preserveIdentity: true })
    : false))
  if (disposed) return
  framesPending = true
  await resumeDraftFrames()
}

function resumeDraftFrames(): Promise<void> | undefined {
  if (disposed || !active || !framesPending || frameRestore) return frameRestore ?? undefined
  let interrupted = false
  frameRestore = (async () => {
    const outcome = await retryPendingFrames()
    interrupted = outcome === null
    if (disposed || !active || !outcome) return
    framesPending = false
    if (outcome.remaining) batchError.value = `${outcome.remaining} 张首帧暂未挂载：镜头文本与图片引用已保留，可在镜头上重试或重新上传`
  })().finally(() => {
    frameRestore = null
    // A quick return can precede the interrupted read settling. Resume once,
    // after its frame request has released ownership; failed frames stay manual.
    if (interrupted && active && !disposed && framesPending) void resumeDraftFrames()
  })
  return frameRestore
}

  onActivated(() => { active = true; void resumeDraftFrames() })
  onDeactivated(() => { active = false })
  onBeforeUnmount(() => {
    releaseMaintenance()
    window.clearTimeout(shotsDraftTimer)
    persistShotsDraft()
    disposed = true
  })
  return { restoreShotsDraft, persistShotsDraft, beginShotSubmission, finishShotSubmission }
}
