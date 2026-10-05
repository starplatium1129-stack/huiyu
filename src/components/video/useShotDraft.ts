import { onBeforeUnmount, watch, type Ref } from 'vue'
import type { VideoBatch, VideoQuality } from '@/api/videoApi'
import type { ShotDraft } from './shotListTypes'
import type { ReferenceCard } from './useReferenceCards'
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
  selectCardCharacter: (id: string, index?: number, outfit?: string) => Promise<boolean>
  retryPendingFrames: () => Promise<{ fixed: number; remaining: number }>
}

export function useShotDraft(deps: ShotDraftDeps) {
  const { aspectRatio, quality, steps, linkLastFrame, identityCard, referenceCards, shots,
    batchError, selectCardCharacter, retryPendingFrames } = deps
  const videoStore = useVideoStore()
let restoringDraft = false
let shotsDraftTimer = 0
let saveFailed = false

function persistShotsDraft() {
  if (restoringDraft) return
  window.clearTimeout(shotsDraftTimer); shotsDraftTimer = 0
  const ok = videoStore.saveShotsDraft({
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
    })),
    updatedAt: Date.now(),
  })
  if (!ok) batchError.value = '分镜草稿保存失败（存储空间不足）：内容仍在页面中，但刷新后可能丢失'
  saveFailed = !ok
}
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

/** 草稿水合：角色与服装资料恢复→ 首帧重挂载 → 身份锚点以草稿为准。 */
async function restoreShotsDraft() {
  const draft = videoStore.shotsDraft
  if (!draft || (!draft.shots.length && !draft.identityCard && !draft.cards.length)) return
  restoringDraft = true
  try {
    if (draft.aspectRatio === 'landscape' || draft.aspectRatio === 'portrait' || draft.aspectRatio === 'square') aspectRatio.value = draft.aspectRatio
    if (draft.quality === 'fast' || draft.quality === 'standard' || draft.quality === 'fine') quality.value = draft.quality
    if (draft.steps === 4 || draft.steps === 8) steps.value = draft.steps
    linkLastFrame.value = draft.linkLastFrame !== false
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
    }))
    shots.value.forEach((shot, index) => deps.restoreShotSubmission(shot, draft.shots[index]?.submission))
  } finally {
    restoringDraft = false
  }
  // 从内容目录恢复角色和服装；参考图片不再从固定图库自动装配。
  for (const [index, card] of referenceCards.value.entries()) {
    if (card.characterId) await selectCardCharacter(card.characterId, index, card.outfitId || undefined)
  }
  // 身份锚点以草稿为准（用户可能手改过），卡装配的合并结果不覆盖它。
  if (draft.identityCard) identityCard.value = draft.identityCard
  // 首帧重挂载：失效图保留镜头文本并明示，可逐镜重试（F1 验收第 3 条）。
  const { remaining } = await retryPendingFrames()
  if (remaining) {
    batchError.value = `${remaining} 张首帧暂未挂载：镜头文本与图片引用已保留，可在镜头上重试或重新上传`
  }
}


  onBeforeUnmount(() => {
    releaseMaintenance()
    window.clearTimeout(shotsDraftTimer)
    persistShotsDraft()
  })
  return { restoreShotsDraft, persistShotsDraft }
}
