import { onActivated, onDeactivated, ref, watch } from 'vue'
import { useRouter, type RouteLocationNormalizedLoaded } from 'vue-router'
import { AUTO_SAVE_TO_GALLERY_SETTING, settingsRepository } from '@/storage/settingsRepository'
import type { VoiceStudioHandle } from './usePromptMaterials'

/** Ephemeral view handles and panel visibility; no generation state. */
export function usePromptWorkspaceUi(route: RouteLocationNormalizedLoaded) {
  const router = useRouter()
  const inspector = ref<InstanceType<typeof import('@/components/director/DirectorInspector.vue')['default']> | null>(null)
  const materialDrawer = ref<InstanceType<typeof import('@/components/director/DirectorMaterialDrawer.vue')['default']> | null>(null)
  const voiceStudioRef = ref<VoiceStudioHandle | null>(null)
  const batchOpen = ref(false)
  const batchRunning = ref(false)
  const active = ref(true)
  const autoSaveToGallery = ref(settingsRepository.get(AUTO_SAVE_TO_GALLERY_SETTING) ?? false)
  watch(autoSaveToGallery, value => settingsRepository.set(AUTO_SAVE_TO_GALLERY_SETTING, value))
  onDeactivated(() => { active.value = false; batchOpen.value = false })
  onActivated(() => { active.value = true })
  watch([() => route.query.taskCenter, inspector, active], async ([intent, panel, attached], _previous, cleanup) => {
    if (intent !== 'batch' || !panel || !attached) return
    let current = true
    cleanup(() => { current = false })
    // Mount the deferred task tools before opening their modal.
    await panel.selectSection('delivery')
    if (!current) return
    batchOpen.value = true
    await router.replace({ path: route.path, query: { ...route.query, taskCenter: undefined }, hash: route.hash })
  }, { immediate: true, flush: 'post' })

  return { inspector, materialDrawer, voiceStudioRef, batchOpen, batchRunning, autoSaveToGallery }
}
