export interface ArtworkProjectDraft {
  /** Stable identity lets an uncertain creation retry without making another album. */
  id: string
  title: string
}

export const ARTWORK_PROJECT_TITLE_LIMIT = 120

export function normalizeNewArtworkProject(input: ArtworkProjectDraft) {
  const id = typeof input.id === 'string' ? input.id.trim() : ''
  const title = typeof input.title === 'string' ? input.title.trim() : ''
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(id)) throw new Error('画册编号无效')
  if (!title) throw new Error('请填写画册名称')
  if (title.length > ARTWORK_PROJECT_TITLE_LIMIT) throw new Error('画册名称最多 120 个字符')
  return { id, title, history_ids: [] as Array<string | number> }
}
