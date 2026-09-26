import { artworkRepository } from '@/storage/artworkRepository'
import type { useGalleryWorkspace } from './useGalleryWorkspace'

export interface GalleryProject {
  id: string
  title: string
  history_ids: Array<string | number>
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
    projects.value = snapshot.projects.map(project => ({
      id: String(project.id),
      title: String(project.title || project.name || project.id),
      history_ids: Array.isArray(project.history_ids)
        ? project.history_ids.filter((id): id is string | number => typeof id === 'string' || typeof id === 'number')
        : [],
    }))
  } catch (error) {
    if (isCurrent()) galleryError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (isCurrent()) galleryLoading.value = false
  }
}
