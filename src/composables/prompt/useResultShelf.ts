import { computed, onActivated, onDeactivated, onScopeDispose, ref, watch, type Ref } from 'vue'
import { runtimeResultPath, fetchRuntimeResult } from '@/api/runtimeTasks'
import { runtimeTasks, runtimeTasksEnabled } from '@/stores/runtimeTaskState'
import { onDesktopRuntime } from '@/platform/desktop/runtime'
import { artworkRepository } from '@/storage/artworkRepository'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'
import { blobThumbDataUrl } from '@/utils/imageThumb'
import { fetchResultImage } from '@/composables/generation/fetchResultImage'
import { safeImageUrl } from '@/composables/gallery/galleryHelpers'
import { artworkTimestamp, type ArtworkRecord } from '@/types/artwork'
import type { ResultSnapshot } from './promptResultSnapshot'

export interface ShelfItem {
  key: string
  title: string
  kind: 'task' | 'history' | 'previous'
  source: string
  imageId?: string
  taskId?: string
  index?: number
  entry?: ArtworkRecord
}

/** A read-only view of existing results. Preview never replaces the live generation state. */
export function useResultShelf(history: Ref<ArtworkRecord[]>, previous: Ref<ResultSnapshot | null | undefined>) {
  const category = ref('candidates'), selectedKey = ref(''), previewUrl = ref('')
  const thumbnails = ref<Record<string, string>>({}), error = ref(''), loading = ref(false)
  const active = ref(true), revision = ref(''), retry = ref(0)
  const local = isLocalStudioHost()
  const unsubscribe = onDesktopRuntime(state => {
    revision.value = `${state.connection}:${state.bootstrap?.runtime?.workspace?.workspaceId || ''}:${state.bootstrap?.runtime?.workspace?.runtimeEpoch || ''}`
  })
  const candidates = computed<ShelfItem[]>(() => {
    if (!local) return []
    const tasks: ShelfItem[] = runtimeTasksEnabled.value ? runtimeTasks.value
      .filter(task => task.resultState === 'available' && task.deliveryState !== 'discarded')
      .sort((a, b) => b.createdAt - a.createdAt)
      .flatMap(task => task.resultRefs.filter(result => result.mime.startsWith('image/')).map(result => ({
        key: `task:${task.taskId}:${result.index}`, kind: 'task' as const,
        title: `候选 · ${new Date(task.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · ${result.index + 1}`,
        source: runtimeResultPath(task, result.index), taskId: task.taskId, index: result.index,
      }))).slice(0, 8) : []
    if (!tasks.length && previous.value) tasks.push({ key: `previous:${previous.value.url}`, title: '上一张 · 对比快照', kind: 'previous', source: previous.value.url })
    return tasks
  })
  const recent = computed<ShelfItem[]>(() => local ? history.value.slice().sort((a, b) => artworkTimestamp(b) - artworkTimestamp(a)).slice(0, 12).map(entry => ({
    key: `history:${typeof entry.id}:${entry.id}`, title: entry.sceneTitle || entry.story || '未命名作品', kind: 'history',
    imageId: entry.image_id, source: safeImageUrl(entry.image_url), entry,
  })) : [])
  const items = computed(() => category.value === 'history' ? recent.value : candidates.value)
  const selected = computed(() => items.value.find(item => item.key === selectedKey.value))
  let previewController: AbortController | undefined, thumbsController: AbortController | undefined
  let ownedUrl = ''
  function releasePreview() {
    previewController?.abort()
    if (ownedUrl) URL.revokeObjectURL(ownedUrl)
    ownedUrl = ''; previewUrl.value = ''; loading.value = false
  }
  async function read(item: ShelfItem, signal: AbortSignal) {
    if (signal.aborted) throw new Error('读取已取消')
    if (item.kind === 'task') {
      const blob = await fetchRuntimeResult(item.source, signal)
      if (signal.aborted) throw new Error('读取已取消')
      return blob
    }
    if (item.imageId) {
      const blob = await artworkRepository.getImage(item.imageId)
      if (signal.aborted) throw new Error('读取已取消')
      if (blob) return blob
    }
    if (!item.source) throw new Error('原图暂不可用，请在作品册核对')
    return fetchResultImage(item.source, signal)
  }
  watch([() => items.value.map(item => `${item.key}:${item.imageId || ''}:${item.source}`).join('|'), active, revision], async ([, enabled], _, onCleanup) => {
    thumbsController?.abort()
    const controller = new AbortController(); thumbsController = controller
    onCleanup(() => controller.abort())
    thumbnails.value = {}
    if (!enabled) return
    for (const item of items.value) {
      if (controller.signal.aborted) return
      try {
        const cached = item.imageId ? await artworkRepository.getThumbnail(item.imageId) : null
        if (controller.signal.aborted) return
        const thumb = cached || (item.kind === 'previous' ? item.source : await blobThumbDataUrl(await read(item, controller.signal)))
        if (!controller.signal.aborted) thumbnails.value = { ...thumbnails.value, [item.key]: thumb }
      } catch { /* A missing thumbnail keeps its labelled placeholder; preview offers retry. */ }
    }
  }, { immediate: true })
  watch([() => selected.value?.key, active, revision, retry], async (_, __, onCleanup) => {
    releasePreview(); error.value = ''
    const item = selected.value
    if (!item || !active.value) { selectedKey.value = ''; return }
    const controller = new AbortController(); previewController = controller
    onCleanup(() => controller.abort())
    loading.value = true
    try {
      const blob = await read(item, controller.signal)
      if (controller.signal.aborted) return
      ownedUrl = URL.createObjectURL(blob); previewUrl.value = ownedUrl
    } catch (cause) {
      if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : '图片读取失败'
    } finally { if (!controller.signal.aborted) loading.value = false }
  }, { immediate: true })
  watch(category, () => { selectedKey.value = '' })
  onDeactivated(() => { active.value = false; thumbsController?.abort(); releasePreview() })
  onActivated(() => { active.value = true })
  onScopeDispose(() => { unsubscribe(); thumbsController?.abort(); releasePreview() })
  return { category, items, selected, selectedKey, thumbnails, previewUrl, loading, error, retry }
}
