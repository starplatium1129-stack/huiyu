import { ref } from 'vue'
import { isSpeechInputReady } from '@/utils/speechInputConfig'
import { registerMaintenanceParticipant } from '@/platform/maintenanceParticipants'
import type { UseVoiceInput, UseVoiceInputOptions, VoiceInputMode, VoiceInputState } from './voiceInputRecorder'
export type { UseVoiceInput, UseVoiceInputOptions, VoiceInputMode, VoiceInputState, VoiceTextSource } from './voiceInputRecorder'

/** Vue owns stable UI state and maintenance admission; the audio implementation
 * loads only when requested. Unlock AudioContext before the asynchronous import. */
export function useVoiceInput(options: UseVoiceInputOptions): UseVoiceInput {
  const state = ref<VoiceInputState>('idle'), errorMessage = ref(''), level = ref(0), autoListening = ref(false)
  const supported = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
  let recorder: ReturnType<typeof import('./voiceInputRecorder').createVoiceInputRecorder> | null = null
  let prepared: AudioContext | null = null, generation = 0, disposed = false
  const releaseMaintenance = registerMaintenanceParticipant(() => {
    if (['acquiring', 'capturing', 'recognizing'].includes(state.value)) throw new Error('SPEECH_BUSY')
  })
  function cancel() {
    generation++
    const previous = prepared; prepared = null
    if (previous && previous.state !== 'closed') void previous.close().catch(() => {})
    recorder?.cancel(); state.value = 'idle'
  }
  async function start(mode: VoiceInputMode = 'manual') {
    if (disposed || ['acquiring', 'capturing', 'recognizing'].includes(state.value)) return
    const token = ++generation
    state.value = 'acquiring'; errorMessage.value = ''
    try {
      if (!supported) throw new Error('当前页面无法使用麦克风，请在桌面客户端或本机浏览器中打开。')
      if (!isSpeechInputReady(options.config())) throw new Error('请先启用语音输入并保存有效的识别服务地址。')
      const context = new AudioContext()
      prepared = context
      const resumed = context.resume()
      void resumed.catch(() => {})
      const audio = await import('./voiceInputRecorder')
      if (disposed || token !== generation) return
      recorder ??= audio.createVoiceInputRecorder(options, { state, errorMessage, level, autoListening }, supported)
      prepared = null
      await recorder.start(mode, { context, resumed })
    } catch (error) {
      if (disposed || token !== generation) return
      cancel()
      const message = error instanceof Error ? error.message : '无法启动语音输入，请重试。'
      state.value = 'error'; errorMessage.value = message
      options.onStateChange?.('error', message); options.onError?.(message)
    }
  }
  function release() { if (disposed) return; disposed = true; cancel(); recorder?.release(); releaseMaintenance() }
  return { state, errorMessage, level, supported, autoListening, start, stop: () => recorder?.stop(), cancel, release }
}
