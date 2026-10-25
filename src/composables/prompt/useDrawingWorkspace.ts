import { computed, onDeactivated, onScopeDispose, provide, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { drawingNavigationKey, type DrawingEngine } from './useDrawingNavigation'
import { useDeferredToolLauncher } from './useDeferredToolLauncher'
import { readMangaSource } from '@/composables/manga/mangaImage'
import { imageMediaSession } from '@/platform/imageMediaSession'

export function useDrawingWorkspace() {
  const route = useRoute(), router = useRouter()
  const mode = computed(() => route.path === '/prompt-builder' && (route.query.engine === 'moss' || route.query.engine === 'qwen') ? route.query.engine : null)
  const sourceImage = shallowRef<File | null>(null), importing = ref(false), error = ref('')
  const editorEntry = ref(0), opener = shallowRef<HTMLElement | null>(null)
  const editor = useDeferredToolLauncher(
    () => import('@/components/director/QwenEditorDialog.vue'),
    () => route.path !== '/prompt-builder',
    () => { error.value = 'Qwen 编辑窗口未能加载，请重试' },
  )
  let transfer: AbortController | null = null
  watch(() => [route.path, route.query.editor, route.query.artwork, route.query.job], (next, previous) => {
    if (route.path !== '/prompt-builder' || route.query.editor !== 'qwen') return
    if (previous?.[0] === route.path && previous?.[1] === 'qwen' && !next.slice(2).some((value, index) => value && value !== previous[index + 2])) return
    opener.value = document.activeElement instanceof HTMLElement ? document.activeElement : null
    editorEntry.value++; void showEditor()
  }, { immediate: true })
  async function showEditor() {
    if (editor.loading.value || editor.open.value) return
    error.value = ''
    editor.host.value = opener.value instanceof HTMLButtonElement ? opener.value.parentElement : null
    await editor.toggle()
    if (!editor.open.value) sourceImage.value = null
  }
  async function selectEngine(engine: DrawingEngine) {
    error.value = ''
    try {
      const failure = await router.push({ path: '/prompt-builder', query: engine === 'moss' || engine === 'qwen' ? { engine } : {} })
      if (failure) error.value = '引擎尚未切换，请重试'
    } catch (cause) { error.value = cause instanceof Error ? cause.message : '引擎切换失败，请重试' }
  }
  async function editImage(url: string) {
    if (importing.value || editor.loading.value || editor.open.value) return
    opener.value = document.activeElement instanceof HTMLElement ? document.activeElement : null
    if (!url) { await showEditor(); return }
    const controller = new AbortController(), owner = imageMediaSession(), location = route.fullPath
    transfer = controller; importing.value = true; error.value = ''
    try {
      const blob = await readMangaSource(url, undefined, controller.signal)
      controller.signal.throwIfAborted()
      if (imageMediaSession() !== owner || route.fullPath !== location) throw new Error('画布或工作区已变化，请重新选择图片')
      sourceImage.value = new File([blob], '画布图片', { type: blob.type })
      await showEditor()
    } catch (cause) {
      if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '画布图片未能读取，请重试'
    } finally { if (transfer === controller) { transfer = null; importing.value = false } }
  }
  async function closeEditor() {
    editor.update(false); sourceImage.value = null
    if (route.query.editor === 'qwen') {
      const query = { ...route.query }; delete query.editor; delete query.artwork; delete query.job
      await router.replace({ query })
    }
  }
  provide(drawingNavigationKey, { mode, selectEngine, editImage, importing, openingEditor: editor.loading, error })
  onDeactivated(() => { transfer?.abort(); editor.update(false); sourceImage.value = null })
  onScopeDispose(() => { transfer?.abort(); sourceImage.value = null })
  return { mode, editorPanel: editor.panel, editorOpen: editor.open, editorEntry, sourceImage, opener, closeEditor }
}
