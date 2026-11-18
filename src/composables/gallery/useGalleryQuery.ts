import { computed, onDeactivated, onScopeDispose, shallowRef, watch, type Ref } from 'vue'
import type { ArtworkRecord } from '@/types/artwork'
import type { GalleryCatalog, GalleryCursor, GalleryQuery } from '@/application/artwork/galleryQuery'
import { artworkRepository } from '@/storage/artworkRepository'
import { beginGalleryProjectRead, captureGallerySource, galleryProjects, type GalleryProject } from './galleryStorage'
import { imageMediaSession } from '@/platform/imageMediaSession'
import { onDesktopRuntime } from '@/platform/desktop/runtime'

const PAGE_SIZE = 24
const MAX_PAGE_SIZE = 200

/** Only requested pages enter Vue. Counts and cover representatives come from the authority. */
export function useGalleryQuery(options: {
  history: Ref<ArtworkRecord[]>; projects: Ref<GalleryProject[]>; loading: Ref<boolean>; reading: Ref<boolean>; error: Ref<string>
  query: () => GalleryQuery; active: () => boolean
}) {
  const catalog = shallowRef<GalleryCatalog | null>(null), total = shallowRef(0), cursor = shallowRef<GalleryCursor | null>(null)
  const enabled = shallowRef(!!artworkRepository.readGalleryPage)
  let controller: AbortController | null = null, sequence = 0, started = false, identity = imageMediaSession()
  let flight: Promise<boolean> | null = null, publishingProjects = false, requestedQuery = ''
  function cancel() { sequence++; controller?.abort(); controller = null; options.reading.value = false; flight = null }
  function invalidate() {
    enabled.value = !!artworkRepository.readGalleryPage
    if (identity === imageMediaSession()) return
    identity = imageMediaSession(); cancel(); options.loading.value = false; options.error.value = '作品库连接已变化，请重新读取'; catalog.value = null; cursor.value = null; total.value = 0; options.history.value = []; options.projects.value = []
  }
  const stopRuntime = onDesktopRuntime(invalidate)
  watch(imageMediaSession, invalidate, { flush: 'sync' })
  function read(reset: boolean, refreshCatalog: boolean, retain = PAGE_SIZE): Promise<boolean> {
    if (!enabled.value || !options.active()) return Promise.resolve(false)
    if (!reset && flight) return flight
    cancel(); started = true
    const version = sequence, source = captureGallerySource(), abort = new AbortController(); controller = abort
    const current = () => version === sequence && !abort.signal.aborted && source.isCurrent() && options.active()
    const projectRead = beginGalleryProjectRead(options.projects, source, current)
    const query = structuredClone(options.query()); requestedQuery = JSON.stringify(query)
    const firstCursor = reset ? null : cursor.value
    options.reading.value = true; options.loading.value = !options.history.value.length; options.error.value = ''
    const operation = (async () => {
      try {
        const [page, initialDirectory, initialProjects] = await Promise.all([
          source.repository.readGalleryPage!(query, firstCursor, abort.signal, Math.min(MAX_PAGE_SIZE, Math.max(PAGE_SIZE, retain))),
          refreshCatalog ? source.repository.readGalleryCatalog!(abort.signal) : null,
          refreshCatalog ? source.repository.readProjects() : null,
        ])
        let directory = initialDirectory, projects = initialProjects
        if (!current()) return false
        if (!refreshCatalog && (!catalog.value || catalog.value.revision !== page.revision || catalog.value.projectsVersion !== page.projectsVersion)) {
          [directory, projects] = await Promise.all([source.repository.readGalleryCatalog!(abort.signal), source.repository.readProjects()])
          if (!current()) return false
        }
        if (directory && (directory.revision !== page.revision || directory.projectsVersion !== page.projectsVersion))
          throw new Error('作品库在读取期间发生变更，请重新读取')
        if (reset && page.items.length < retain) {
          const ids = new Set(page.items.map(item => String(item.id).trim()))
          while (page.items.length < retain && page.nextCursor) {
            const limit = Math.min(MAX_PAGE_SIZE, retain - page.items.length)
            const next = await source.repository.readGalleryPage!(query, page.nextCursor, abort.signal, limit)
            if (!current()) return false
            for (const item of next.items) {
              const id = String(item.id).trim()
              if (ids.has(id)) throw new Error('作品分页含重复记录，请重新读取')
              ids.add(id)
            }
            page.items.push(...next.items); page.nextCursor = next.nextCursor
          }
        }
        const previous = reset ? [] : options.history.value
        const ids = new Set(previous.map(item => String(item.id).trim()))
        if (page.items.some(item => ids.has(String(item.id).trim()))) throw new Error('作品分页含重复记录，请重新读取')
        options.history.value = [...previous, ...page.items]; total.value = page.total; cursor.value = page.nextCursor
        if (directory) catalog.value = directory
        if (projects) { publishingProjects = true; try { projectRead.publish(galleryProjects(projects)) } finally { publishingProjects = false } }
        return true
      } catch (error) {
        if (current()) options.error.value = error instanceof Error ? error.message : String(error)
        return false
      } finally {
        source.release(); projectRead.finish()
        if (version === sequence) { options.loading.value = false; options.reading.value = false; controller = null; flight = null }
      }
    })()
    flight = operation
    return operation
  }
  const hasMore = computed(() => cursor.value !== null)
  async function more() { return !hasMore.value || await read(false, false) }
  async function all() {
    const query = JSON.stringify(options.query()), source = imageMediaSession()
    while (hasMore.value) if (!await read(false, false, MAX_PAGE_SIZE) || query !== JSON.stringify(options.query()) || source !== imageMediaSession()) return false
    return !options.error.value
  }
  async function refresh() {
    return read(true, true, options.history.value.length)
  }
  watch(() => JSON.stringify(options.query()), () => {
    if (!started || !enabled.value || requestedQuery === JSON.stringify(options.query())) return
    cancel(); options.history.value = []; cursor.value = null; total.value = 0
    void read(true, false)
  })
  watch(options.projects, () => { if (started && enabled.value && !publishingProjects) void read(true, true) }, { deep: true, flush: 'sync' })
  onDeactivated(cancel)
  onScopeDispose(() => { cancel(); stopRuntime() })
  return { enabled, catalog, total, hasMore, more, all, refresh }
}
