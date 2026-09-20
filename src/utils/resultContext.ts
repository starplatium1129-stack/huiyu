import type { CharKey, HistoryEntry } from '@/types/promptHistory'
import type { AnimaResultContext } from '@/types/anima'

/** 页面适配传入当前需要的创作字段；普通对象即可，不要求 Store/Pinia。 */
export interface ResultContextInput {
  readonly subject: Readonly<{ kind: 'studio' } | {
    kind: 'popular'; characterId: string; outfitId: string; blueprintId: string | null
  }>
  readonly sceneId: string | null
  readonly story: string
  readonly char: CharKey
  readonly visualDescription: string
  readonly selections: Readonly<{
    emotion: readonly string[]; shot: string | null
    lighting: string | null; composition: string | null
  }>
  readonly colorMood: string | null
  readonly manualTags: ReadonlySet<string> | readonly string[]
  readonly artistStyleIds: readonly string[]
  readonly directorMode: 'basic' | 'pro'
  readonly projectId: string
  readonly activeScene?: { readonly title: string } | null
  readonly popularCharacters?: readonly { readonly id: string; readonly displayName: string }[]
  readonly sceneBlueprints?: readonly { readonly id: string; readonly title: string }[]
}

/** 提交时取值；只保存可序列化的创作信息，不保存响应式对象或图片。 */
export function captureResultContext(pb: ResultContextInput): AnimaResultContext {
  const subject = pb.subject
  const popularName = subject.kind === 'popular'
    ? pb.popularCharacters?.find(character => character.id === subject.characterId)?.displayName : null
  const sceneTitle = subject.kind === 'popular'
    ? (pb.sceneBlueprints?.find(scene => scene.id === subject.blueprintId)?.title
      || (popularName ? popularName + ' 创作' : '热门角色作品'))
    : (pb.activeScene?.title ?? (pb.story ? pb.story.slice(0, 20) : null))
  return {
    characterId: subject.kind === 'popular' ? subject.characterId : '',
    outfitId: subject.kind === 'popular' ? subject.outfitId : null,
    blueprintId: subject.kind === 'popular' ? subject.blueprintId : null,
    sceneId: pb.sceneId,
    story: String(pb.story || '').trim(),
    char: pb.char,
    history: {
      sceneTitle,
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
