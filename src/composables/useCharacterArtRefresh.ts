import { onMounted, onUnmounted, watch } from 'vue'
import { characterArtApi, CHARACTER_ART_CHANNEL } from '@/api/characterArtApi'
import { clearCharacterArtManifest } from '@/platform/characterArtState'
import { runtimeResourceIdentity } from '@/platform/runtimeUrl'
import { isLocalStudioHost } from '@/utils/runtimeEnvironment'

export function useCharacterArtRefresh() {
  let controller: AbortController | null = null
  let channel: BroadcastChannel | null = null
  async function refresh() {
    controller?.abort()
    if (!isLocalStudioHost()) { clearCharacterArtManifest(); return }
    const current = new AbortController(); controller = current
    try { await characterArtApi.get({ signal: current.signal }) }
    catch { /* Optional overrides leave the builtin catalog available while disconnected. */ }
  }
  watch(runtimeResourceIdentity, () => { clearCharacterArtManifest(); void refresh() })
  onMounted(() => {
    void refresh()
    window.addEventListener('focus', refresh)
    if (isLocalStudioHost() && typeof BroadcastChannel !== 'undefined') {
      try {
        channel = new BroadcastChannel(CHARACTER_ART_CHANNEL)
        channel.onmessage = () => { void refresh() }
      } catch { /* Window focus still refreshes overrides if this origin disallows channels. */ }
    }
  })
  onUnmounted(() => { controller?.abort(); window.removeEventListener('focus', refresh); channel?.close() })
}
