import { ref, computed, watch, onBeforeUnmount, type Ref } from 'vue'
import { useVoiceInput, type VoiceTextSource } from '@/composables/useVoiceInput'
import { useManualSpeechHold } from '@/composables/useManualSpeechHold'
import { isSpeechInputReady, normalizeSpeechInputConfig, type SpeechInputConfig } from '@/utils/speechInputConfig'
import { useSpeechInputConfig } from '@/composables/useSpeechInputConfig'
import { createSpeechSession } from '@/utils/speechSession'
import type { CharacterConfig } from '@/config/characters'

interface UseChatSpeechInteractionOptions {
  currentCharacter: Ref<CharacterConfig>
  chatReady: Ref<boolean>
  busy: Ref<boolean>
  inputText: Ref<string>
  handleSend: () => void
}

export function useChatSpeechInteraction({
  currentCharacter,
  chatReady,
  busy,
  inputText,
  handleSend,
}: UseChatSpeechInteractionOptions) {
  const { config: speechConfig, loadError } = useSpeechInputConfig()
  const speechSettingsOpen = ref(Boolean(loadError.value))
  const speechSession = createSpeechSession()
  const speechSessionState = ref(speechSession.state())
  const stopSpeechSessionWatch = speechSession.onChange(() => {
    speechSessionState.value = speechSession.state()
  })
  const speechNotice = ref('')
  const speechInput = useVoiceInput({ config: () => speechConfig.value, onText: onSpeechText })
  const {
    state: speechState,
    errorMessage: speechError,
    supported: speechSupported,
    autoListening: speechAutoListening,
    start: speechStart,
    stop: speechStop,
    release: speechRelease,
  } = speechInput

  function applySpeechSession(): void {
    speechSession.applyConfig(speechConfig.value, currentCharacter.value.name)
  }

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

  const speechSessionActive = computed(() => {
    void speechSessionState.value
    return speechSession.isSessionActive()
  })

  function commitSpeechText(text: string): void {
    inputText.value = inputText.value.trim() ? `${inputText.value.trimEnd()}\n${text}` : text
    if (speechConfig.value.autoSend && chatReady.value && !busy.value) handleSend()
    else speechSession.markReplyIdle()
  }

  function onSpeechText(text: string, source: VoiceTextSource): void {
    if (document.hidden || !document.hasFocus()) return
    if (source === 'manual') { speechNotice.value = '识别文字已填入输入框。'; commitSpeechText(text); return }
    // 自动监听：未进会话时先做唤醒词匹配；未命中不打扰。
    if (source === 'auto' && !speechSession.isSessionActive()) {
      if (speechSession.onWakeText(text)) {
        speechNotice.value = `已唤醒${currentCharacter.value.name}，可以直接对话了`
        return
      }
      return
    }
    const action = speechSession.onSessionText(text)
    if (action === 'end') {
      speechSession.endSession()
      speechNotice.value = '已退出连续对话'
      return
    }
    if (action === 'submit') {
      speechNotice.value = ''
      commitSpeechText(text)
    }
  }

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
    stopSpeechSessionWatch()
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
