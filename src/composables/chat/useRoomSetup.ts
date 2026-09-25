import { computed, ref, type ComputedRef, type Ref } from 'vue'
import { controlApi } from '@/api/controlApi'
import { usePolling } from '@/composables/usePolling'
import type { useVoice } from '@/composables/useVoice'
import type { CharacterConfig } from '@/config/characters'

export interface UseRoomSetupOptions {
  chatProvider: Ref<string>
  apiConfigured: Ref<boolean>
  ollamaOnline: Ref<boolean>
  autoVoice: Ref<boolean>
  currentCharacter: ComputedRef<CharacterConfig>
  voice: ReturnType<typeof useVoice>
  refreshChatStatus: () => Promise<void>
  updateVoiceCapability: () => void
  setError: (message: string, kind?: string, timeout?: number) => void
  isDisposed: () => boolean
}

/** Owns background room preparation, mode switching, and voice readiness verification. */
export function useRoomSetup(options: UseRoomSetupOptions) {
  const {
    chatProvider,
    apiConfigured,
    ollamaOnline,
    autoVoice,
    currentCharacter,
    voice,
    refreshChatStatus,
    updateVoiceCapability,
    setError,
    isDisposed,
  } = options

  const preparingRoom = ref(false)
  const roomSetupText = ref('一键切到聊天优先：释放受管绘图显存，并启动角色语音服务。')

  const setupTitle = computed(() => {
    if (preparingRoom.value) return '正在准备角色房间'
    if (chatProvider.value === 'api' && !apiConfigured.value) return '还没有配置自定义 API'
    if (chatProvider.value === 'local' && !ollamaOnline.value) return '本地聊天模型还没有就绪'
    return '角色语音还没有就绪'
  })

  const setupDescription = computed(() => {
    if (preparingRoom.value) return roomSetupText.value
    if (chatProvider.value === 'api' && !apiConfigured.value) {
      return '填写兼容 OpenAI 格式的地址、模型名和密钥后即可对话。'
    }
    if (chatProvider.value === 'api') return 'API 对话已经可用；准备本地语音后可以继续使用逐句配音。'
    return roomSetupText.value
  })

  async function refreshVoiceStatus() {
    await voice.refreshAvailability()
    if (isDisposed()) return
    updateVoiceCapability()
    const voiceId = currentCharacter.value.voice
    if (voice.readyFor(voiceId)) voice.prepare(voiceId, true)
  }

  async function refreshRoomState() {
    if (autoVoice.value) voice.ensureAudioContext()
    await Promise.all([refreshChatStatus(), refreshVoiceStatus()])
  }

  let roomPollOperationId = ''
  let roomPollRequest: AbortController | null = null
  let roomActionRequest: AbortController | null = null

  const roomPoll = usePolling({
    intervalMs: 1800,
    tick: async () => {
      const controller = new AbortController()
      roomPollRequest = controller
      try {
        const data = await controlApi.getStatus({ signal: controller.signal })
        if (roomPollRequest !== controller) return false
        const operation = data.operation
        if (!operation || operation.id !== roomPollOperationId) return false
        roomSetupText.value = operation.message || '正在准备本地服务…'
        if (operation.status === 'running') return // void = 继续，完成本次后由底座排下一次
        preparingRoom.value = false
        if (operation.status === 'failed') {
          setError(operation.error || '聊天环境准备失败，请到控制面板查看。')
          roomSetupText.value = '准备失败；可以到控制面板查看服务状态。'
          return false
        }
        await Promise.all([refreshChatStatus(), refreshVoiceStatus()])
        roomSetupText.value = '聊天环境已就绪。'
        return false
      } catch {
        if (controller.signal.aborted) return false
        roomSetupText.value = '仍在后台准备；状态暂时无法读取。'
        return // 瞬时网络抖动：完成本次查询后再安排下一次
      } finally {
        if (roomPollRequest === controller) roomPollRequest = null
      }
    },
  })

  function stopRoomPolling() {
    roomPoll.stop()
    roomPollRequest?.abort()
    roomPollRequest = null
  }

  async function prepareRoom() {
    if (preparingRoom.value) return
    preparingRoom.value = true
    setError('')
    roomSetupText.value = '正在提交聊天优先切换…'
    roomActionRequest?.abort()
    const controller = new AbortController()
    roomActionRequest = controller
    try {
      const data = await controlApi.switchMode('chat', { signal: controller.signal })
      if (roomActionRequest !== controller || controller.signal.aborted) return
      const operationId = String(data.operation?.id || '')
      roomSetupText.value = data.message || '正在准备聊天环境…'
      if (!operationId) {
        preparingRoom.value = false
        await Promise.all([refreshChatStatus(), refreshVoiceStatus()])
        return
      }
      roomPollRequest?.abort()
      roomPollRequest = null
      roomPoll.stop()
      roomPollOperationId = operationId
      roomPoll.start()
    } catch (error) {
      if (controller.signal.aborted) return
      preparingRoom.value = false
      roomSetupText.value = '准备失败；可以到控制面板手动处理。'
      setError(error instanceof Error && error.message ? error.message : '聊天环境准备失败')
    } finally {
      if (roomActionRequest === controller) roomActionRequest = null
    }
  }

  function destroy() {
    stopRoomPolling()
    roomActionRequest?.abort()
    roomPollRequest = null
    roomActionRequest = null
  }

  return {
    preparingRoom,
    roomSetupText,
    setupTitle,
    setupDescription,
    refreshVoiceStatus,
    refreshRoomState,
    prepareRoom,
    stopRoomPolling,
    destroy,
  }
}
