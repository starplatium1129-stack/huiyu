import { collectLiveLocalSettings, ARTWORK_HISTORY_KV_KEY, ARTWORK_PROJECTS_KV_KEY, TEMP_RESULT_KEY, VIDEO_CONTEXT_KEY, VIDEO_SHOTS_CONTEXT_KEY, VIDEO_DRAFT_KEY, VIDEO_SHOTS_DRAFT_KEY, BATCH_DRAW_PLAN_KEY } from './storageKeys.ts'
import { readLocalImageImportJournal } from '../storage/localImageImportJournal.ts'

/** Cleanup-only reader: canonical import decoding also verifies each journal key.
 * Unknown/corrupt intents never become an empty set of protected originals. */
export function readLocalImageReferences(storage: Parameters<typeof collectLiveLocalSettings>[0]): unknown[] {
  const journal = readLocalImageImportJournal(storage)
  if (journal.error) throw new Error(journal.error)
  const values = Object.values(collectLiveLocalSettings(storage))
  for (const key of [ARTWORK_HISTORY_KV_KEY, ARTWORK_PROJECTS_KV_KEY]) {
    const raw = storage.getItem(key)
    if (raw) values.push(raw)
  }
  return [...journal.entries, ...values.map(value => {
    try { return JSON.parse(value) } catch {
      if (/^\s*[\[{]/.test(value)) throw new Error('本地创作设置无法读取，已停止清理以保护原图')
      return value
    }
  })]
}

export function readSessionImageReferences(storage: Pick<Storage, 'getItem'>): unknown[] {
  return [TEMP_RESULT_KEY, VIDEO_CONTEXT_KEY, VIDEO_SHOTS_CONTEXT_KEY, VIDEO_DRAFT_KEY, VIDEO_SHOTS_DRAFT_KEY, BATCH_DRAW_PLAN_KEY].map(key => {
    const raw = storage.getItem(key)
    if (!raw) return null
    try { return JSON.parse(raw) } catch { throw new Error('创作草稿无法读取，已停止清理以保护原图') }
  })
}
