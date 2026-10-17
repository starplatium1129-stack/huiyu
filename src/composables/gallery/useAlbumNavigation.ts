import { nextTick, onDeactivated, onScopeDispose, ref, watch, type Ref } from 'vue'
import { captureScrollAnchor, restoreScrollAnchor, watchForUserScroll, type ScrollAnchor } from '@/utils/scrollAnchor'

/** Both image libraries enter a collection from its cover and return to that same cover. */
export function useAlbumNavigation<T extends string>(selection: Ref<T>, section?: Readonly<Ref<string>>) {
  const albumsOpen = ref(false)
  const albumRoot = ref<HTMLElement | null>(null)
  const imageHeading = ref<HTMLElement | null>(null)
  const albumPositions = new Map<string, { anchor: ScrollAnchor | null; focusedId: string }>()
  let imageAnchor: ScrollAnchor | null = null
  let cancelRestore = () => {}
  let stopUserScroll = () => {}
  let revision = 0

  function cancel() { revision++; cancelRestore(); stopUserScroll() }
  function restore(anchor: ScrollAnchor | null, turn: number) {
    if (!anchor) return
    stopUserScroll = watchForUserScroll(cancel)
    cancelRestore = restoreScrollAnchor(anchor, {
      immediate: true, shouldContinue: () => revision === turn,
      onRestored: () => stopUserScroll(), onAbandoned: () => stopUserScroll(),
    })
  }
  function rememberAlbums(key = section?.value ?? '') {
    if (!albumsOpen.value) return
    const focused = document.activeElement instanceof HTMLElement
      ? document.activeElement.closest<HTMLElement>('[data-album-id]') : null
    albumPositions.set(key, { anchor: captureScrollAnchor(), focusedId: focused && albumRoot.value?.contains(focused)
      ? focused.dataset.albumId || '' : albumPositions.get(key)?.focusedId || '' })
  }
  async function arriveAlbums(turn: number) {
    await nextTick()
    if (turn !== revision) return
    const position = albumPositions.get(section?.value ?? '')
    const covers = [...(albumRoot.value?.querySelectorAll<HTMLButtonElement>('[data-album-id]') || [])]
    const selected = covers.find(button => button.dataset.albumId === selection.value)
      ?? covers.find(button => button.dataset.albumId === position?.focusedId)
    ;(selected || albumRoot.value)?.focus({ preventScroll: true })
    if (position?.anchor) restore(position.anchor, turn)
    else albumRoot.value?.scrollIntoView({ block: 'start', behavior: 'instant' })
  }
  async function showAlbums() {
    if (albumsOpen.value) return
    cancel(); const turn = revision
    imageAnchor = captureScrollAnchor()
    albumsOpen.value = true
    await arriveAlbums(turn)
  }
  async function showImages() {
    if (!albumsOpen.value) return
    cancel(); const turn = revision
    rememberAlbums()
    albumsOpen.value = false
    await nextTick()
    if (turn !== revision) return
    imageHeading.value?.focus({ preventScroll: true })
    restore(imageAnchor, turn)
  }
  async function openAlbum(id: T) {
    cancel(); const turn = revision
    rememberAlbums()
    selection.value = id
    albumsOpen.value = false
    imageAnchor = null
    await nextTick()
    if (turn !== revision) return
    imageHeading.value?.focus({ preventScroll: true })
    imageHeading.value?.scrollIntoView({ block: 'start', behavior: 'instant' })
  }
  if (section) watch(section, (_next, previous) => {
    if (!albumsOpen.value) return
    rememberAlbums(previous)
    cancel()
    void arriveAlbums(revision)
  }, { flush: 'sync' })
  onDeactivated(cancel)
  onScopeDispose(cancel)
  return { albumsOpen, albumRoot, imageHeading, showAlbums, showImages, openAlbum }
}
