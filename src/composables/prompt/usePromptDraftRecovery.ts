import { watch } from 'vue'
import type { usePromptBuilderStore } from '@/stores/promptBuilderStore'

/** Shared by cold workspace setup and URL resume; KeepAlive retains this owner. */
export function usePromptDraftRecovery(pb: ReturnType<typeof usePromptBuilderStore>) {
  const recovery = {
    initialized: false,
    textRevision: 0,
    restoredRevision: null as number | null,
    restoreDraft,
  }

  // Catalog/profile/backend defaults do not write these two editable text fields.
  // A revision also preserves edits that return to their original text.
  watch([() => pb.story, () => pb.visualDescription], () => {
    if (!recovery.initialized) recovery.textRevision++
  }, { flush: 'sync' })

  async function restoreDraft(isCurrent = () => true): Promise<boolean> {
    const restored = await pb.restoreDraft(() => isCurrent()
      && (recovery.initialized || recovery.textRevision === 0))
    if (restored && !recovery.initialized) {
      // The synchronous restore itself changes text; only its successful result
      // adopts that revision. Later edits must still block old recipe recovery.
      recovery.restoredRevision = recovery.textRevision
    }
    return restored
  }

  return recovery
}
