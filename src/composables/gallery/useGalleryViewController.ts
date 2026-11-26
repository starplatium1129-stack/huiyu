import { computed, nextTick, onActivated, onDeactivated, reactive, ref, watch } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import { useGalleryWorkspace } from '@/composables/gallery/useGalleryWorkspace'
import { useGalleryCollections } from '@/composables/gallery/useGalleryCollections'
import { artworkCharacterIds } from '@/composables/gallery/galleryAlbumRules'
import { useGalleryGestureViewer } from '@/composables/gallery/useGalleryGestureViewer'
import { useArtworkViewerSurface } from '@/composables/useArtworkViewerSurface'
import { characterParticleTheme } from '@/utils/characterParticleTheme'

export function useGalleryViewController() {
  const originalViewer = ref(false)
  const selectionDock = ref<HTMLElement | null>(null)
  const dockActive = ref(true)
  const selectionDockHeight = ref(140)
  useResizeObserver(() => dockActive.value ? selectionDock.value : null, ([entry]) => {
    if (entry && dockActive.value) selectionDockHeight.value = entry.borderBoxSize[0].blockSize
  }, { box: 'border-box' })
  onActivated(() => { dockActive.value = true })
  onDeactivated(() => { dockActive.value = false })

  const workspace = useGalleryWorkspace()
  const gesture = useGalleryGestureViewer(workspace)
  const {
    tagFilter, characterFilter, collectionPreviewItems,
    viewerEl, infoEl, shellEl,
    selectMode, toggleSelectMode,
    trashMode, toggleTrashMode,
    visible, resetGalleryFilters,
    sceneTitle, openViewer,
    formatDate, stamp,
    pagedVisible,
    viewerIndex, idleMediaSuspended, infoDrawerHidden,
    closeViewer, onViewerClosed,
    compareMode, retryParentImage,
    current, characterName,
    compareOpen,
  } = workspace

  function retryComparisonOriginal(event: MouseEvent) {
    if (event.currentTarget instanceof HTMLElement) {
      event.currentTarget.closest('.viewer-compare-host')?.querySelector<HTMLElement>('[role="slider"]')?.focus({ preventScroll: true })
    }
    void retryParentImage()
  }

  const activeStudioCharacter = computed(() =>
    characterFilter.value === 'nene' || characterFilter.value === 'natsume' ? characterFilter.value : '',
  )

  const displayedCurrent = ref(current.value)
  const displayedIndex = ref(viewerIndex.value)

  function characterAccentOf(item?: typeof displayedCurrent.value): string {
    if (!item) return 'var(--accent)'
    const ids = artworkCharacterIds(item)
    if (ids.includes('nene') && ids.includes('natsume')) return 'var(--accent-violet)'
    const primary = ids[0] || ''
    if (primary === 'nene') return 'var(--nene-violet)'
    if (primary === 'natsume') return 'var(--natsume-amber)'
    if (primary) return characterParticleTheme(primary).accent
    return 'var(--accent)'
  }

  const viewerCharacterStyle = computed(() =>
    displayedCurrent.value ? { '--viewer-char-accent': characterAccentOf(displayedCurrent.value) } : undefined,
  )

  const cardLabels = computed(() => new Map(pagedVisible.value.map(item => [item.id, {
    title: sceneTitle(item.scene, item),
    character: characterName(item.character, item),
    date: formatDate(stamp(item)),
    accent: characterAccentOf(item),
  }])))

  function toggleOriginalViewer() {
    originalViewer.value = !originalViewer.value
    gesture.cancelGesture()
    compareMode.value = false
    void nextTick(() => viewerEl.value?.querySelector<HTMLElement>('.zoomable-image-viewer')?.focus({ preventScroll: true }))
  }

  watch(viewerIndex, (index, previous) => {
    if (index < 0 || previous < 0) gesture.cancelGesture()
    if (index >= 0 && previous < 0) originalViewer.value = false
  }, { flush: 'sync' })

  const viewerSurface = useArtworkViewerSurface({
    active: () => viewerIndex.value >= 0 && !idleMediaSuspended.value,
    imageKey: () => current.value?.id,
    mode: () => `${originalViewer.value}/${compareMode.value}/${gesture.gestureViewer.value}`,
    source: id => {
      const card = shellEl.value?.querySelector<HTMLElement>(`.artwork[data-card-id="${CSS.escape(String(id))}"]`)
      return card?.querySelector<HTMLImageElement>('.artwork-image-hd.is-loaded')
        ?? card?.querySelector<HTMLImageElement>('.artwork-image:not(.artwork-image-hd)') ?? null
    },
  })
  watch(idleMediaSuspended, suspended => viewerSurface.setMediaSuspended(suspended), { flush: 'sync' })

  function openFromCard(index: number, event: MouseEvent) {
    const button = event.currentTarget as HTMLElement
    const item = visible.value[index]
    if (!item) return
    viewerSurface.captureOrigin(
      button.querySelector<HTMLImageElement>('.artwork-image-hd.is-loaded')
        ?? button.querySelector<HTMLImageElement>('.artwork-image:not(.artwork-image-hd)'),
      item.id,
    )
    openViewer(index)
  }

  const collections = useGalleryCollections(workspace)

  // Keep visited panels alive so closing selection or a dialog retains undo and exit state.
  const visitedPanels = reactive({ albums: false, organization: false, editor: false, comparison: false })
  watch([collections.albumsOpen, selectMode, collections.editorOpen, compareOpen], ([albums, organization, editor, comparison]) => {
    if (albums) visitedPanels.albums = true
    if (organization) visitedPanels.organization = true
    if (editor) visitedPanels.editor = true
    if (comparison) visitedPanels.comparison = true
  }, { immediate: true, flush: 'sync' })

  watch(collections.syncPreviews, items => { collectionPreviewItems.value = items }, { immediate: true })

  function showAlbumOverview(section: 'characters' | 'albums') {
    if (selectMode.value) toggleSelectMode()
    if (trashMode.value) toggleTrashMode()
    void collections.showOverview(section)
  }

  function startAlbumSelection() {
    resetGalleryFilters()
    if (trashMode.value) toggleTrashMode()
    if (!selectMode.value) toggleSelectMode()
    void collections.showImages()
  }

  const refinement = ref<{ focusTag: () => void } | null>(null)
  const selectionToggle = ref<HTMLButtonElement | null>(null)

  async function finishSelection() {
    toggleSelectMode()
    await nextTick()
    ;(selectionToggle.value?.disabled ? collections.imageHeading.value : selectionToggle.value)?.focus({ preventScroll: true })
  }

  async function filterByTag(tag: string) {
    closeViewer()
    tagFilter.value = tag
    await nextTick()
    refinement.value?.focusTag()
  }

  watch(() => current.value?.id, async (id, previous) => {
    if (id == null || id === previous || viewerIndex.value < 0) return
    const focused = infoEl.value?.contains(document.activeElement) ? document.activeElement : null
    await nextTick()
    if (current.value?.id !== id || viewerIndex.value < 0 || !infoEl.value?.isConnected) return
    const body = infoEl.value?.querySelector<HTMLElement>('.viewer-info-body')
    body?.scrollTo(0, 0)
    if (focused && !focused.isConnected && !infoDrawerHidden.value && viewerIndex.value >= 0) {
      body?.querySelector<HTMLElement>('.viewer-title')?.focus({ preventScroll: true })
    }
  })

  watch([current, viewerIndex], ([value, index]) => {
    if (value && index >= 0) {
      displayedCurrent.value = value
      displayedIndex.value = index
    }
  }, { flush: 'sync' })

  function finishViewerClose() {
    onViewerClosed()
    if (viewerIndex.value < 0) {
      displayedCurrent.value = null
      displayedIndex.value = -1
    }
  }

  return {
    workspace,
    gesture,
    collections,
    originalViewer,
    selectionDock,
    selectionDockHeight,
    retryComparisonOriginal,
    activeStudioCharacter,
    viewerCharacterStyle,
    cardLabels,
    toggleOriginalViewer,
    viewerSurface,
    openFromCard,
    visitedPanels,
    showAlbumOverview,
    startAlbumSelection,
    refinement,
    selectionToggle,
    finishSelection,
    filterByTag,
    displayedCurrent,
    displayedIndex,
    finishViewerClose,
  }
}
