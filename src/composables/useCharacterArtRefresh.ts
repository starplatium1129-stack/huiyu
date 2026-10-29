import { onMounted, onUnmounted, watch } from 'vue'
import { characterArtApi, CHARACTER_ART_CHANNEL, CHARACTER_ART_SENDER } from '@/api/characterArtApi'
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
    if (isLocalStudioHost() && typeof BroadcastChannel !== 'undefined') {
      try {
        channel = new BroadcastChannel(CHARACTER_ART_CHANNEL)
        channel.onmessage = ({ data }) => {
          if (data?.identity === runtimeResourceIdentity() && data?.sender !== CHARACTER_ART_SENDER) void refresh()
        }
      } catch { /* Builtin art remains available if this origin disallows channels. */ }
    }
  })
  onUnmounted(() => { controller?.abort(); channel?.close() })
}
