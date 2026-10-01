import { normalizeNewArtworkProject, type ArtworkProjectDraft } from '../../application/artwork/projects.ts'
import type { ArtworkProjectRecord } from '../../application/artwork/artworkRepository.ts'
import { ARTWORK_PROJECTS_KEY, comparableId, record, type ArtworkKvAdapter } from './artworkStorage.ts'

export function createArtworkProjects(kv: ArtworkKvAdapter, enqueue: <T>(work: () => Promise<T>) => Promise<T>) {
  async function createProject(input: ArtworkProjectDraft): Promise<ArtworkProjectRecord> {
    const project = normalizeNewArtworkProject(input)
    return enqueue(async () => {
      const raw = await kv.get(ARTWORK_PROJECTS_KEY)
      const projects: unknown[] = structuredClone(Array.isArray(raw) ? raw : [])
      const existing = projects.map(record).find(value => comparableId(value?.id) === project.id)
      if (existing) {
        if (existing.title !== project.title) throw new Error('画册编号已被使用，请重新读取')
        return structuredClone(existing) as ArtworkProjectRecord
      }
      try { await kv.set(ARTWORK_PROJECTS_KEY, [...projects, project]) }
      catch (error) {
        // Reconcile a lost acknowledgement from the same authority, under its write lock.
        const saved = await kv.get(ARTWORK_PROJECTS_KEY).catch(() => null)
        if (!Array.isArray(saved) || !saved.some(value => {
          const candidate = record(value)
          return candidate?.id === project.id && candidate.title === project.title
        })) throw error
      }
      return structuredClone(project)
    })
  }
  return { createProject }
}
