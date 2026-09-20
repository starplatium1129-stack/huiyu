import { ref, computed, watch, onBeforeUnmount, type Ref } from 'vue'
import { useVoiceInput, type VoiceTextSource } from '@/composables/useVoiceInput'
import { isSpeechInputReady, loadSpeechInputConfig } from '@/utils/speechInputConfig'
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
  const speechConfig = ref(loadSpeechInputConfig())
  const speechSettingsOpen = ref(false)
  const speechSession = createSpeechSession()
  const speechSessionState = ref(speechSession.state())
  const stopSpeechSessionWatch = speechSession.onChange(() => {
    speechSessionState.value = speechSession.state()
  })
  const speechNotice = ref('')

  const {
    state: speechState,
    errorMessage: speechError,
    supported: speechSupported,
    autoListening: speechAutoListening,
    start: speechStart,
    stop: speechStop,
    cancel: speechCancel,
    release: speechRelease,
  } = useVoiceInput({
    config: () => speechConfig.value,
    onText: onSpeechText,
  })

  function applySpeechSession(): void {
    speechSession.applyConfig(speechConfig.value, currentCharacter.value.name)
  }

  applySpeechSession()

  const speechReady = computed(() => isSpeechInputReady(speechConfig.value) && speechSupported)
  const speechBusy = computed(
    () =>
      speechState.value === 'capturing' ||
      speechState.value === 'acquiring' ||
      speechState.value === 'recognizing',
  )

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

  const speechStateText = computed(() => {
    switch (speechState.value) {
      case 'capturing':
        return '聆听中…'
      case 'recognizing':
        return '正在识别…'
      case 'error':
        return speechError.value
      default:
        return ''
    }
  })

  const speechSessionActive = computed(() => {
    void speechSessionState.value
    return speechSession.isSessionActive()
  })

  function commitSpeechText(text: string): void {
    inputText.value = text
    if (speechConfig.value.autoSend && chatReady.value && !busy.value) handleSend()
  }

  function onSpeechText(text: string, source: VoiceTextSource): void {
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
      if (value) {
        speechSession.markReplyBusy()
      } else {
        speechSession.markReplyIdle()
      }
      reconcileAutoListen()
    },
    { immediate: true },
  )

  watch([speechState, speechConfig], () => {
    reconcileAutoListen()
  })

  watch(currentCharacter, () => {
    manualSpeechHeld = false
    speechCancel()
    speechNotice.value = ''
    applySpeechSession()
    reconcileAutoListen()
  })

  let manualSpeechHeld = false
  function onSpeechPress(): void {
    if (speechBusy.value) return
    manualSpeechHeld = true
    void speechStart('manual')
  }

  function onSpeechKeyPress(event: KeyboardEvent): void {
    if (!event.repeat) onSpeechPress()
  }

  function onSpeechRelease(): void {
    if (!manualSpeechHeld) return
    manualSpeechHeld = false
    if (speechState.value === 'acquiring') speechCancel()
    else speechStop()
  }

  function onSpeechCancel(): void {
    if (!manualSpeechHeld) return
    manualSpeechHeld = false
    speechCancel()
  }

  function onSpeechLeave(event: PointerEvent): void {
    if (event.buttons > 0) onSpeechCancel()
  }

  function onSpeechSettingsSaved(): void {
    speechConfig.value = loadSpeechInputConfig()
    applySpeechSession()
    reconcileAutoListen()
    speechSettingsOpen.value = false
  }

  function onSpeechSessionEnd(): void {
    speechSession.endSession()
    speechNotice.value = '已结束连续对话'
    reconcileAutoListen()
  }

  onBeforeUnmount(() => {
    window.removeEventListener('focus', reconcileAutoListen)
    window.removeEventListener('blur', reconcileAutoListen)
    document.removeEventListener('visibilitychange', reconcileAutoListen)
    stopSpeechSessionWatch()
    speechRelease()
  })
  window.addEventListener('focus', reconcileAutoListen)
  window.addEventListener('blur', reconcileAutoListen)
  document.addEventListener('visibilitychange', reconcileAutoListen)

  return {
    speechConfig,
    speechSettingsOpen,
    speechNotice,
    speechState,
    speechError,
    speechAutoListening,
    speechReady,
    speechButtonText,
    speechStateText,
    speechSessionActive,
    onSpeechPress,
    onSpeechKeyPress,
    onSpeechRelease,
    onSpeechCancel,
    onSpeechLeave,
    onSpeechSettingsSaved,
    onSpeechSessionEnd,
  }
}
