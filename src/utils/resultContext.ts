import type { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import type { HistoryEntry } from '@/types/promptHistory'
import type { AnimaResultContext } from '@/types/anima'

/** 提交时取值；只保存可序列化的创作信息，不保存响应式对象或图片。 */
export function captureResultContext(pb: ReturnType<typeof usePromptBuilderStore>): AnimaResultContext {
  const subject = pb.subject
  return {
    characterId: subject.kind === 'popular' ? subject.characterId : '',
    outfitId: subject.kind === 'popular' ? subject.outfitId : null,
    blueprintId: subject.kind === 'popular' ? subject.blueprintId : null,
    sceneId: pb.sceneId,
    story: String(pb.story || '').trim(),
    char: pb.char,
    history: {
      visualDescription: pb.visualDescription,
      emotion: [...pb.selections.emotion], shot: pb.selections.shot,
      lighting: pb.selections.lighting, composition: pb.selections.composition,
      colorMood: pb.colorMood, manual_tags: [...pb.manualTags],
      artistStyleIds: pb.directorMode === 'pro' ? [...pb.artistStyleIds] : [],
      project: pb.projectId,
    },
  }
}

export function historyFromResultContext(ctx?: AnimaResultContext | null): Partial<HistoryEntry> {
  if (!ctx) return {}
  const popular = Boolean(ctx.characterId)
  const history = ctx.history ? JSON.parse(JSON.stringify(ctx.history)) as Partial<HistoryEntry> : {}
  return {
    ...history,
    subject: popular ? 'popular' : 'studio', noLora: popular,
    character: (popular ? ctx.characterId : ctx.char) as HistoryEntry['character'],
    characterId: popular ? ctx.characterId : undefined,
    outfitId: popular ? ctx.outfitId ?? undefined : undefined,
    blueprintId: popular ? ctx.blueprintId ?? undefined : undefined,
    scene: popular ? ctx.blueprintId ?? null : ctx.sceneId ?? null,
    story: ctx.story ?? '',
  }
}
