import { computed, onMounted, onUnmounted, ref, watch, type Ref } from 'vue'
import type { CompanionDesktopBridge } from '@/types/desktop'
import { useVoiceInput, type VoiceTextSource } from '@/composables/useVoiceInput'
import { useManualSpeechHold } from '@/composables/useManualSpeechHold'
import { isSpeechInputReady, normalizeSpeechInputConfig, type SpeechInputConfig } from '@/utils/speechInputConfig'
import { useSpeechInputConfig } from '@/composables/useSpeechInputConfig'
import { createSpeechSession } from '@/utils/speechSession'

export interface CompanionSpeechInputDeps {
  busy: Ref<boolean>
  chatReady: Ref<boolean>
  inputText: Ref<string>
  /** 当前角色（切角色需重套语音会话配置）。 */
  currentCharacter: Ref<unknown>
  currentCharacterName: () => string
  desktopBridge?: CompanionDesktopBridge
  desktopWindowVisible: Ref<boolean>
  /** 勿扰/安静时段 gating（useCompanionBehaviorRuntime）。 */
  dnd: Ref<boolean>
  inQuietHours: Ref<boolean>
  /** 非语音路径的发送（自动发送与会话提交共用）。 */
  handleSend: () => unknown
  isEditableTarget: (target: EventTarget | null) => boolean
}

/**
 * 陪伴页「语音输入」簇（2026-08-22 自 CompanionView 下沉）。
 *
 * 按住说话（共享指针/按键 owner）、唤醒词连续对话会话、
 * auto-listen gating（就绪/勿扰/安静时段/页面可见/会话意愿联合判定）、
 * busy→取消采集、页面不可见→取消采集。useVoiceInput 采集层与
 * speechSession 会话层在此合流；visibilitychange 监听与卸载释放
 * （cancel/release/endSession）由本 composable 自持。
 */
export function useCompanionSpeechInput(deps: CompanionSpeechInputDeps) {
  const { busy, chatReady, inputText, desktopBridge, desktopWindowVisible, dnd, inQuietHours } = deps

  const { config: speechConfig, loadError } = useSpeechInputConfig()
  const speechSettingsOpen = ref(Boolean(loadError.value))
  const speechNotice = ref('')
  const documentHidden = ref(typeof document !== 'undefined' && document.hidden)
  const speechSession = createSpeechSession()
  const speechSessionState = ref(speechSession.state())
  const stopSpeechSessionWatch = speechSession.onChange(() => { speechSessionState.value = speechSession.state() })

  const speechInput = useVoiceInput({ config: () => speechConfig.value, onText: onSpeechText })
  const {
    state: speechState,
    level: speechLevel,
    errorMessage: speechError,
    supported: speechSupported,
    autoListening: speechAutoListening,
    start: speechStart,
    stop: speechStop,
    release: speechRelease,
  } = speechInput

  const speechReady = computed(() => isSpeechInputReady(speechConfig.value) && speechSupported)
  const speechBusy = computed(() => ['acquiring', 'capturing', 'recognizing'].includes(speechState.value))
  const speechSessionActive = computed(() => {
    void speechSessionState.value
    return speechSession.isSessionActive()
  })
  const pageVisible = computed(() => !documentHidden.value && desktopWindowVisible.value)
  const speechButtonDisabled = computed(() => !speechReady.value || busy.value || !pageVisible.value || speechSettingsOpen.value
    || speechState.value === 'recognizing')
  const speechHold = useManualSpeechHold(speechInput, () => !speechButtonDisabled.value)
  const speechButtonText = computed(() => {
    if (speechState.value === 'acquiring') return '启动中…'
    if (speechState.value === 'capturing') return '松开结束'
    if (speechState.value === 'recognizing') return '识别中…'
    if (speechState.value === 'error') return '重试'
    return '按住说话'
  })
  const speechStateText = computed(() => {
    if (speechState.value === 'capturing') return '聆听中…'
    if (speechState.value === 'recognizing') return '正在识别…'
    if (speechState.value === 'error') return speechError.value
    return speechNotice.value
  })

  function applySpeechSession() {
    speechSession.applyConfig(speechConfig.value, deps.currentCharacterName())
  }

  function commitSpeechText(text: string) {
    inputText.value = inputText.value.trim() ? `${inputText.value.trimEnd()}\n${text}` : text
    if (speechConfig.value.autoSend && chatReady.value && !busy.value) void deps.handleSend()
    else speechSession.markReplyIdle()
  }

  function onSpeechText(text: string, source: VoiceTextSource) {
    if (source === 'manual') { speechNotice.value = '识别文字已填入输入框。'; commitSpeechText(text); return }
    if (source === 'auto' && !speechSession.isSessionActive()) {
      if (speechSession.onWakeText(text)) speechNotice.value = `已唤醒${deps.currentCharacterName()}，可以直接对话了`
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

  function reconcileAutoListen() {
    // 真双窗口：麦克风采集随聊天走聊天窗，角色窗不再 auto-listen
    if (desktopBridge) return
    const shouldListen = speechReady.value
      && speechConfig.value.wakeEnabled
      && chatReady.value
      && !busy.value
      && !dnd.value
      && !inQuietHours.value
      && pageVisible.value
      && !speechSettingsOpen.value && !inputText.value.trim()
      && speechState.value !== 'error'
      && speechSession.shouldAutoListen()
    if (shouldListen && !speechAutoListening.value && !speechBusy.value) {
      void speechStart('auto')
    } else if (!shouldListen && speechAutoListening.value) {
      speechStop()
    }
  }

  /** 非语音路径强制取消（窗口隐藏/busy 翻转等外部事件）。 */
  function cancelSpeechActivity() {
    speechHold.cancel()
  }

  /** Space 按下（非桌面双窗口路径）：修饰键/可编辑目标/按钮禁用时忽略。 */
  function handleSpaceKeyDown(event: KeyboardEvent) {
    if (event.key !== ' ') return
    if (deps.isEditableTarget(event.target)) return
    speechHold.keyDown(event)
  }

  function handleSpaceKeyUp(event: KeyboardEvent) {
    speechHold.keyUp(event)
  }

  function onSpeechSettingsSaved(config: SpeechInputConfig) {
    speechConfig.value = normalizeSpeechInputConfig(config)
    applySpeechSession()
    reconcileAutoListen()
    speechSettingsOpen.value = false
  }

  function onSpeechSessionEnd() {
    speechSession.endSession()
    speechNotice.value = '已结束连续对话'
    reconcileAutoListen()
  }

  function onDocumentVisibilityChange() {
    documentHidden.value = document.hidden
    if (!pageVisible.value) cancelSpeechActivity()
    reconcileAutoListen()
  }

  applySpeechSession()

  watch(busy, value => {
    if (value) {
      cancelSpeechActivity()
    } else {
      speechSession.markReplyIdle()
    }
    reconcileAutoListen()
  }, { immediate: true })

  watch(speechConfig, () => { cancelSpeechActivity(); applySpeechSession(); reconcileAutoListen() })
  watch([speechState, dnd, inQuietHours, desktopWindowVisible, documentHidden, chatReady, inputText], reconcileAutoListen)
  watch(speechSettingsOpen, open => { if (open) cancelSpeechActivity(); else reconcileAutoListen() })

  watch(deps.currentCharacter, () => {
    cancelSpeechActivity()
    speechNotice.value = ''
    applySpeechSession()
    reconcileAutoListen()
  })

  onMounted(() => {
    document.addEventListener('visibilitychange', onDocumentVisibilityChange)
  })

  onUnmounted(() => {
    stopSpeechSessionWatch()
    cancelSpeechActivity()
    speechRelease()
    speechSession.endSession()
    document.removeEventListener('visibilitychange', onDocumentVisibilityChange)
  })

  return {
    speechReady,
    speechState,
    speechLevel,
    speechError,
    speechAutoListening,
    speechSessionActive,
    speechButtonDisabled,
    speechButtonText,
    speechStateText,
    speechSettingsOpen,
    pageVisible,
    speechHold,
    onSpeechSessionEnd,
    onSpeechSettingsSaved,
    handleSpaceKeyDown,
    handleSpaceKeyUp,
    cancelSpeechActivity,
    reconcileAutoListen,
  }
}
