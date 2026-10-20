import { computed, nextTick, onDeactivated, onScopeDispose, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { normalizeSmartAlbumRule, type SmartAlbumRule } from '@/application/artwork/smartAlbums'
import { confirmAction } from '@/composables/useConfirm'
import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'
import { storageWriteMessage } from '@/utils/storageWriteError'
import { useAlbumNavigation } from './useAlbumNavigation'
import { beginGalleryProjectRead, captureGallerySource, galleryProjects, publishGalleryProjectChange, type GalleryProject } from './galleryStorage'
import { useGalleryProjectAlbums } from './useGalleryProjectAlbums'
import { createSmartAlbumMatcher, UNASSIGNED_CHARACTER_ID } from './galleryAlbumRules'
import { safeImageUrl, searchHaystack } from './galleryHelpers'
import type { useGalleryWorkspace } from './useGalleryWorkspace'

type Workspace = ReturnType<typeof useGalleryWorkspace>
type Options = Pick<Workspace, 'history' | 'projects' | 'thumbUrls' | 'cardUrls' | 'characterName' | 'characterFilter' | 'projectFilter'
  | 'galleryLoading' | 'galleryIndexLoading' | 'galleryError' | 'tagFilter' | 'searchQuery' | 'favoriteOnly' | 'resetGalleryFilters' | 'collectionPreviewItems' | 'showToast'
  | 'trashMode' | 'selectMode' | 'toggleSelectMode'>

export function useGalleryCollections(options: Options) {
  const indexComplete = computed(() => !options.galleryLoading.value && !options.galleryIndexLoading.value && !options.galleryError.value)
  const { albums, characterAlbums, resolvePreviewItems } = useGalleryProjectAlbums({ ...options, indexComplete })
  const albumSection = ref<'characters' | 'albums'>('albums')
  const visibleAlbumIds = ref<string[]>([])
  const selection = computed({
    get: () => options.projectFilter.value || (options.characterFilter.value ? `character:${encodeURIComponent(options.characterFilter.value)}` : ''),
    set: (id: string) => {
      options.characterFilter.value = id.startsWith('character:') ? decodeURIComponent(id.slice(10)) : ''
      options.projectFilter.value = id.startsWith('character:') ? '' : id
    },
  })
  const navigation = useAlbumNavigation(selection, albumSection)
  const route = useRoute(), router = useRouter()
  watch(() => route.query.fromArtwork, entry => {
    if (route.path !== '/gallery' || typeof entry !== 'string') return
    navigation.albumsOpen.value = false
    options.trashMode.value = false
    if (options.selectMode.value) options.toggleSelectMode()
    const query = { ...route.query }; delete query.fromArtwork
    void router.replace({ path: route.path, query, hash: route.hash }).catch(() => {})
  }, { immediate: true })
  const selectedProject = computed(() => options.projects.value.find(project => project.id === options.projectFilter.value))
  const collectionTitle = computed(() => selectedProject.value?.title || (options.characterFilter.value === UNASSIGNED_CHARACTER_ID
    ? '未标注角色' : options.characterFilter.value ? options.characterName(options.characterFilter.value) : '作品展墙'))
  const manualProjects = computed(() => options.projects.value.filter(project => !project.smartRule))
  const characterOptions = computed(() => characterAlbums.value.map(album => ({ value: album.characterId!, label: `${album.title} · ${album.countPending ? '数量待确认' : album.count}` })))
  const currentSmartRule = computed(() => selectedProject.value?.smartRule)
  const editorOpen = ref(false), saving = ref(false), error = ref('')
  const editing = ref<GalleryProject | null>(null)
  const editorTitle = ref(''), editorRule = ref<SmartAlbumRule>(blankRule())
  let draftId = ''
  let disposed = false
  let viewRevision = 0
  const isCurrentView = (revision: number) => !disposed && revision === viewRevision
  function blankRule(): SmartAlbumRule {
    return { characterId: '', tags: [], tagMatch: 'all', favoriteOnly: false, search: '', projectId: '' }
  }
  function newSmartAlbum() {
    if (saving.value) return
    editing.value = null; draftId = `smart-${crypto.randomUUID()}`; error.value = ''
    editorRule.value = { characterId: options.characterFilter.value, tags: options.tagFilter.value ? [options.tagFilter.value] : [],
      tagMatch: 'all', favoriteOnly: options.favoriteOnly.value, search: options.searchQuery.value,
      projectId: selectedProject.value && !selectedProject.value.smartRule ? selectedProject.value.id : '' }
    editorTitle.value = options.characterFilter.value ? `${collectionTitle.value}${options.tagFilter.value ? ` · ${options.tagFilter.value}` : '精选'}`
      : options.tagFilter.value || ''
    editorOpen.value = true
  }
  function editSmartAlbum(id: string) {
    if (saving.value) return
    const project = options.projects.value.find(value => value.id === id && value.smartRule)
    if (!project?.smartRule) return
    editing.value = project; draftId = project.id; error.value = ''
    editorTitle.value = project.title; editorRule.value = normalizeSmartAlbumRule(project.smartRule)
    editorOpen.value = true
  }
  const previewSearching = computed(() => editorOpen.value && !!editorRule.value.search.trim())
  const previewSearchIndex = computed(() => previewSearching.value
    ? new Map(options.history.value.map(item => [item, searchHaystack(item)])) : null)
  watch(previewSearching, searching => { if (!searching) void previewSearchIndex.value }, { flush: 'sync' })
  const previewItems = computed(() => {
    if (!editorOpen.value) return []
    const matches = createSmartAlbumMatcher(editorRule.value, options.projects.value)
    const index = previewSearchIndex.value
    return options.history.value.filter(item => matches(item, index?.get(item)))
  })
  const previewCovers = computed(() => previewItems.value.slice(0, 3).map(item => {
    const cached = options.thumbUrls.value[item.id] || options.cardUrls.value[item.id] || ''
    return { id: item.id, src: /^(blob:|data:image\/)/.test(cached) ? cached : safeImageUrl(cached) }
  }))
  // Read only album representatives while the wall is hidden, through its existing thumbnail owner.
  const albumPreviewItems = computed(() => resolvePreviewItems(albumSection.value, visibleAlbumIds.value))
  const syncPreviews = computed(() => editorOpen.value ? previewItems.value.slice(0, 3) : navigation.albumsOpen.value ? albumPreviewItems.value : null)
  async function openCollection(id: string) {
    options.resetGalleryFilters()
    await navigation.openAlbum(id)
  }
  function showOverview(section: 'characters' | 'albums') {
    albumSection.value = section
    return navigation.showAlbums()
  }
  async function showAllWorks() {
    options.resetGalleryFilters()
    await navigation.showImages()
  }
  async function refreshProjects(source: ReturnType<typeof captureGallerySource>) {
    if (disposed || !source.isCurrent()) return
    const read = beginGalleryProjectRead(options.projects, source, () => !disposed)
    try { read.publish(galleryProjects(await source.repository.readProjects())) }
    finally { read.finish() }
  }
  async function save() {
    if (saving.value) return
    const revision = viewRevision
    const source = captureGallerySource()
    const ownsView = () => isCurrentView(revision) && source.isCurrent()
    saving.value = true; error.value = ''
    try {
      const saved = await source.repository.saveSmartAlbum({ id: draftId, title: editorTitle.value, rule: normalizeSmartAlbumRule(editorRule.value) })
      // Publish the acknowledged project even if a subsequent refresh fails.
      const project = galleryProjects([saved])[0]
      if (!project) throw new Error('智能画册保存响应无效')
      if (disposed || !source.isCurrent()) return
      publishGalleryProjectChange(options.projects, source, project.id, project)
      // Persistence survives KeepAlive deactivation; old UI work must not navigate a newer visit.
      if (!ownsView()) return
      editorOpen.value = false
      albumSection.value = 'albums'
      await openCollection(project.id)
      if (!ownsView()) return
      options.showToast(editing.value ? '智能画册已更新' : '智能画册已保存', 'success')
    } catch (cause) { if (ownsView()) error.value = storageWriteMessage(cause, '智能画册') }
    finally { source.release(); saving.value = false }
  }
  async function removeSmartAlbum(id: string) {
    const project = options.projects.value.find(value => value.id === id && value.smartRule)
    if (!project || saving.value) return
    const revision = viewRevision
    const source = captureGallerySource()
    const ownsView = () => isCurrentView(revision) && source.isCurrent()
    let admitted = false
    try {
      const confirmed = await confirmAction({ title: '移除智能画册？', message: `移除「${project.title}」的筛选规则，作品仍保存在全部作品中。`, confirmLabel: '移除画册', danger: false })
      if (!confirmed || !ownsView() || saving.value) return
      if (options.projects.value.find(value => value.id === id) !== project) {
        options.showToast('画册信息已变化，请重新核对后移除', 'warning')
        return
      }
      admitted = true; saving.value = true
      await source.repository.deleteSmartAlbum(id)
      if (disposed || !source.isCurrent()) return
      publishGalleryProjectChange(options.projects, source, id, null)
      if (!ownsView()) return
      if (options.projectFilter.value === id) options.resetGalleryFilters()
      options.showToast('智能画册已移除', 'success')
      await nextTick()
      if (ownsView()) navigation.albumRoot.value?.focus({ preventScroll: true })
    } catch (cause) {
      if (ownsView()) options.showToast(storageWriteMessage(cause, '智能画册'), 'error')
      if (admitted) await refreshProjects(source).catch(() => {})
    } finally { source.release(); if (admitted) saving.value = false }
  }
  const releaseMaintenance = registerMaintenanceParticipant(() => {
    if (saving.value || editorOpen.value) throw new Error('OPEN_GALLERY_ALBUM_EDITOR')
  })
  onDeactivated(() => { viewRevision++; editorOpen.value = false })
  onScopeDispose(() => { disposed = true; releaseMaintenance() })
  return { ...navigation, selection, albums, characterAlbums, albumSection, visibleAlbumIds, collectionTitle, manualProjects, characterOptions,
    currentSmartRule, editorOpen, editorTitle, editorRule, editing, saving, error, previewItems, previewCovers, syncPreviews,
    newSmartAlbum, editSmartAlbum, removeSmartAlbum, save, openCollection, showOverview, showAllWorks }
}
