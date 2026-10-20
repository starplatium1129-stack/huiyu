/** Stable provenance shared by drawing drafts, artworks and storyboard rows. */
export interface StoryOrigin {
  scenarioId: string
  actId: string
  title: string
  characterId: string
  outfitId?: string
  outfitProse?: string
}
export function readStoryOrigin(value: unknown): StoryOrigin | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const v = value as Record<string, unknown>
  if (!['scenarioId', 'actId', 'title', 'characterId'].every(key => typeof v[key] === 'string' && v[key] && (v[key] as string).length <= 200)) return
  return { scenarioId: v.scenarioId as string, actId: v.actId as string, title: v.title as string,
    characterId: v.characterId as string, ...(typeof v.outfitId === 'string' && v.outfitId.length <= 200 ? { outfitId: v.outfitId } : {}),
    ...(typeof v.outfitProse === 'string' && v.outfitProse.length <= 2000 ? { outfitProse: v.outfitProse } : {}) }
}
export function storyOriginRoute(origin: StoryOrigin) {
  return { path: '/scenario', query: { scenario: origin.scenarioId, acts: origin.actId,
    ...(['nene','natsume'].includes(origin.characterId) ? { char: origin.characterId } : { cast: origin.characterId, outfit: origin.outfitId }) } }
}
