import { kvInit } from '../../composables/useKVStore.ts'
import { preferenceHistoryRows } from '../../application/artwork/preferenceHistory.ts'
import { searchArtworkRecords } from '../../application/artwork/searchIndex.ts'
import { parseArtworkRecords } from '../../types/artwork.ts'
import type { ArtworkProjectRecord } from '../../application/artwork/artworkRepository.ts'
import { type ArtworkKvAdapter, ARTWORK_HISTORY_KEY, ARTWORK_PROJECTS_KEY, record } from './artworkStorage.ts'

function parseProjects(value: unknown): ArtworkProjectRecord[] {
  return Array.isArray(value) ? value.filter((item): item is ArtworkProjectRecord => {
    const project = record(item)
    return Boolean(project && (typeof project.id === 'string' || typeof project.id === 'number'))
  }) : []
}

/** Legacy read/import policies remain distinct until the supported old sources retire in R11. */
export function createArtworkReads(kv: ArtworkKvAdapter,
  withMutation: <T>(work: () => Promise<T>) => Promise<T>) {
  function readLocal(key: string): unknown {
    try { return JSON.parse(globalThis.localStorage.getItem(key) || 'null') }
    catch { return null }
  }

  async function readHistory(signal?: AbortSignal) {
    signal?.throwIfAborted()
    const raw = await kv.get(ARTWORK_HISTORY_KEY)
    signal?.throwIfAborted()
    return structuredClone(parseArtworkRecords(raw))
  }

  async function readArtwork(id: string | number, signal?: AbortSignal) {
    signal?.throwIfAborted()
    if (!parseArtworkRecords([{ id }]).length) throw new Error('作品编号无效')
    const raw = await kv.get(ARTWORK_HISTORY_KEY)
    signal?.throwIfAborted()
    const found = parseArtworkRecords(raw).find(item => String(item.id).trim() === String(id).trim())
    return found ? structuredClone(found) : null
  }

  async function searchArtworks(query: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const raw = await kv.get(ARTWORK_HISTORY_KEY)
    signal?.throwIfAborted()
    return searchArtworkRecords(raw, query)
  }

  async function readProjects() {
    let raw = await kv.get(ARTWORK_PROJECTS_KEY)
    if (!Array.isArray(raw)) raw = await kv.get('aics_projects')
    return structuredClone(parseProjects(raw))
  }

  async function readLibrarySnapshot() {
    await kvInit()
    return withMutation(async () => {
      let history = await kv.get(ARTWORK_HISTORY_KEY)
      let projects = await kv.get(ARTWORK_PROJECTS_KEY)
      if (!history) {
        history = readLocal(ARTWORK_HISTORY_KEY)
        if (Array.isArray(history) && history.length) {
          await kv.set(ARTWORK_HISTORY_KEY, history)
          globalThis.localStorage.removeItem(ARTWORK_HISTORY_KEY)
        }
      }
      if (!projects) {
        projects = readLocal(ARTWORK_PROJECTS_KEY)
        if (Array.isArray(projects) && projects.length) {
          await kv.set(ARTWORK_PROJECTS_KEY, projects)
          globalThis.localStorage.removeItem(ARTWORK_PROJECTS_KEY)
        }
      }
      if (!projects) {
        let legacy = await kv.get('aics_projects').catch(() => null)
        if (!legacy) legacy = readLocal('aics_projects')
        if (Array.isArray(legacy) && legacy.length) {
          projects = legacy
          await kv.set(ARTWORK_PROJECTS_KEY, legacy)
          globalThis.localStorage.removeItem('aics_projects')
        }
      }
      return structuredClone({ history: parseArtworkRecords(history), projects: parseProjects(projects) })
    })
  }

  async function readRecentHistory(signal?: AbortSignal) {
    signal?.throwIfAborted()
    return withMutation(async () => {
      signal?.throwIfAborted()
      const raw = await kv.get(ARTWORK_HISTORY_KEY)
      signal?.throwIfAborted()
      if (raw !== null) return structuredClone(parseArtworkRecords(raw))
      const legacy = parseArtworkRecords(readLocal(ARTWORK_HISTORY_KEY))
      if (legacy.length) {
        await kv.set(ARTWORK_HISTORY_KEY, legacy)
        globalThis.localStorage.removeItem(ARTWORK_HISTORY_KEY)
      }
      signal?.throwIfAborted()
      return structuredClone(legacy)
    })
  }

  async function readPreferenceHistory(): Promise<unknown[]> {
    try {
      await kvInit()
      const history = await kv.get(ARTWORK_HISTORY_KEY)
      if (Array.isArray(history)) return preferenceHistoryRows(history)
    } catch { /* This legacy read-only recommendation path permits a local fallback. */ }
    const fallback = readLocal(ARTWORK_HISTORY_KEY)
    return preferenceHistoryRows(fallback)
  }

  return { readHistory, readArtwork, searchArtworks, readProjects, readLibrarySnapshot, readRecentHistory, readPreferenceHistory }
}
