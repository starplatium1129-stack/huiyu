import { onActivated, onBeforeUnmount, onDeactivated, ref, watch } from 'vue'
import type { usePromptBuilderStore } from '@/stores/promptBuilderStore'
import type { RouteLocationNormalizedLoaded } from 'vue-router'
import { AUTO_SAVE_TO_GALLERY_SETTING, settingsRepository } from '@/storage/settingsRepository'
import type { VoiceStudioHandle } from './usePromptMaterials'

/** Ephemeral view handles, panel visibility and presentation timers; no generation state. */
export function usePromptWorkspaceUi(pb: ReturnType<typeof usePromptBuilderStore>, route: RouteLocationNormalizedLoaded) {
  const inspector = ref<InstanceType<typeof import('@/components/director/DirectorInspector.vue')['default']> | null>(null)
  const materialDrawer = ref<InstanceType<typeof import('@/components/director/DirectorMaterialDrawer.vue')['default']> | null>(null)
  const voiceStudioRef = ref<VoiceStudioHandle | null>(null)
  const batchOpen = ref(false)
  const batchRunning = ref(false)
  const autoSaveToGallery = ref(settingsRepository.get(AUTO_SAVE_TO_GALLERY_SETTING) ?? false)
  watch(autoSaveToGallery, value => settingsRepository.set(AUTO_SAVE_TO_GALLERY_SETTING, value))
  onDeactivated(() => { batchOpen.value = false })
  onActivated(() => {
    if (route.query.taskCenter === 'batch') batchOpen.value = true
  })

  const characterShifting = ref(false)
  let active = true
  let characterShiftTimer: ReturnType<typeof setTimeout> | null = null
  function stopCharacterShift() {
    if (characterShiftTimer) clearTimeout(characterShiftTimer)
    characterShiftTimer = null
    characterShifting.value = false
  }
  onActivated(() => { active = true })
  onDeactivated(() => { active = false; stopCharacterShift() })
  watch(() => pb.subject.kind === 'popular' ? pb.subject.characterId : pb.char, () => {
    if (!active) return
    characterShifting.value = true
    if (characterShiftTimer) clearTimeout(characterShiftTimer)
    characterShiftTimer = setTimeout(() => { characterShifting.value = false }, 760)
  })
  onBeforeUnmount(stopCharacterShift)

  return { inspector, materialDrawer, voiceStudioRef, batchOpen, batchRunning, autoSaveToGallery, characterShifting }
}
