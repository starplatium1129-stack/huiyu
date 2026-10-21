import { normalizeNewArtworkProject, type ArtworkProjectDraft } from '../../application/artwork/projects.ts'
import type { ArtworkProjectRecord } from '../../application/artwork/artworkRepository.ts'
import { ARTWORK_PROJECTS_KEY, comparableId, record, type ArtworkKvAdapter } from './artworkStorage.ts'
import { normalizeSmartAlbumDraft, normalizeSmartAlbumRemoval, shouldDeleteSmartAlbum, shouldWriteSmartAlbum, type SmartAlbumDraft, type SmartAlbumRemoval } from '../../application/artwork/smartAlbums.ts'

export function createArtworkProjects(kv: ArtworkKvAdapter, enqueue: <T>(work: () => Promise<T>) => Promise<T>) {
  async function write(projects: unknown[]) {
    try { await kv.set(ARTWORK_PROJECTS_KEY, projects) }
    catch (error) {
      const saved = await kv.get(ARTWORK_PROJECTS_KEY).catch(() => null)
      if (JSON.stringify(saved) !== JSON.stringify(projects)) throw error
    }
  }
  async function createProject(input: ArtworkProjectDraft): Promise<ArtworkProjectRecord> {
    const project = normalizeNewArtworkProject(input)
    return enqueue(async () => {
      const raw = await kv.get(ARTWORK_PROJECTS_KEY)
      const projects: unknown[] = structuredClone(Array.isArray(raw) ? raw : [])
      const existing = projects.map(record).find(value => comparableId(value?.id) === project.id)
      if (existing) {
        if (Object.hasOwn(existing, 'smartRule') || existing.title !== project.title) throw new Error('画册编号已被使用，请重新读取')
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
  function saveSmartAlbum(input: SmartAlbumDraft): Promise<ArtworkProjectRecord> {
    const draft = normalizeSmartAlbumDraft(input)
    return enqueue(async () => {
      const raw = await kv.get(ARTWORK_PROJECTS_KEY)
      const projects: unknown[] = structuredClone(Array.isArray(raw) ? raw : [])
      const index = projects.findIndex(value => comparableId(record(value)?.id) === draft.id)
      if (projects.filter(value => comparableId(record(value)?.id) === draft.id).length > 1) throw new Error('画册编号存在冲突，请重新读取')
      const existing = index < 0 ? null : record(projects[index])
      if (!shouldWriteSmartAlbum(existing, draft)) return structuredClone(existing!) as ArtworkProjectRecord
      if (draft.rule.projectId) {
        const manual = projects.map(record).find(value => comparableId(value?.id) === draft.rule.projectId)
        if (!manual || Object.hasOwn(manual, 'smartRule') || draft.rule.projectId === draft.id) throw new Error('智能画册只能筛选已有的手动画册')
      }
      const originalId = existing?.id
      const id = typeof originalId === 'string' || (typeof originalId === 'number' && Number.isFinite(originalId)) ? originalId : draft.id
      const project: ArtworkProjectRecord = { ...existing, id, title: draft.title, history_ids: [], smartRule: draft.rule }
      if (index < 0) projects.push(project)
      else projects[index] = project
      await write(projects)
      return structuredClone(project)
    })
  }
  function deleteSmartAlbum(input: SmartAlbumRemoval): Promise<{ deleted: boolean }> {
    const removal = normalizeSmartAlbumRemoval(input)
    return enqueue(async () => {
      const raw = await kv.get(ARTWORK_PROJECTS_KEY)
      const projects: unknown[] = structuredClone(Array.isArray(raw) ? raw : [])
      const matches = projects.map(record).filter(value => comparableId(value?.id) === removal.id)
      if (matches.length > 1) throw new Error('画册编号存在冲突，请重新读取')
      const existing = matches[0]
      if (!shouldDeleteSmartAlbum(existing, removal)) return { deleted: false }
      await write(projects.filter(value => comparableId(record(value)?.id) !== removal.id))
      return { deleted: true }
    })
  }
  return { createProject, saveSmartAlbum, deleteSmartAlbum }
}
