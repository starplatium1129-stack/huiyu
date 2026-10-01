import { computed, onActivated, ref } from 'vue'
import { useEventListener } from '@vueuse/core'
import { galleryFilterPreferences, type GalleryFilterPreset } from '@/storage/galleryFilterPreferences'
import { GALLERY_FILTER_PRESETS_KEY } from '@/utils/storageKeys'
import type { GalleryFilterSnapshot } from './galleryGenerationConditions'

export function useGallerySavedFilters(options: {
  snapshot: () => GalleryFilterSnapshot
  apply: (filters: GalleryFilterSnapshot) => void
  preferences?: typeof galleryFilterPreferences
}) {
  const preferences = options.preferences || galleryFilterPreferences
  const presets = ref<GalleryFilterPreset[]>([]), busy = ref(false), error = ref(''), message = ref('')
  function reload() {
    try { presets.value = preferences.read(); error.value = '' }
    catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
  }
  reload()
  onActivated(reload)
  if (typeof window !== 'undefined') useEventListener(window, 'storage', event => { if (event.key === GALLERY_FILTER_PRESETS_KEY || event.key === null) reload() })
  const matchedPresetId = computed(() => presets.value.find(preset => JSON.stringify(preset.filters) === JSON.stringify(options.snapshot()))?.id || '')
  function applyPreset(id: string) {
    const preset = presets.value.find(value => value.id === id)
    if (preset) { options.apply(preset.filters); message.value = `已沿用组合：${preset.name}` }
  }
  async function mutate(action: () => Promise<GalleryFilterPreset[]>, success: string) {
    if (busy.value) return false
    busy.value = true; error.value = ''; message.value = ''
    try { presets.value = await action(); message.value = success; return true }
    catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); return false }
    finally { busy.value = false }
  }
  const savePreset = (name: string) => {
    const snapshot = options.snapshot()
    return mutate(() => preferences.save(name, snapshot), '筛选组合已保存，同名组合会更新为当前条件。')
  }
  const removePreset = (id: string) => mutate(() => preferences.remove(id), '筛选组合已移除。')
  return { presets, matchedPresetId, busy, error, message, savePreset, applyPreset, removePreset }
}
