import { artworkRepository } from '@/storage/artworkRepository'
import type { useGalleryWorkspace } from './useGalleryWorkspace'
import { parseSmartAlbumRule, type SmartAlbumRule } from '@/application/artwork/smartAlbums'
import { toRaw } from 'vue'
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

function unchangedRecords(current: object[], incoming: object[]): boolean {
  return current.length === incoming.length && toRaw(current).every((record, index) => {
    const previous = toRaw(record) as Record<string, unknown>, next = incoming[index] as Record<string, unknown>
    const keys = Object.keys(previous)
    return keys.length === Object.keys(next).length && keys.every(key => {
      const left = previous[key], right = next[key]
      // Compare large legacy image strings directly, without copying them into
      // another full-library JSON string on each navigation.
      return Object.hasOwn(next, key) && (Object.is(left, right) || (left !== null && right !== null
        && typeof left === 'object' && typeof right === 'object' && JSON.stringify(toRaw(left)) === JSON.stringify(right)))
    })
  })
}

export async function loadGalleryStorageAction({ galleryLoading, galleryError, history, projects }: Pick<ReturnType<typeof useGalleryWorkspace>, 'galleryLoading' | 'galleryError' | 'history' | 'projects'>): Promise<void> {
  const version = (loadVersions.get(history) || 0) + 1
  loadVersions.set(history, version)
  const isCurrent = () => loadVersions.get(history) === version
  // Only an empty workspace needs a blocking placeholder. Refreshes retain the
  // last snapshot (including empty albums) until the latest read succeeds.
  galleryLoading.value = !history.value.length && !projects.value.length
  galleryError.value = ''
  try {
    const snapshot = await artworkRepository.readLibrarySnapshot()
    if (!isCurrent()) return
    // A refresh still reads the authority, but unchanged metadata must not
    // invalidate every filter, album and keyed image card on a cached return.
    if (!unchangedRecords(history.value, snapshot.history)) history.value = snapshot.history
    const nextProjects = galleryProjects(snapshot.projects)
    if (!unchangedRecords(projects.value, nextProjects)) projects.value = nextProjects
  } catch (error) {
    if (isCurrent()) galleryError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (isCurrent()) galleryLoading.value = false
  }
}
