import { computed, nextTick, onDeactivated, onScopeDispose, ref } from 'vue'
import { artworkRepository } from '@/storage/artworkRepository'
import { normalizeSmartAlbumRule, type SmartAlbumRule } from '@/application/artwork/smartAlbums'
import { confirmAction } from '@/composables/useConfirm'
import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'
import { storageWriteMessage } from '@/utils/storageWriteError'
import { useAlbumNavigation } from './useAlbumNavigation'
import { galleryProjects, type GalleryProject } from './galleryStorage'
import { useGalleryProjectAlbums } from './useGalleryProjectAlbums'
import { matchesSmartAlbum, UNASSIGNED_CHARACTER_ID } from './galleryAlbumRules'
import { safeImageUrl } from './galleryHelpers'
import type { useGalleryWorkspace } from './useGalleryWorkspace'

type Workspace = ReturnType<typeof useGalleryWorkspace>
type Options = Pick<Workspace, 'history' | 'projects' | 'thumbUrls' | 'cardUrls' | 'characterName' | 'characterFilter' | 'projectFilter'
  | 'tagFilter' | 'searchQuery' | 'favoriteOnly' | 'resetGalleryFilters' | 'collectionPreviewItems' | 'showToast'>

export function useGalleryCollections(options: Options) {
  const { albums, characterAlbums } = useGalleryProjectAlbums(options)
  const albumSection = ref<'characters' | 'albums'>('albums')
  const visibleAlbumIds = ref<string[]>([])
  const selection = computed({
    get: () => options.projectFilter.value || (options.characterFilter.value ? `character:${encodeURIComponent(options.characterFilter.value)}` : ''),
    set: (id: string) => {
      options.characterFilter.value = id.startsWith('character:') ? decodeURIComponent(id.slice(10)) : ''
      options.projectFilter.value = id.startsWith('character:') ? '' : id
    },
  })
  const navigation = useAlbumNavigation(selection)
  const selectedProject = computed(() => options.projects.value.find(project => project.id === options.projectFilter.value))
  const collectionTitle = computed(() => selectedProject.value?.title || (options.characterFilter.value === UNASSIGNED_CHARACTER_ID
    ? '未标注角色' : options.characterFilter.value ? options.characterName(options.characterFilter.value) : '作品展墙'))
  const manualProjects = computed(() => options.projects.value.filter(project => !project.smartRule))
  const characterOptions = computed(() => characterAlbums.value.map(album => ({ value: album.characterId!, label: `${album.title} · ${album.count}` })))
  const currentSmartRule = computed(() => selectedProject.value?.smartRule)
  const editorOpen = ref(false), saving = ref(false), error = ref('')
  const editing = ref<GalleryProject | null>(null)
  const editorTitle = ref(''), editorRule = ref<SmartAlbumRule>(blankRule())
  let draftId = ''
  let disposed = false
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
  const previewItems = computed(() => options.history.value.filter(item => matchesSmartAlbum(item, editorRule.value, options.projects.value)))
  const previewCovers = computed(() => previewItems.value.slice(0, 3).map(item => {
    const cached = options.thumbUrls[item.id] || options.cardUrls[item.id] || ''
    return { id: item.id, src: /^(blob:|data:image\/)/.test(cached) ? cached : safeImageUrl(cached) }
  }))
  // Read only album representatives while the wall is hidden, through its existing thumbnail owner.
  const albumPreviewItems = computed(() => {
    const visible = new Set(visibleAlbumIds.value)
    const ids = new Set((albumSection.value === 'characters' ? characterAlbums.value : albums.value)
      .filter(album => visible.has(album.id)).flatMap(album => album.previewIds || []))
    return options.history.value.filter(item => ids.has(item.id))
  })
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
  async function refreshProjects() {
    const records = await artworkRepository.readProjects()
    if (!disposed) options.projects.value = galleryProjects(records)
  }
  async function save() {
    if (saving.value) return
    saving.value = true; error.value = ''
    try {
      const saved = await artworkRepository.saveSmartAlbum({ id: draftId, title: editorTitle.value, rule: normalizeSmartAlbumRule(editorRule.value) })
      // Publish the acknowledged project even if a subsequent refresh fails.
      const project = galleryProjects([saved])[0]
      if (!project) throw new Error('智能画册保存响应无效')
      if (disposed) return
      options.projects.value = [...options.projects.value.filter(value => value.id !== project.id), project]
      editorOpen.value = false
      albumSection.value = 'albums'
      await openCollection(project.id)
      options.showToast(editing.value ? '智能画册已更新' : '智能画册已保存', 'success')
    } catch (cause) { if (!disposed) error.value = storageWriteMessage(cause, '智能画册') }
    finally { saving.value = false }
  }
  async function removeSmartAlbum(id: string) {
    const project = options.projects.value.find(value => value.id === id && value.smartRule)
    if (!project || saving.value) return
    const confirmed = await confirmAction({ title: '移除智能画册？', message: `移除「${project.title}」的筛选规则，作品仍保存在全部作品中。`, confirmLabel: '移除画册', danger: false })
    if (!confirmed || disposed || saving.value) return
    saving.value = true
    try {
      await artworkRepository.deleteSmartAlbum(id)
      if (disposed) return
      options.projects.value = options.projects.value.filter(value => value.id !== id)
      if (options.projectFilter.value === id) options.resetGalleryFilters()
      options.showToast('智能画册已移除', 'success')
      await nextTick(); navigation.albumRoot.value?.focus({ preventScroll: true })
    } catch (cause) {
      options.showToast(storageWriteMessage(cause, '智能画册'), 'error')
      await refreshProjects().catch(() => {})
    } finally { saving.value = false }
  }
  const releaseMaintenance = registerMaintenanceParticipant(() => {
    if (saving.value || editorOpen.value) throw new Error('OPEN_GALLERY_ALBUM_EDITOR')
  })
  onDeactivated(() => { editorOpen.value = false })
  onScopeDispose(() => { disposed = true; releaseMaintenance() })
  return { ...navigation, selection, albums, characterAlbums, albumSection, visibleAlbumIds, collectionTitle, manualProjects, characterOptions,
    currentSmartRule, editorOpen, editorTitle, editorRule, editing, saving, error, previewItems, previewCovers, syncPreviews,
    newSmartAlbum, editSmartAlbum, removeSmartAlbum, save, openCollection, showOverview, showAllWorks }
}
