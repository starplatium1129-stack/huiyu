import { nextTick, onDeactivated, onScopeDispose, ref, type Ref } from 'vue'
import { captureScrollAnchor, restoreScrollAnchor, type ScrollAnchor } from '@/utils/scrollAnchor'

/** Both image libraries enter a collection from its cover and return to that same cover. */
export function useAlbumNavigation<T extends string>(selection: Ref<T>) {
  const albumsOpen = ref(false)
  const albumRoot = ref<HTMLElement | null>(null)
  const imageHeading = ref<HTMLElement | null>(null)
  let albumAnchor: ScrollAnchor | null = null
  let imageAnchor: ScrollAnchor | null = null
  let cancelRestore = () => {}
  let revision = 0

  function cancel() { revision++; cancelRestore() }
  function restore(anchor: ScrollAnchor | null, turn: number) {
    if (anchor) cancelRestore = restoreScrollAnchor(anchor, { immediate: true, shouldContinue: () => revision === turn })
  }
  async function showAlbums() {
    if (albumsOpen.value) return
    cancel(); const turn = revision
    imageAnchor = captureScrollAnchor()
    albumsOpen.value = true
    await nextTick()
    if (turn !== revision) return
    restore(albumAnchor, turn)
    const selected = [...(albumRoot.value?.querySelectorAll<HTMLButtonElement>('[data-album-id]') || [])]
      .find(button => button.dataset.albumId === selection.value)
    ;(selected || albumRoot.value)?.focus({ preventScroll: true })
    if (!albumAnchor) albumRoot.value?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  }
  async function showImages() {
    if (!albumsOpen.value) return
    cancel(); const turn = revision
    albumAnchor = captureScrollAnchor()
    albumsOpen.value = false
    await nextTick()
    if (turn !== revision) return
    imageHeading.value?.focus({ preventScroll: true })
    restore(imageAnchor, turn)
  }
  async function openAlbum(id: T) {
    cancel(); const turn = revision
    albumAnchor = captureScrollAnchor()
    selection.value = id
    albumsOpen.value = false
    imageAnchor = null
    await nextTick()
    if (turn !== revision) return
    imageHeading.value?.focus({ preventScroll: true })
    imageHeading.value?.scrollIntoView({ block: 'start', behavior: 'instant' })
  }
  onDeactivated(cancel)
  onScopeDispose(cancel)
  return { albumsOpen, albumRoot, imageHeading, showAlbums, showImages, openAlbum }
}
