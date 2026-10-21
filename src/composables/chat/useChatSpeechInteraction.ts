import { ref, computed, watch, onBeforeUnmount, type Ref } from 'vue'
import { useVoiceInput } from '@/composables/useVoiceInput'
import { useManualSpeechHold } from '@/composables/useManualSpeechHold'
import { isSpeechInputReady, normalizeSpeechInputConfig, type SpeechInputConfig } from '@/utils/speechInputConfig'
import { useSpeechInputConfig } from '@/composables/useSpeechInputConfig'
import { useSpeechConversation, type SubmitSpeechText } from '@/composables/useSpeechConversation'
import type { CharacterConfig } from '@/config/characters'

interface UseChatSpeechInteractionOptions {
  currentCharacter: Ref<CharacterConfig>
  chatReady: Ref<boolean>
  busy: Ref<boolean>
  inputText: Ref<string>
  onInputChange: () => void
  handleSend: SubmitSpeechText
}

export function useChatSpeechInteraction({
  currentCharacter,
  chatReady,
  busy,
  inputText,
  onInputChange,
  handleSend,
}: UseChatSpeechInteractionOptions) {
  const { config: speechConfig, loadError } = useSpeechInputConfig()
  const speechSettingsOpen = ref(Boolean(loadError.value))
  const { speechSession, speechSessionActive, speechNotice, applySpeechSession, onSpeechText } = useSpeechConversation({
    speechConfig, currentCharacterName: () => currentCharacter.value.name,
    inputText, onInputChange, canSend: () => chatReady.value && !busy.value, handleSend,
  })
  const speechInput = useVoiceInput({
    config: () => speechConfig.value,
    onText: (text, source) => {
      if (!document.hidden && document.hasFocus()) onSpeechText(text, source)
    },
  })
  const {
    state: speechState,
    errorMessage: speechError,
    supported: speechSupported,
    autoListening: speechAutoListening,
    start: speechStart,
    stop: speechStop,
    release: speechRelease,
  } = speechInput

  applySpeechSession()

  const speechReady = computed(() => isSpeechInputReady(speechConfig.value) && speechSupported)
  // 已按住录音时保留松开/取消入口；回复期间不允许开始下一次录音。
  const speechButtonDisabled = computed(() => speechState.value === 'recognizing' || busy.value || speechSettingsOpen.value)
  const speechHold = useManualSpeechHold(speechInput, () => speechReady.value && !speechButtonDisabled.value)

  const speechButtonText = computed(() => {
    switch (speechState.value) {
      case 'acquiring':
        return '启动中…'
      case 'capturing':
        return '松开结束'
      case 'recognizing':
        return '识别中…'
      case 'error':
        return '重试'
      default:
        return '按住说话'
    }
  })

  /** 会话状态/配置/忙闲变化时对齐自动监听（唤醒词连续对话）。 */
  function reconcileAutoListen(): void {
    const shouldListen =
      speechReady.value &&
      !document.hidden && document.hasFocus() &&
      speechConfig.value.wakeEnabled &&
      chatReady.value && !speechSettingsOpen.value && !inputText.value.trim() &&
      !busy.value &&
      speechState.value !== 'error' && // 权限被拒后不自动重试，等用户手动
      speechSession.shouldAutoListen()
    if (shouldListen && !speechAutoListening.value) {
      void speechStart('auto')
    } else if (!shouldListen && speechAutoListening.value) {
      speechStop()
    }
  }

  watch(
    busy,
    value => {
      if (value) speechHold.cancel()
      else speechSession.markReplyIdle()
      reconcileAutoListen()
    },
    { immediate: true },
  )

  watch(speechConfig, () => { speechHold.cancel(); applySpeechSession(); reconcileAutoListen() })
  watch([speechState, chatReady, inputText], () => {
    reconcileAutoListen()
  })
  watch(speechSettingsOpen, open => { if (open) speechHold.cancel(); reconcileAutoListen() })

  watch(currentCharacter, () => {
    speechHold.cancel()
    speechNotice.value = ''
    applySpeechSession()
    reconcileAutoListen()
  })

  function onSpeechSettingsSaved(config: SpeechInputConfig): void {
    speechConfig.value = normalizeSpeechInputConfig(config)
    applySpeechSession()
    reconcileAutoListen()
    speechSettingsOpen.value = false
  }

  function onSpeechSessionEnd(): void {
    speechSession.endSession()
    speechNotice.value = '已结束连续对话'
    reconcileAutoListen()
  }

  function onPagePresenceChange(): void {
    if (document.hidden || !document.hasFocus()) {
      // Losing the page cancels pending permissions/ASR as well as capture.
      speechHold.cancel()
    } else reconcileAutoListen()
  }

  onBeforeUnmount(() => {
    window.removeEventListener('focus', onPagePresenceChange)
    window.removeEventListener('blur', onPagePresenceChange)
    document.removeEventListener('visibilitychange', onPagePresenceChange)
    speechHold.cancel()
    speechRelease()
  })
  window.addEventListener('focus', onPagePresenceChange)
  window.addEventListener('blur', onPagePresenceChange)
  document.addEventListener('visibilitychange', onPagePresenceChange)

  return {
    speechConfig,
    speechSettingsOpen,
    speechNotice,
    speechState,
    speechError,
    speechAutoListening,
    speechReady,
    speechButtonDisabled,
    speechButtonText,
    speechSessionActive,
    speechHold,
    onSpeechSettingsSaved,
    onSpeechSessionEnd,
  }
}
