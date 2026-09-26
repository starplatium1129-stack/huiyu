import { kvInit } from '../../composables/useKVStore.ts'
import { parseArtworkRecords } from '../../types/artwork.ts'
import type { ArtworkProjectRecord } from '../../application/artwork/artworkRepository.ts'
import { type ArtworkKvAdapter, type WebArtworkRepositoryDependencies, ARTWORK_HISTORY_KEY, ARTWORK_PROJECTS_KEY, record } from './artworkStorage.ts'

function parseProjects(value: unknown): ArtworkProjectRecord[] {
  return Array.isArray(value) ? value.filter((item): item is ArtworkProjectRecord => {
    const project = record(item)
    return Boolean(project && (typeof project.id === 'string' || typeof project.id === 'number'))
  }) : []
}

/** Legacy read/import policies remain distinct until the supported old sources retire in R11. */
export function createArtworkReads(kv: ArtworkKvAdapter, dependencies: WebArtworkRepositoryDependencies,
  withMutation: <T>(work: () => Promise<T>) => Promise<T>) {
  const local = () => dependencies.localStorage ?? (dependencies.kv ? undefined : globalThis.localStorage)
  function readLocal(key: string): unknown {
    try { return JSON.parse(local()?.getItem(key) || 'null') }
    catch { return null }
  }

  async function readHistory() {
    return structuredClone(parseArtworkRecords(await kv.get(ARTWORK_HISTORY_KEY)))
  }

  async function readProjects() {
    let raw = await kv.get(ARTWORK_PROJECTS_KEY)
    if (!Array.isArray(raw)) raw = await kv.get('aics_projects')
    return structuredClone(parseProjects(raw))
  }

  async function readLibrarySnapshot() {
    if (!dependencies.kv) await kvInit()
    return withMutation(async () => {
      let history = await kv.get(ARTWORK_HISTORY_KEY)
      let projects = await kv.get(ARTWORK_PROJECTS_KEY)
      if (!history) {
        history = readLocal(ARTWORK_HISTORY_KEY)
        if (Array.isArray(history) && history.length) {
          await kv.set(ARTWORK_HISTORY_KEY, history)
          local()?.removeItem(ARTWORK_HISTORY_KEY)
        }
      }
      if (!projects) {
        projects = readLocal(ARTWORK_PROJECTS_KEY)
        if (Array.isArray(projects) && projects.length) {
          await kv.set(ARTWORK_PROJECTS_KEY, projects)
          local()?.removeItem(ARTWORK_PROJECTS_KEY)
        }
      }
      if (!projects) {
        let legacy = await kv.get('aics_projects').catch(() => null)
        if (!legacy) legacy = readLocal('aics_projects')
        if (Array.isArray(legacy) && legacy.length) {
          projects = legacy
          await kv.set(ARTWORK_PROJECTS_KEY, legacy)
          local()?.removeItem('aics_projects')
        }
      }
      return structuredClone({ history: parseArtworkRecords(history), projects: parseProjects(projects) })
    })
  }

  function readRecentHistory() {
    return withMutation(async () => {
      const current = parseArtworkRecords(await kv.get(ARTWORK_HISTORY_KEY))
      if (current.length) return structuredClone(current)
      const legacy = parseArtworkRecords(readLocal(ARTWORK_HISTORY_KEY))
      if (legacy.length) {
        await kv.set(ARTWORK_HISTORY_KEY, legacy)
        local()?.removeItem(ARTWORK_HISTORY_KEY)
      }
      return structuredClone(legacy)
    })
  }

  async function readPreferenceHistory(): Promise<unknown[]> {
    try {
      if (!dependencies.kv) await kvInit()
      const history = await kv.get(ARTWORK_HISTORY_KEY)
      if (Array.isArray(history)) return structuredClone(history)
    } catch { /* This legacy read-only recommendation path permits a local fallback. */ }
    const fallback = readLocal(ARTWORK_HISTORY_KEY)
    return structuredClone(Array.isArray(fallback) ? fallback : [])
  }

  return { readHistory, readProjects, readLibrarySnapshot, readRecentHistory, readPreferenceHistory }
}
