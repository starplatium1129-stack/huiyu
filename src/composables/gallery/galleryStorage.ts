import { artworkRepository } from '@/storage/artworkRepository'
import type { useGalleryWorkspace } from './useGalleryWorkspace'
import { parseSmartAlbumRule, type SmartAlbumRule } from '@/application/artwork/smartAlbums'
import type { ArtworkProjectRecord } from '@/application/artwork/artworkRepository'

export interface GalleryProject {
  id: string
  recordId?: string | number
  title: string
  history_ids: Array<string | number>
  smartRule?: SmartAlbumRule
}

export function galleryProjects(records: ArtworkProjectRecord[]): GalleryProject[] {
  return records.flatMap(project => {
    const smartRule = Object.hasOwn(project, 'smartRule') ? parseSmartAlbumRule(project.smartRule) : undefined
    // A damaged rule must never turn into a manual album with stale membership.
    if (smartRule === null) return []
    return [{ id: String(project.id), recordId: project.id, title: String(project.title || project.name || project.id),
      history_ids: Array.isArray(project.history_ids) ? project.history_ids.filter((id): id is string | number => typeof id === 'string' || typeof id === 'number') : [],
      ...(smartRule ? { smartRule } : {}) }]
  })
}

const loadVersions = new WeakMap<object, number>()

export async function loadGalleryStorageAction({ galleryLoading, galleryError, history, projects }: Pick<ReturnType<typeof useGalleryWorkspace>, 'galleryLoading' | 'galleryError' | 'history' | 'projects'>): Promise<void> {
  const version = (loadVersions.get(history) || 0) + 1
  loadVersions.set(history, version)
  const isCurrent = () => loadVersions.get(history) === version
  galleryLoading.value = true
  galleryError.value = ''
  try {
    const snapshot = await artworkRepository.readLibrarySnapshot()
    if (!isCurrent()) return
    history.value = snapshot.history
    projects.value = galleryProjects(snapshot.projects)
  } catch (error) {
    if (isCurrent()) galleryError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (isCurrent()) galleryLoading.value = false
  }
}
