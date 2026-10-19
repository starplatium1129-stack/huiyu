import { artworkRepository } from '@/storage/artworkRepository'
import type { useGalleryWorkspace } from './useGalleryWorkspace'
import { parseSmartAlbumRule, type SmartAlbumRule } from '@/application/artwork/smartAlbums'
import { toRaw } from 'vue'
import type { ArtworkRecord } from '@/types/artwork'
import type { ArtworkLibrarySnapshot, ArtworkProjectRecord } from '@/application/artwork/artworkRepository'
import { artworkIdKey } from './galleryHelpers'

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
const loadControllers = new WeakMap<object, AbortController>()
export function cancelGalleryStorageLoad(history: object) {
  loadControllers.get(history)?.abort(); loadControllers.delete(history)
}

const pendingMutations = new WeakMap<object, Map<string, Pick<ArtworkRecord, 'favorite'> | null>>()

/** Overlay confirmed changes onto an outstanding snapshot; null means deleted. */
export function recordGalleryMutation(history: object, id: string | number, patch: Pick<ArtworkRecord, 'favorite'> | null): void {
  const pending = pendingMutations.get(history)
  const key = artworkIdKey(id)
  if (pending && pending.get(key) !== null) pending.set(key, patch)
}

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

export async function loadGalleryStorageAction({ galleryLoading, galleryIndexLoading, galleryError, history, projects }: Pick<ReturnType<typeof useGalleryWorkspace>, 'galleryLoading' | 'galleryIndexLoading' | 'galleryError' | 'history' | 'projects'>): Promise<void> {
  cancelGalleryStorageLoad(history)
  const controller = new AbortController(); loadControllers.set(history, controller)
  const version = (loadVersions.get(history) || 0) + 1
  loadVersions.set(history, version)
  const mutations = new Map<string, Pick<ArtworkRecord, 'favorite'> | null>()
  pendingMutations.set(history, mutations)
  const isCurrent = () => !controller.signal.aborted && loadVersions.get(history) === version
  // Only an empty workspace needs a blocking placeholder. Refreshes retain the
  // last snapshot (including empty albums) until the latest read succeeds.
  galleryLoading.value = !history.value.length && !projects.value.length
  galleryError.value = ''
  galleryIndexLoading.value = true
  function publish(snapshot: ArtworkLibrarySnapshot) {
    if (!isCurrent()) return
    // A refresh still reads the authority, but unchanged metadata must not
    // invalidate every filter, album and keyed image card on a cached return.
    const nextHistory = snapshot.history.flatMap(item => {
      const patch = mutations.get(artworkIdKey(item.id))
      return patch === null ? [] : [patch ? { ...item, ...patch } : item]
    })
    if (!unchangedRecords(history.value, nextHistory)) history.value = nextHistory
    const nextProjects = galleryProjects(snapshot.projects).map(project => ({
      ...project, history_ids: project.history_ids.filter(id => mutations.get(artworkIdKey(id)) !== null),
    }))
    if (!unchangedRecords(projects.value, nextProjects)) projects.value = nextProjects
    galleryLoading.value = false
  }
  try {
    const repository = artworkRepository
    const snapshot = repository.readGallerySnapshot
      ? await repository.readGallerySnapshot(first => { if (!history.value.length) publish(first) }, controller.signal)
      : await repository.readLibrarySnapshot()
    publish(snapshot)
  } catch (error) {
    if (isCurrent()) galleryError.value = error instanceof Error ? error.message : String(error)
  } finally {
    if (loadVersions.get(history) === version) {
      pendingMutations.delete(history); galleryLoading.value = false; galleryIndexLoading.value = false
      if (loadControllers.get(history) === controller) loadControllers.delete(history)
    }
  }
}
