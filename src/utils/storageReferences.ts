import { collectLiveLocalSettings, ARTWORK_HISTORY_KV_KEY, ARTWORK_PROJECTS_KV_KEY, TEMP_RESULT_KEY, VIDEO_CONTEXT_KEY, VIDEO_SHOTS_CONTEXT_KEY, VIDEO_DRAFT_KEY, VIDEO_SHOTS_DRAFT_KEY } from './storageKeys.ts'

/** Conservatively protect every stored image ID mentioned by persisted drafts, projects or trash. */
export function collectImageReferences(values: unknown[]): Set<string> {
  const references = new Set<string>()
  const visit = (value: unknown) => {
    if (typeof value === 'string') references.add(value)
    else if (Array.isArray(value)) value.forEach(visit)
    else if (value && typeof value === 'object') Object.values(value).forEach(visit)
  }
  values.forEach(visit)
  return references
}

export function readSessionImageReferences(storage: Pick<Storage, 'getItem'>): unknown[] {
  return [TEMP_RESULT_KEY, VIDEO_CONTEXT_KEY, VIDEO_SHOTS_CONTEXT_KEY, VIDEO_DRAFT_KEY, VIDEO_SHOTS_DRAFT_KEY].map(key => {
    const raw = storage.getItem(key)
    if (!raw) return null
    try { return JSON.parse(raw) } catch { throw new Error('创作草稿无法读取，已停止清理以保护原图') }
  })
}

/** Include legacy metadata too: an unfinished migration must never make a live
 * image appear orphaned. Malformed structured drafts fail closed before deletion.
 */
export function readLocalImageReferences(storage: Parameters<typeof collectLiveLocalSettings>[0]): unknown[] {
  const values = Object.values(collectLiveLocalSettings(storage))
  for (const key of [ARTWORK_HISTORY_KV_KEY, ARTWORK_PROJECTS_KV_KEY]) {
    const raw = storage.getItem(key)
    if (raw) values.push(raw)
  }
  return values.map(value => {
    try { return JSON.parse(value) } catch {
      if (/^\s*[\[{]/.test(value)) throw new Error('本地创作设置无法读取，已停止清理以保护原图')
      return value
    }
  })
}
