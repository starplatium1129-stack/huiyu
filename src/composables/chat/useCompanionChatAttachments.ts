import { computed, onUnmounted, ref, watch, type Ref } from 'vue'
import type { CompanionDesktopBridge } from '@/types/desktop'
import { useCompanionClipboardImport } from '@/composables/useCompanionClipboardImport'
import { relayChatTurn } from '@/utils/chatRelayReceipt'
import { COMPANION_IMAGE_IMPORT_KEY } from '@/utils/storageKeys'

export function useCompanionChatAttachments(options: {
  bridge?: CompanionDesktopBridge; activeChar: Ref<string>; inputText: Ref<string>; busy: Ref<boolean>; chatReady: Ref<boolean>
  visible: Ref<boolean>; characterName: () => string; persistDraft: (text: string) => void
  notice: (message: string) => void; error: (message: string) => void
}) {
  const imagePending = ref(false)
  let relayController: AbortController | null = null
  const media = useCompanionClipboardImport({
    activeChar: options.activeChar, desktopBridge: options.bridge, inputText: options.inputText,
    busy: options.busy, chatReady: options.chatReady, currentCharacterName: options.characterName,
    isActive: () => options.visible.value, persistDraft: options.persistDraft, scrollChatToBottom: () => {},
    noteReturn: pick => options.notice(pick(0)), noteReturnPlain: options.notice, onError: options.error,
    resetEventDetector: () => {
      try { window.localStorage.setItem(COMPANION_IMAGE_IMPORT_KEY, crypto.randomUUID()) }
      catch { options.notice('图片已入册，桌宠提醒同步尚未完成。') }
    },
    handleSend: async (text, imageUrl) => {
      if (!options.bridge || !options.chatReady.value || options.busy.value) throw new Error('请先连接支持图片的聊天模型。')
      const controller = new AbortController(); relayController?.abort(); relayController = controller; imagePending.value = true
      try { await relayChatTurn(options.bridge, text || '请看看这张图片。', options.activeChar.value, imageUrl, controller.signal) }
      finally { if (relayController === controller) { relayController = null; imagePending.value = false } }
    },
  })
  const sendingImage = computed(() => imagePending.value || media.capturingScreen.value || Boolean(media.clipboardCard.value?.saving))
  function cancelAttachments() { relayController?.abort(); relayController = null; imagePending.value = false; media.cancelCapture() }
  watch(options.visible, visible => { if (!visible) { cancelAttachments(); media.dismissClipboardCard() } })
  watch(options.activeChar, cancelAttachments, { flush: 'sync' })
  onUnmounted(cancelAttachments)
  return { ...media, sendingImage, cancelAttachments }
}
