import { useVideoStore } from '@/stores/videoStore'
import { VIDEO_SHOTS_DRAFT_KEY } from '@/utils/storageKeys'
import type { captureStudioProjectRepository, StudioProjectSnapshot } from '@/storage/studioProjectRepository'

async function importId(parts: unknown[]): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)))
  const bytes = new Uint8Array(hash).slice(0, 16)
  bytes[6] = (bytes[6]! & 15) | 80
  bytes[8] = (bytes[8]! & 63) | 128
  const digits = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return [digits.slice(0, 8), digits.slice(8, 12), digits.slice(12, 16), digits.slice(16, 20), digits.slice(20)].join(
    '-'
  )
}
export async function importStoryboard(
  repo: ReturnType<typeof captureStudioProjectRepository>,
  data: StudioProjectSnapshot,
  signal: AbortSignal
) {
  const store = useVideoStore()
  await store.confirmDrafts([VIDEO_SHOTS_DRAFT_KEY])
  signal.throwIfAborted()
  repo.assertCurrent()
  const draft = store.shotsDraft
  if (!draft?.shots.length) throw new Error('当前资料库没有已保存的分镜草稿')
  const existing = new Set(data.shots.map((shot) => shot.id)),
    versions = new Set(data.versions.map((version) => version.id))
  const occurrences = new Map<string, number>()
  let count = 0
  for (const [index, shot] of draft.shots.entries()) {
    signal.throwIfAborted()
    repo.assertCurrent()
    const legacy = {
      dialogue: shot.dialogue,
      shotSize: shot.shotSize,
      camera: shot.camera,
      motion: shot.motion,
      duration: shot.duration,
      seedText: shot.seedText,
      cast: shot.cast,
      firstFramePrompt: shot.firstFramePrompt,
      storyOrigin: shot.storyOrigin,
      submission: shot.submission,
      firstFrameRequest: shot.firstFrameRequest,
      identityCard: draft.identityCard,
      cards: draft.cards,
      aspectRatio: draft.aspectRatio,
      quality: draft.quality,
      steps: draft.steps,
      linkLastFrame: draft.linkLastFrame,
    }
    const provenance = JSON.stringify(
      shot.importSourceActId
        ? ['act', shot.importSourceActId]
        : shot.importSourceImageId
          ? ['artwork', shot.importSourceImageId]
          : shot.submissionToken
            ? ['request', shot.submissionToken]
            : ['draft', shot.prompt, shot.imageId, shot.dialogue]
    )
    const occurrence = occurrences.get(provenance) ?? 0
    occurrences.set(provenance, occurrence + 1)
    const id = await importId(['storyboard', data.project.id, provenance, occurrence])
    if (existing.has(id)) continue
    const title = `分镜 ${index + 1}`
    let firstVersionId: string | undefined
    if (shot.imageId) {
      firstVersionId = await importId(['storyboard-frame', data.project.id, shot.imageId])
      if (!versions.has(firstVersionId)) {
        await repo.importAsset({
          title: title + ' 首帧',
          kind: 'keyframe',
          mediaAlias: shot.imageId,
          versionId: firstVersionId,
          source: { kind: 'file', name: '旧分镜首帧' },
        })
        versions.add(firstVersionId)
      }
    }
    signal.throwIfAborted()
    repo.assertCurrent()
    await repo.createShot(data.project.id, title, { id, prompt: shot.prompt, firstVersionId, legacy })
    count++
  }
  return count
}
