import { computed, onScopeDispose, ref, type Ref } from 'vue'
import type { VoiceTextSource } from '@/composables/useVoiceInput'
import type { SpeechInputConfig } from '@/utils/speechInputConfig'
import { createSpeechSession } from '@/utils/speechSession'

/** Settle admission once, including writer rejection; reply completion remains separate. */
export type SubmitSpeechText = (accepted: (value: boolean) => void) => void

interface SpeechConversationOptions {
  speechConfig: Readonly<Ref<SpeechInputConfig>>
  currentCharacterName: () => string
  inputText: Ref<string>
  onInputChange: () => void
  canSend: () => boolean
  handleSend: SubmitSpeechText
}

/** Shared transcript/session rules; each surface owns microphone admission and release. */
export function useSpeechConversation(options: SpeechConversationOptions) {
  const speechSession = createSpeechSession()
  const state = ref(speechSession.state())
  const speechNotice = ref('')
  let submission = 0
  const stop = speechSession.onChange(() => { state.value = speechSession.state() })
  onScopeDispose(() => { submission++; stop() })

  const speechSessionActive = computed(() => {
    void state.value
    return speechSession.isSessionActive()
  })

  function applySpeechSession() {
    submission++
    speechSession.applyConfig(options.speechConfig.value, options.currentCharacterName())
  }

  function commitSpeechText(text: string) {
    const request = ++submission
    const input = options.inputText
    input.value = input.value.trim() ? `${input.value.trimEnd()}\n${text}` : text
    options.onInputChange()
    if (options.speechConfig.value.autoSend && options.canSend()) options.handleSend(accepted => {
      // A rejected writer never starts a busy→idle cycle. Keep the transcript,
      // but do not wait for a reply that this surface did not submit.
      if (!accepted && request === submission) speechSession.markReplyIdle()
    })
    else speechSession.markReplyIdle()
  }

  function onSpeechText(text: string, source: VoiceTextSource) {
    if (source === 'manual') {
      speechNotice.value = '识别文字已填入输入框。'
      commitSpeechText(text)
      return
    }
    if (source === 'auto' && !speechSession.isSessionActive()) {
      if (speechSession.onWakeText(text))
        speechNotice.value = `已唤醒${options.currentCharacterName()}，可以直接对话了`
      return
    }
    const action = speechSession.onSessionText(text)
    if (action === 'end') {
      speechSession.endSession()
      speechNotice.value = '已退出连续对话'
    } else if (action === 'submit') {
      speechNotice.value = ''
      commitSpeechText(text)
    }
  }

  return { speechSession, speechSessionActive, speechNotice, applySpeechSession, onSpeechText }
}
