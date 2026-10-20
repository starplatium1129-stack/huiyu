import { onMounted, onUnmounted, ref } from 'vue'
import { settingsRepository } from '@/storage/settingsRepository'
import { LOCAL_SETUP_DRAFT_SETTING } from '@/utils/localSetupDraft'

export function useLocalSetupPanelLoading() {
  const hasOperation = () => !!settingsRepository.get(LOCAL_SETUP_DRAFT_SETTING)?.operation
  const localSetupRequested = ref(hasOperation())
  function checkRecovery() {
    if (hasOperation()) localSetupRequested.value = true
  }
  function onStorage(event: StorageEvent) {
    if (event.key === null || event.key === LOCAL_SETUP_DRAFT_SETTING.key) checkRecovery()
  }
  function onLocalSetupToggle(event: Event) {
    // Native toggle covers pointer, keyboard and navigation's programmatic open.
    // Never unmount on close: the panel owns downloads and operation recovery.
    if ((event.currentTarget as HTMLDetailsElement).open) localSetupRequested.value = true
  }
  onMounted(() => {
    window.addEventListener('huiyu:setup-operation', checkRecovery)
    window.addEventListener('huiyu:profile-sync-complete', checkRecovery)
    window.addEventListener('storage', onStorage)
    // Catch hydration or a late operation receipt between setup and mounting.
    checkRecovery()
  })
  onUnmounted(() => {
    window.removeEventListener('huiyu:setup-operation', checkRecovery)
    window.removeEventListener('huiyu:profile-sync-complete', checkRecovery)
    window.removeEventListener('storage', onStorage)
  })
  return { localSetupRequested, onLocalSetupToggle }
}
